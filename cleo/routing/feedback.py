"""Local, reversible outcome evidence; never changes benchmark scores or permissions."""
import hashlib
import json
import re
from pathlib import Path

from cleo.memory.repository import file_lock
from cleo.routing.catalog import atomic_json
from cleo.routing.models import FeedbackUpdate, utcnow


def project_key(path) -> str:
    """Purpose: Keep experience within its workspace. Input: cwd. Output: opaque key."""
    return hashlib.sha256(str(Path(path).resolve()).casefold().encode()).hexdigest()


class FeedbackStore:
    def __init__(self, state: Path):
        """Purpose: Bind the routing-owned evidence directory. Output: lazy local storage."""
        self.root = Path(state) / "feedback"

    def read(self, task_id):
        """Purpose: Load one episode, not one sample per correction message. Output: evidence."""
        if not isinstance(task_id, str) or not re.fullmatch(r"task_[a-f0-9]{32}", task_id):
            raise ValueError("Invalid task ID")
        try:
            return json.loads((self.root / f"{task_id}.json").read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None

    def submit(self, record, update, *, source="user"):
        """Purpose: Record attributed user/check outcomes atomically, without prompt text.

        Input: Host-loaded task and validated feedback. Output: one revision per episode.
        """
        update = FeedbackUpdate.model_validate(update)
        if update.task_id != record["task_id"] or record["status"] == "running":
            raise ValueError("Feedback requires the matching finished task")
        self.root.mkdir(parents=True, exist_ok=True)
        with file_lock(self.root / ".write.lock"):
            previous = self.read(update.task_id) or {}
            revision = previous.get("revision", 0)
            if update.revision is not None and update.revision != revision:
                raise ValueError("反馈已变化，请重新加载。")
            if (previous and source != "user" and previous.get("source") == "user"):
                return previous
            payload = {
                "task_id": update.task_id, "parent_session_id": record["parent_session_id"],
                "candidate_id": record.get("final_candidate_id"),
                "scope": record.get("candidate_scope"), "project": record.get("project_key"),
                "task_type": record["assessment"]["task_type"], "source": source,
                "outcome": update.outcome, "attribution": update.attribution,
                "revision": revision + 1, "updated_at": utcnow().isoformat(),
            }
            atomic_json(self.root / f"{update.task_id}.json", payload)
            return payload

    def summary(self, candidate, task_type, project, policy):
        """Purpose: Produce bounded local preference evidence. Output: counts and adjustment.

        Only independent, attributed user/check episodes affect ranking; unknown stays unknown.
        """
        passed = failed = pending = 0
        for path in self.root.glob("task_*.json"):
            try:
                item = json.loads(path.read_text(encoding="utf-8"))
                if (item.get("candidate_id") != candidate.id
                        or item.get("scope") != candidate.availability_scope
                        or item.get("task_type") != task_type or item.get("project") != project):
                    continue
                eligible = (item.get("source") in {"user", "check"}
                            and item.get("attribution") in {"executor", "selection"})
                passed += int(eligible and item.get("outcome") == "passed")
                failed += int(eligible and item.get("outcome") == "failed")
                pending += int(item.get("outcome") == "unknown")
            except (OSError, ValueError, TypeError, AttributeError):
                continue
        samples = passed + failed
        active = policy.feedback_enabled and samples >= policy.feedback_min_samples
        # An engineering preference adjustment, not a calibrated success probability.
        adjustment = (policy.feedback_weight_cap * (passed - failed) / (samples + 5)
                      if active else 0.0)
        return {"passed": passed, "failed": failed, "pending_review": pending,
                "samples": samples, "active": active, "adjustment": adjustment,
                "meaning": "bounded_local_preference_not_success_probability"}

    def revision(self):
        """Purpose: Bind decisions to feedback changes. Output: deterministic metadata digest."""
        digest = hashlib.sha256()
        for path in sorted(self.root.glob("task_*.json")):
            digest.update(path.name.encode())
            digest.update(path.read_bytes())
        return digest.hexdigest()
