"""Local nested Git for preference files, with recoverable single-file publication."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from cleo.memory.markdown import Edit, apply_edits, parse_memory, set_snapshot
from cleo.memory.paths import project_directory

ALLOWED = re.compile(r"(?:productivity|non_productivity)/projects/[^/]+/MEMORY\.md\Z")


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read_text(path: Path) -> str:
    with path.open(encoding="utf-8", newline="") as stream:
        return stream.read()


def read_conflicts(path: Path, preferences: list[str]) -> list[dict]:
    """Recover only still-present conflict groups; metadata never duplicates the prose."""
    if not path.exists():
        return []
    review = json.loads(read_text(path))
    by_hash = {digest(preference): preference for preference in preferences}
    return [{"preferences": [by_hash[key] for key in group["hashes"]],
             "question": group["question"]}
            for group in review["conflicts"]
            if len(group["hashes"]) >= 2 and all(key in by_hash for key in group["hashes"])]


def atomic_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        temporary.write_text(text, encoding="utf-8", newline="")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def file_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        if os.name == "nt":
            import msvcrt

            if stream.tell() == 0:
                stream.write(b"\0")
                stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


class MemoryRepository:
    def __init__(self, root: Path):
        self.root = Path(root).expanduser().resolve()

    def path(self, space: str, project: str) -> Path:
        path = project_directory(self.root, space, project) / "MEMORY.md"
        if not path.resolve().is_relative_to(self.root) or path.is_symlink():
            raise ValueError("memory path escapes configured root")
        return path

    def _git(self, *args: str, input: str | None = None, check: bool = True) -> str:
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        env.update(GIT_TERMINAL_PROMPT="0", GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
        result = subprocess.run(
            [
                "git",
                "-C",
                str(self.root),
                "-c",
                "user.name=Cleo Memory",
                "-c",
                "user.email=memory@cleo.local",
                "-c",
                "commit.gpgsign=false",
                "-c",
                f"core.hooksPath={self.root / '.git' / 'cleo-empty-hooks'}",
                "-c",
                "core.autocrlf=false",
                *args,
            ],
            input=input.encode("utf-8") if input is not None else None,
            capture_output=True,
            timeout=30,
            env=env,
        )
        if check and result.returncode:
            raise RuntimeError(
                f"memory git {args[0]} failed: {result.stderr.decode('utf-8').strip()}"
            )
        return result.stdout.decode("utf-8").rstrip("\n") if not result.returncode else ""

    def _initialize(self) -> None:
        git_dir = self.root / ".git"
        if git_dir.is_symlink() or (git_dir.exists() and not git_dir.is_dir()):
            raise ValueError("memory requires its own ordinary nested Git repository")
        if not git_dir.exists():
            self._git("init", "--quiet", "--initial-branch=main")
        if Path(self._git("rev-parse", "--show-toplevel")).resolve() != self.root:
            raise ValueError("refusing to use the parent source repository")
        tracked = self._git("ls-files", "-z").split("\0")
        if any(path and not ALLOWED.fullmatch(path) for path in tracked):
            raise ValueError("memory Git contains files outside the preference allowlist")
        # Ignore everything by default; publication stages only an exact allowed path.
        exclude = git_dir / "info" / "exclude"
        if not exclude.exists() or "*" not in exclude.read_text().splitlines():
            with exclude.open("a", encoding="utf-8") as stream:
                stream.write("\n*\n")

    @property
    def journal(self) -> Path:
        return self.root / ".git" / "cleo-publish.json"

    def _recover(self) -> None:
        if not self.journal.exists():
            return
        pending = json.loads(self.journal.read_text(encoding="utf-8"))
        name = pending["path"]
        if not ALLOWED.fullmatch(name):
            raise ValueError("invalid memory publication journal path")
        path = self.root / name
        if not path.resolve().is_relative_to(self.root):
            raise ValueError("publication journal escapes memory root")
        actual = read_text(path) if path.exists() else ""
        if actual not in {pending["before"], pending["after"]}:
            raise ValueError("memory edited during interrupted publication; reconcile manually")
        committed = self._git("show", f"HEAD:{name}", check=False)
        if committed != pending["after"].rstrip("\n"):
            if pending["existed"]:
                atomic_text(path, pending["before"])
            else:
                path.unlink(missing_ok=True)
        elif actual != pending["after"]:
            raise ValueError("committed memory differs from manual edit; reconcile before retry")
        if self._git("rev-parse", "--verify", "HEAD", check=False):
            self._git("reset", "--quiet", "HEAD", "--", name)
        else:
            self._git("rm", "--cached", "--ignore-unmatch", "--", name)
        self.journal.unlink()

    def recover(self) -> None:
        if not (self.root / ".git").exists():
            return
        with file_lock(self.root / ".memory-git.lock"):
            self._initialize()
            self._recover()

    def read(self, space: str, project: str) -> str:
        path = self.path(space, project)
        if self.journal.exists():
            raise ValueError("memory publication interrupted; retry consolidation before reading")
        return read_text(path) if path.exists() else ""

    def publish(
        self, space: str, project: str, before: str, after: str, message: str
    ) -> str | None:
        parse_memory(after)
        path = self.path(space, project)
        name = path.relative_to(self.root).as_posix()
        with file_lock(self.root / ".memory-git.lock"):
            self._initialize()
            self._recover()
            actual = self.read(space, project)
            if actual != before:
                # Retrying after a committed publication must not create a second commit.
                if actual == after and self._git(
                    "show", f"HEAD:{name}", check=False
                ) == after.rstrip("\n"):
                    return self._git("rev-parse", "HEAD")
                raise ValueError(
                    "memory changed since extraction; regenerate edits from current file"
                )
            if after == before:
                return None
            committed = self._git("show", f"HEAD:{name}", check=False)
            if before and committed != before.rstrip("\n"):
                # Preserve the pre-existing/user-edited baseline as Git history, not a backup file.
                self._git("add", "--force", "--", name)
                self._git(
                    "commit",
                    "--quiet",
                    "--only",
                    "-m",
                    "Record existing memory before edit",
                    "--",
                    name,
                )
            atomic_text(
                self.journal,
                json.dumps(
                    {
                        "path": name,
                        "before": before,
                        "after": after,
                        "existed": path.exists(),
                    },
                    ensure_ascii=False,
                ),
            )
            try:
                atomic_text(path, after)
                self._git("add", "--force", "--", name)
                self._git("commit", "--quiet", "--only", "-m", message, "--", name)
            except (OSError, RuntimeError, subprocess.SubprocessError):
                self._recover()
                raise
            self.journal.unlink()
            return self._git("rev-parse", "HEAD")

    def history(self, space: str, project: str, limit: int = 10) -> list[dict]:
        if not (self.root / ".git").is_dir():
            return []
        name = self.path(space, project).relative_to(self.root).as_posix()
        rows = self._git(
            "log", f"-{max(1, min(limit, 30))}", "--format=%H%x09%cI%x09%s", "--", name, check=False
        )
        return [
            dict(zip(("commit", "created_at", "summary"), row.split("\t", 2), strict=True))
            for row in rows.splitlines()
            if row
        ]

    def revert(self, space: str, project: str, commit: str) -> str | None:
        """Undo this commit's preference delta, preserving unrelated later entries."""
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise ValueError("restore requires a full commit ID")
        name = self.path(space, project).relative_to(self.root).as_posix()
        if commit not in self._git("log", "--format=%H", "--", name).splitlines():
            raise ValueError("commit does not belong to this project memory")
        old = self._git("show", f"{commit}^:{name}", check=False)
        new = self._git("show", f"{commit}:{name}")
        older, newer = parse_memory(old), parse_memory(new)
        current = self.read(space, project)
        added = [p for p in newer.preferences if p not in older.preferences]
        removed = [p for p in older.preferences if p not in newer.preferences]
        edits = [Edit(old=p) for p in added] + [Edit(new=p) for p in removed]
        result = apply_edits(current, edits)
        if older.snapshot != newer.snapshot:
            if parse_memory(current).snapshot != newer.snapshot:
                raise ValueError("snapshot changed since this commit; cannot undo automatically")
            result = (
                set_snapshot(result, older.snapshot)
                if older.snapshot
                else result.partition("## Last Consolidation")[0].rstrip() + "\n"
            )
        return self.publish(space, project, current, result, f"Undo memory change {commit}")
