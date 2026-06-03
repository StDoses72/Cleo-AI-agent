import json
from pathlib import Path
import os
from langchain.tools import tool

from config.settings import settings

thread_objects_dir = settings.THREAD_OBJECTS_DIR
PROJECT_MEMORY_FILENAMES = (
    "AGENT.md",
    "decisions.md",
    "open_questions.md",
    "artifacts.md",
)
PROJECT_MEMORY_TEMPLATE = """# Project Memory: {project}

## Last Consolidated Thread
- Thread ID: {thread_id}

## Executive Summary
{executive_summary}

## Facts
{facts}

## Decisions
{decisions}

## User Preferences
{preferences}

## Corrections
{corrections}

## Open Questions
{open_questions}

## Next Actions
{next_actions}

## Artifact References
{artifact_refs}

## Memory Notes
{memory_patch}

## Excluded Noise
{excluded_noise}
"""


def _is_safe_name(value: str) -> bool:
    return bool(value) and not any(part in value for part in ("/", "\\", ".."))


def _safe_project_dir(project: str) -> Path:
    if not _is_safe_name(project):
        raise ValueError("project must be a project name, not a path")
    return settings.MEMORY_PROJECTS_DIR / project


def _safe_thread_id(thread_id: str) -> str:
    if not _is_safe_name(thread_id):
        raise ValueError("thread_id must be an id, not a path")
    return thread_id


def _format_markdown_items(value: str) -> str:
    text = (value or "").strip()
    if not text:
        return "- None"
    lines = [line.rstrip() for line in text.splitlines() if line.strip()]
    if not lines:
        return "- None"
    if all(line.lstrip().startswith(("-", "*", "1.")) for line in lines):
        return "\n".join(lines)
    if len(lines) == 1:
        return lines[0]
    return "\n".join(f"- {line}" for line in lines)

@tool
def read_memory_from_json(thread_id: str) -> str:
    '''
    Use this tool to retrieve the message history of a thread in JSON format. 
    The input should be the thread_id (without the .json extension). 
    The output will be a JSON string containing the messages of the thread, or an empty string if the thread does not exist.
    Args:
        thread_id: The ID of the thread to retrieve, should be provided without the .json extension
    Outputs:
        The output will be a JSON string containing the messages of the thread, or an empty string if the thread does not exist.
    '''
    filename = f"{thread_id}.json"
    file_path = thread_objects_dir / filename
    if not file_path.exists():
        return ""
    with open(file_path, "r", encoding="utf-8-sig") as f:
        data = json.load(f)
    messages_dict = data.get("messages", [])
    return json.dumps({"messages": messages_dict}, ensure_ascii=False, indent=2, default=str)

@tool
def list_all_thread_ids() -> list[str]:
    '''
    Use this tool to list all the thread IDs that are currently stored in the thread objects directory. 
    The output will be a JSON string containing a list of thread IDs (without the .json extension).
    Outputs:
        The output will be a list of strings that containing thread IDs of message information within the thread pools(without the .json extension).
    '''
    thread_ids = []
    for file in os.listdir(thread_objects_dir):
        if file.endswith(".json"):
            thread_id = file[:-5]  # Remove the .json extension
            thread_ids.append(thread_id)
    return thread_ids

@tool
def list_all_project_names() -> list[str]:
    '''
    Use this tool to list all the project names that are currently stored in the memory projects directory. 
    Projects are stored as directories under the memory projects directory.
    Outputs:
        The output will be a list of strings that containing project names of long-term memory within the memory projects directory.
    '''
    projects_dir = settings.MEMORY_PROJECTS_DIR
    if not projects_dir.exists():
        return []
    return sorted(
        path.name
        for path in projects_dir.iterdir()
        if path.is_dir()
    )

@tool
def read_project_memory(project: str) -> str:
    '''
    Use this tool to read existing long-term memory for a project.
    The input should be a project name returned by list_all_project_names, not a path.
    This tool reads only known memory markdown files from memory/projects/{project}/.
    Args:
        project: The project name to read.
    Outputs:
        A markdown string containing existing project memory sections, or an empty string if no memory files exist.
    '''
    try:
        project_directory = _safe_project_dir(project)
    except ValueError as exc:
        return f"Error: {exc}"
    if not project_directory.exists():
        return ""

    sections = []
    for filename in PROJECT_MEMORY_FILENAMES:
        file_path = project_directory / filename
        if file_path.exists() and file_path.is_file():
            content = file_path.read_text(encoding="utf-8-sig").strip()
            if content:
                sections.append(f"# {filename}\n\n{content}")
    return "\n\n---\n\n".join(sections)


@tool
def write_memory_to_markdown(
    project: str,
    thread_id: str,
    executive_summary: str = "",
    facts: str = "",
    decisions: str = "",
    preferences: str = "",
    corrections: str = "",
    open_questions: str = "",
    next_actions: str = "",
    artifact_refs: str = "",
    memory_patch: str = "",
    excluded_noise: str = "",
) -> str:
    '''
    Use this tool to write the formatted long-term memory file for a project.
    This writes only to memory/projects/{project}/AGENT.md and cannot write arbitrary paths.
    Before calling this tool, read existing project memory and include any durable existing
    memory that should be preserved in the section inputs.
    Args:
        project: The project name, not a path.
        thread_id: The source thread id, without .json and not a path.
        executive_summary: Short summary of durable changes or learnings.
        facts: Proposed stable project facts, preferably as markdown bullets.
        decisions: Proposed durable decisions, preferably as markdown bullets.
        preferences: Proposed user preferences, preferably as markdown bullets.
        corrections: Proposed user corrections, preferably as markdown bullets.
        open_questions: Remaining uncertainties or questions, preferably as markdown bullets.
        next_actions: Follow-up work, preferably as markdown bullets.
        artifact_refs: Relevant file paths or artifacts, preferably as markdown bullets.
        memory_patch: Additional durable memory notes that do not fit the sections above.
        excluded_noise: Content intentionally ignored, preferably as markdown bullets.
    Output:
        A confirmation string with the written long-term memory path, or an error string.
    '''
    try:
        project_directory = _safe_project_dir(project)
        safe_thread_id = _safe_thread_id(thread_id)
    except ValueError as exc:
        return f"Error: {exc}"

    project_directory.mkdir(parents=True, exist_ok=True)
    memory_path = project_directory / "AGENT.md"

    content = PROJECT_MEMORY_TEMPLATE.format(
        thread_id=safe_thread_id,
        project=project,
        executive_summary=(executive_summary or "No durable summary provided.").strip(),
        facts=_format_markdown_items(facts),
        decisions=_format_markdown_items(decisions),
        preferences=_format_markdown_items(preferences),
        corrections=_format_markdown_items(corrections),
        open_questions=_format_markdown_items(open_questions),
        next_actions=_format_markdown_items(next_actions),
        artifact_refs=_format_markdown_items(artifact_refs),
        memory_patch=(memory_patch or "No suggested patch.").strip(),
        excluded_noise=_format_markdown_items(excluded_noise),
    ).rstrip() + "\n"

    memory_path.write_text(content, encoding="utf-8")
    return f"Project memory written to {memory_path}"

