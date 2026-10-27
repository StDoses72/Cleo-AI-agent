"""Additive migration from retired Cleo homes; originals remain recovery sources.

Only portable transcripts and user-authored text are published. Credentials, settings,
native databases, locks and global indexes remain in the retired directory for review.
A verified file copy proves byte integrity, not native SDK compatibility; successful
resume is still checked by the harness when the user opens the session.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
from pathlib import Path
from tempfile import NamedTemporaryFile

logger = logging.getLogger(__name__)
_lock = threading.RLock()
_done: set[tuple[str, str, str]] = set()
REPORT = ".cleo-native-migration.json"
_TEXT_ROOTS = {
    "codex": {"skills", "rules", "prompts", "memories"},
    "claude": {"skills", "agents", "commands"},
}


def _digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _contained_file(path: Path, root: Path) -> bool:
    return (path.is_file() and path.resolve().is_relative_to(root.resolve())
            and not any(part.is_symlink() or part.is_junction() for part in (path, *path.parents)
                        if part.is_relative_to(root)))


def _session_id(path: Path, harness: str, *, metadata_only: bool = False) -> str | None:
    """Validate portable JSONL rather than treating arbitrary files as native history."""
    identifier = None
    with path.open(encoding="utf-8-sig") as stream:
        lines = (stream.readline(65536) for _ in range(16)) if metadata_only else stream
        for line in lines:
            if not line:
                break
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError("Native transcript record is not an object")
            if harness == "codex" and row.get("type") == "session_meta":
                payload = row.get("payload")
                value = payload.get("id") if isinstance(payload, dict) else None
            else:
                value = row.get("sessionId") if harness == "claude" else None
            if value is not None:
                if not isinstance(value, str) or not value or len(value) > 128:
                    raise ValueError("Invalid native session ID")
                if identifier is not None and identifier != value:
                    raise ValueError("Conflicting native session IDs")
                identifier = value
                if metadata_only:
                    break
    return identifier


def _history_contains(target: Path, source: Path, digest: str) -> bool:
    """A native transcript may have gained turns since its original migration."""
    remaining = source.stat().st_size
    if target.stat().st_size < remaining:
        return False
    prefix = hashlib.sha256()
    with target.open("rb") as stream:
        while remaining:
            block = stream.read(min(remaining, 1024 * 1024))
            if not block:
                return False
            prefix.update(block)
            remaining -= len(block)
    return prefix.hexdigest() == digest


def _is_transcript(relative: Path, harness: str) -> bool:
    roots = {"sessions", "archived_sessions"} if harness == "codex" else {"projects"}
    return relative.parts[0] in roots and relative.suffix == ".jsonl"


def _portable_file(relative: Path, harness: str) -> bool:
    if any(part.startswith(".") or part in {"node_modules", "__pycache__"}
           for part in relative.parts):
        return False
    if relative.name.lower() in {"auth.json", "credentials.json", "secrets.json"}:
        return False
    if relative.parts[0] == "skills":
        return relative.suffix.lower() in {
            ".md", ".txt", ".py", ".js", ".mjs", ".ts", ".sh", ".ps1", ".json",
            ".yaml", ".yml", ".toml", ".csv", ".html", ".css", ".svg", ".png", ".jpg",
        }
    if relative.parts[0] in _TEXT_ROOTS[harness]:
        return relative.suffix.lower() in {".md", ".txt", ".rules"}
    if harness == "claude" and len(relative.parts) >= 4:
        return (relative.parts[0] == "projects" and relative.parts[2] == "memory"
                and relative.suffix.lower() == ".md")
    return relative.as_posix() == ("AGENTS.md" if harness == "codex" else "CLAUDE.md")


def _publish_missing(source: Path, target: Path, expected: str) -> str:
    """Publish atomically without replacing a concurrent native write."""
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with NamedTemporaryFile(dir=target.parent, prefix=".cleo-migrate-", delete=False) as out:
            temporary = Path(out.name)
            with source.open("rb") as stream:
                while block := stream.read(1024 * 1024):
                    out.write(block)
            out.flush()
            os.fsync(out.fileno())
        if _digest(temporary) != expected or _digest(source) != expected:
            raise ValueError("Source changed during migration; retry required")
        if os.name == "posix":
            temporary.chmod(source.stat().st_mode & 0o777)
        try:
            os.link(temporary, target)
        except FileExistsError:
            return "verified" if _digest(target) == expected else "conflict"
        if _digest(target) != expected:
            raise ValueError("Published transcript verification failed")
        return "verified"
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def migrate_native_home(harness: str, source: Path, target: Path) -> dict:
    """Retry each file independently; a conflicting item never blocks unrelated files."""
    if harness not in _TEXT_ROOTS:
        raise ValueError(f"Unknown harness: {harness}")
    source, target = source.resolve(), target.resolve()
    report = {"version": 1, "harness": harness, "source": str(source), "target": str(target),
              "originals_retained": True, "resume_verification": "required_on_open", "files": {}}
    if source == target or not source.is_dir():
        return report
    if source.is_relative_to(target) or target.is_relative_to(source):
        raise ValueError("Native and retired harness homes must not contain each other")
    with _lock:
        target.mkdir(parents=True, exist_ok=True)
        target_sessions: dict[str, list[Path]] = {}
        roots = ("sessions", "archived_sessions") if harness == "codex" else ("projects",)
        for root in roots:
            for path in (target / root).rglob("*.jsonl"):
                if not _contained_file(path, target):
                    continue
                try:
                    identifier = _session_id(path, harness, metadata_only=True)
                except (OSError, UnicodeError, ValueError):
                    # Unknown existing history is never replaced. Exact paths still conflict.
                    continue
                if identifier:
                    target_sessions.setdefault(identifier, []).append(path)
        for path in sorted(source.rglob("*")):
            if not path.is_file() or path.name == REPORT:
                continue
            relative = path.relative_to(source)
            key = relative.as_posix()
            record = {"status": "retained", "reason": "nonportable_or_sensitive"}
            report["files"][key] = record
            if not _contained_file(path, source):
                record["reason"] = "linked_or_outside_source"
                continue
            is_session = _is_transcript(relative, harness)
            if not is_session and not _portable_file(relative, harness):
                continue
            destination = target / relative
            if not destination.resolve().is_relative_to(target):
                record.update(status="conflict", reason="target_path_escapes_home")
                continue
            try:
                digest = _digest(path)
                record["sha256"] = digest
                if is_session:
                    identifier = _session_id(path, harness)
                    if not identifier:
                        raise ValueError("Unrecognized native transcript schema")
                    record["session_id"] = identifier
                    existing = target_sessions.get(identifier, [])
                    if existing:
                        equal = all(_history_contains(item, path, digest) for item in existing)
                        record.update(status="verified" if equal else "conflict",
                                      reason="native_session_id_exists",
                                      target=str(existing[0]))
                        continue
                if destination.exists():
                    equal = destination.is_file() and _digest(destination) == digest
                    status = "verified" if equal else "conflict"
                else:
                    status = _publish_missing(path, destination, digest)
                if is_session and status == "conflict" and destination.is_file():
                    if _history_contains(destination, path, digest):
                        status = "verified"
                record.update(status=status, reason="portable_file", target=str(destination))
                if is_session and status == "verified":
                    target_sessions.setdefault(identifier, []).append(destination)
            except (OSError, UnicodeError, ValueError) as error:
                record.update(status="retry", reason=str(error))
        # The report contains hashes/paths/status only. Losing it never loses recovery data.
        report_path = source / REPORT
        temporary = None
        try:
            with NamedTemporaryFile(mode="w", encoding="utf-8", dir=source,
                                    prefix=".cleo-report-", delete=False) as out:
                temporary = Path(out.name)
                json.dump(report, out, ensure_ascii=False, indent=2)
                out.flush()
                os.fsync(out.fileno())
            temporary.replace(report_path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return report


def ensure_migrated(harness: str, source: Path, target: Path) -> None:
    """Prepare once per process; failed files are retried on next use or restart."""
    key = (harness, str(source.resolve()), str(target.resolve()))
    with _lock:
        if key in _done:
            return
        try:
            report = migrate_native_home(harness, source, target)
        except (OSError, ValueError):
            logger.warning("Native %s migration incomplete; originals retained at %s",
                           harness, source, exc_info=True)
            return
        pending = [name for name, item in report["files"].items()
                   if item["status"] in {"retry", "conflict"}]
        if pending:
            logger.warning("Native %s migration needs review (%d files); report: %s",
                           harness, len(pending), source / REPORT)
        if not any(item["status"] == "retry" for item in report["files"].values()):
            _done.add(key)


def migration_summary(harness: str, target: Path) -> dict | None:
    """Read status counts without exposing credential filenames or migrating anything."""
    from cleo.config.settings import APP_HOME

    source = APP_HOME / "data" / harness
    if not source.is_dir() or source.resolve() == target.resolve():
        return None
    path = source / REPORT
    result = {"report_path": str(path), "status": "not_run", "status_counts": {},
              "originals_retained": True, "resume_verification": "required_on_open"}
    if not path.exists():
        return result
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(report, dict) or report.get("version") != 1:
            raise ValueError("Unsupported migration report")
        counts = dict.fromkeys(("verified", "conflict", "retry", "retained"), 0)
        for item in report["files"].values():
            counts[item["status"]] += 1
        result.update(status="available" if Path(report["target"]).resolve() == target.resolve()
                      else "different_native_target", status_counts=counts)
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        result["status"] = "read_error"
    return result


def check_resume_migration(harness: str, native_id: str) -> None:
    """Never silently resume different native history after a same-ID migration conflict."""
    from cleo.config.settings import APP_HOME
    from cleo.integrations.harness_home import harness_home

    target = harness_home(harness)
    path = APP_HOME / "data" / harness / REPORT
    if path.parent.resolve() == target.resolve() or not path.exists():
        return
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(report, dict) or report.get("version") != 1:
            raise ValueError("Unsupported migration report")
        if Path(report["target"]).resolve() != target.resolve():
            raise ValueError("Migration report belongs to a different native home")
        files = report["files"]
        if not isinstance(files, dict) or any(
            not isinstance(item, dict) for item in files.values()
        ):
            raise ValueError("Invalid migration file records")
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise RuntimeError(f"Cannot verify retired {harness} history; review {path}") from error
    # A still-running old client can append after the process-local migration completed.
    # Check only the requested legacy transcript before trusting its earlier receipt.
    for relative, item in files.items():
        source_file = path.parent / relative
        if not _same_session(relative, item, native_id) or not source_file.exists():
            continue
        if not _is_transcript(Path(relative), harness) or not _contained_file(
            source_file, path.parent,
        ):
            raise RuntimeError(f"Unsafe retired {harness} transcript reference; review {path}")
        try:
            digest = _digest(source_file)
            destination = Path(item.get("target", ""))
            valid_target = False
            if item.get("status") == "verified" and _contained_file(destination, target):
                try:
                    target_id = _session_id(destination, harness, metadata_only=True)
                    valid_target = (target_id == native_id
                                    and _history_contains(destination, source_file, digest))
                except (OSError, ValueError):
                    valid_target = False
            if digest != item.get("sha256") or not valid_target:
                files = migrate_native_home(harness, path.parent, target)["files"]
                break
        except (OSError, ValueError) as error:
            raise RuntimeError(
                f"Cannot recheck retired {harness} history; review {path}"
            ) from error
    for relative, item in files.items():
        if _same_session(relative, item, native_id) and item.get("status") in {"conflict", "retry"}:
            raise RuntimeError(
                f"Native {harness} session {native_id} has an unresolved migration conflict. "
                f"Both histories were retained; review {path} before resuming."
            )


def _same_session(relative: str, item: dict, native_id: str) -> bool:
    filename = Path(relative).name
    return (item.get("session_id") == native_id or filename == f"{native_id}.jsonl"
            or filename.endswith(f"-{native_id}.jsonl"))
