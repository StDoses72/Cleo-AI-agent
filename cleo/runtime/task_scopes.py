"""Accounting scopes are independent of a model's semantic boundary decision."""

import hashlib
import re
from dataclasses import dataclass
from datetime import datetime

LEGACY_TASK = "session_history"


def task_abstract(text):
    """Purpose: Bound/redact a goal label. Input: brief text. Output: safe single-line label."""
    from cleo.memory.compaction import _redact_text

    return re.sub(r"\s+", " ", _redact_text(text)).strip()[:80]


def user_request_text(event):
    """Purpose: Read user text without image/file payloads. Input: event. Output: text or None."""
    text = (event.get("data") or {}).get("display_prompt") or event.get("content")
    if isinstance(text, str):
        return text
    if isinstance(text, list):
        parts = [part.get("text") for part in text if isinstance(part, dict)
                 and part.get("type") == "text" and isinstance(part.get("text"), str)]
        return "\n".join(parts) or None
    return None


def _instant(value):
    """Purpose: Compare recorded start times safely. Input: ISO time. Output: aware time/None."""
    try:
        result = datetime.fromisoformat(value)
        return result if result.tzinfo is not None else None
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class LegacyScope:
    """A recorded tracking interval, never an inferred historical task boundary."""

    task_id: str
    start: datetime | None
    end: datetime | None

    def resolve(self, binding, started_at):
        """Purpose: Recover old legacy-bound children. Input: binding/start. Output: safe scope.

        Work begun before tracking remains historical even when its result arrives late.
        Missing timestamps never establish membership in the newly tracked task.
        """
        instant = _instant(started_at)
        if (binding == LEGACY_TASK and instant is not None and self.start is not None
                and instant >= self.start and (self.end is None or instant < self.end)):
            return self.task_id
        return binding


def normalize_boundaries(session_id, events):
    """Purpose: Separate recorded work from lifetime history without changing stored facts.

    Input: Host session ID and full append-only events. Output: copied boundary events and
    an optional legacy-child resolver. Old failed markers establish a measurement start,
    not a confirmed semantic goal. Stable IDs survive reload; no model or data writes occur.
    """
    first = next((index for index, event in enumerate(events)
                  if event.get("type") == "task_boundary"
                  and event["data"]["task_id"] == LEGACY_TASK), None)
    legacy = None
    abstract = None
    if first is not None:
        marker = events[first]
        identity = f"{session_id}:{marker.get('id') or marker.get('seq') or first}"
        task_id = "work_" + hashlib.sha256(identity.encode()).hexdigest()[:32]
        end = next((event.get("created_at") for event in events[first + 1:]
                    if event.get("type") == "task_boundary"
                    and event["data"]["task_id"] not in {LEGACY_TASK, task_id}), None)
        legacy = LegacyScope(task_id, _instant(marker.get("created_at")), _instant(end))
        for event in events[first + 1:]:
            if event.get("type") != "user_message":
                continue
            text = user_request_text(event)
            if text is not None:
                abstract = task_abstract(text)
            break
    numbers = {}
    result = []
    for event in events:
        if event.get("type") != "task_boundary":
            result.append(event)
            continue
        data = dict(event["data"])
        if data["task_id"] == LEGACY_TASK:
            data.update(task_id=legacy.task_id, coverage="since_tracking",
                        start_reason="tracking_started")
            if not data.get("abstract") and abstract:
                data.update(abstract=abstract, abstract_source="request_excerpt")
        data["number"] = numbers.setdefault(data["task_id"], len(numbers) + 1)
        result.append({**event, "data": data})
    return result, legacy
