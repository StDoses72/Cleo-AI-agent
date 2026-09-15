"""Read-only local skill discovery and explicit invocation for coding harnesses."""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class LocalSkill:
    name: str
    command: str
    source: str
    path: Path

    def entry(self) -> dict[str, str]:
        """Purpose: Describe a selectable skill without persisting a catalog.

        Input: This discovered skill.
        Output: Transient desktop response fields.
        """
        return dict(name=self.name, command=self.command, source=self.source, path=str(self.path))

    def expand(self, prompt: str) -> str:
        """Purpose: Load actual instructions and preserve the invocation arguments.

        Input: The user's slash invocation.
        Output: Provider prompt with source, instructions and original request.
        """
        try:
            instructions = self.path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeError) as exc:
            raise ValueError(f"无法读取 skill {self.name}: {self.path}") from exc
        if not instructions.strip():
            raise ValueError(f"Skill 文件为空: {self.path}")
        parts = prompt.split(maxsplit=1)
        arguments = parts[1] if len(parts) > 1 else ""
        task = arguments or (
            "(No arguments: use conversation context; ask for a topic if needed.)"
        )
        return (
            f"User invoked local skill: {self.name}\nSource: {self.source}\n"
            f"SKILL.md: {self.path}\nSkill base directory: {self.path.parent}\n"
            "Apply the following skill instructions. Resolve relative resources against the "
            "skill base directory, and read referenced files when needed.\n\n"
            f"{instructions}\n\nOriginal user invocation:\n{prompt}\n\n"
            f"Task arguments:\n{task}"
        )


def discover_skills(harness: str, cwd: str, reserved: tuple[str, ...]) -> list[LocalSkill]:
    """Purpose: Discover only the selected harness's user and project skills.

    Input: Harness family, project directory and reserved built-in commands.
    Output: Stable, disambiguated entries; no files or environment values are changed.
    """
    if harness not in {"claude", "codex"}:
        return []
    home = Path.home()
    config = Path(os.environ.get(
        "CODEX_HOME" if harness == "codex" else "CLAUDE_CONFIG_DIR",
        str(home / f".{harness}"),
    )).expanduser()
    roots = [(config / "skills", f"{harness} · 用户")]
    if harness == "codex":
        roots.append((home / ".agents" / "skills", "codex · 用户 .agents"))
    project = Path(cwd).resolve()
    for directory in (project, *project.parents):
        roots.append((directory / f".{harness}" / "skills", f"{harness} · 项目 {directory}"))
        if harness == "codex":
            roots.append((directory / ".agents" / "skills", f"codex · 项目 {directory}"))
        if (directory / ".git").exists():
            break
    found: list[tuple[str, str, Path]] = []
    seen: set[Path] = set()
    for root, source in roots:
        try:
            paths = sorted([*root.glob("*/SKILL.md"), *root.glob(".system/*/SKILL.md")])
        except OSError:
            continue
        for path in paths:
            try:
                path = path.resolve()
                if path in seen:
                    continue
                content = path.read_text(encoding="utf-8-sig")
            except (OSError, UnicodeError):
                continue
            seen.add(path)
            if not content.strip():
                continue
            header = (
                content.split("---", 2)[1]
                if content.startswith("---") and content.count("---") >= 2
                else ""
            )
            if re.search(r"(?mi)^user-invocable:\s*false\s*$", header):
                continue
            match = re.search(r"(?m)^name:\s*['\"]?([\w-]+)['\"]?\s*$", header)
            name = match[1] if match else path.parent.name
            if re.fullmatch(r"[\w-]+", name):
                found.append((name, source, path))
    reserved_names = {command.split()[0] for command in reserved} | {"/exit"}
    entries = []
    for name, source, path in found:
        collision = sum(item[0] == name for item in found) > 1 or f"/{name}" in reserved_names
        suffix = hashlib.sha256(str(path).encode()).hexdigest()[:12]
        command = f"/skill:{name}:{suffix}" if collision else f"/{name}"
        entries.append(LocalSkill(name, command, source, path))
    return sorted(entries, key=lambda skill: (skill.name, skill.command))
