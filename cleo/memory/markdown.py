"""Bounded Markdown is the sole stored preference text; edits are transport only."""

from __future__ import annotations

from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_MEMORY_CHARS = 6000
HEADINGS = {"# User Preferences", "# 用户偏好"}
SNAPSHOT_HEADING = "## Last Consolidation"


class Edit(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    old: str = Field(default="", max_length=2000)
    new: str = Field(default="", max_length=2000)
    evidence_refs: list[str] = Field(default_factory=list, max_length=10)

    @model_validator(mode="after")
    def single_entry(self):
        if not self.old and not self.new:
            raise ValueError("edit must add, replace or remove a preference")
        for text in (self.old, self.new):
            if "\n" in text or "\r" in text or text.startswith(("#", "- ", "<!--")):
                raise ValueError("edits must contain one plain preference, not Markdown sections")
        return self


@dataclass
class MemoryDocument:
    preferences: list[str]
    snapshot: str = ""


def parse_memory(
    text: str,
    *,
    limit: int = MAX_MEMORY_CHARS,
    max_preferences: int = 30,
) -> MemoryDocument:
    if len(text) > limit:
        raise ValueError("memory exceeds character budget; legacy content requires migration")
    if not text.strip():
        return MemoryDocument([])
    lines = text.splitlines()
    if lines[0] not in HEADINGS:
        raise ValueError("legacy memory requires explicit migration preview")
    preferences = []
    snapshot = []
    in_snapshot = False
    for line in lines[1:]:
        if line == SNAPSHOT_HEADING and not in_snapshot:
            in_snapshot = True
        elif in_snapshot:
            if line.startswith("#"):
                raise ValueError("unsupported memory section; requires migration")
            snapshot.append(line)
        elif line.startswith("- ") and line[2:].strip():
            preferences.append(line[2:])
        elif line.strip():
            raise ValueError("unsupported memory content; requires migration")
    if len(preferences) > max_preferences:
        raise ValueError("memory preference count exceeds budget")
    if len("\n".join(snapshot)) > 1500:
        raise ValueError("snapshot exceeds budget")
    return MemoryDocument(preferences, "\n".join(snapshot).strip())


def apply_edits(text: str, edits: list[Edit], *, limit: int = MAX_MEMORY_CHARS) -> str:
    parse_memory(text, limit=limit)
    result = text
    for edit in edits:
        document = parse_memory(result, limit=max(len(result), limit), max_preferences=60)
        if edit.old:
            if document.preferences.count(edit.old) != 1:
                raise ValueError("old preference must match exactly one current entry")
            lines = result.splitlines(keepends=True)
            for index, line in enumerate(lines):
                if line.rstrip("\r\n") == "- " + edit.old:
                    ending = "\r\n" if line.endswith("\r\n") else "\n"
                    lines[index] = "- " + edit.new + ending if edit.new else ""
                    break
            result = "".join(lines)
        elif edit.new not in document.preferences:
            if not result:
                result = "# User Preferences\n"
            before, separator, after = result.partition(SNAPSHOT_HEADING)
            result = before.rstrip() + "\n- " + edit.new + "\n"
            if separator:
                result += "\n" + separator + after
    parse_memory(result, limit=limit)
    return result


def set_snapshot(text: str, snapshot: str) -> str:
    before = text.partition(SNAPSHOT_HEADING)[0].rstrip()
    if not before:
        before = "# User Preferences"
    result = before + "\n\n" + SNAPSHOT_HEADING + "\n" + snapshot.strip() + "\n"
    parse_memory(result)
    return result
