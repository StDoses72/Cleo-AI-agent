"""Authoritative thread snapshots and derived memory-pipeline inputs."""

from __future__ import annotations

import datetime
import json

import langchain_core
from langchain_core.messages import messages_from_dict, messages_to_dict

from config.settings import settings
from core.memory.compaction import source_content_hash, write_compact_messages
from core.memory.state import touch_thread_source
from core.memory.store import replace_conversation_chunks
from core.runtime.model import Runtime


def _ensure_message_ids(messages: list[dict]) -> list[dict]:
    """Make every evidence reference directly resolvable in the raw snapshot."""
    for index, message in enumerate(messages):
        data = message.get("data") if isinstance(message.get("data"), dict) else message
        if not data.get("id"):
            message_type = str(message.get("type") or data.get("type") or "message")
            data["id"] = f"{message_type}-{index}"
    return messages


def _turn_messages_to_json(
    messages: list[dict],
    *,
    project: str,
    thread_id: str,
) -> str:
    return json.dumps(
        {"project": project, "thread_id": thread_id, "messages": messages},
        ensure_ascii=False,
        indent=2,
        default=str,
    )


def save_messages_to_file(
    messages: list[langchain_core.messages.BaseMessage],
    filename: str,
    runtime: Runtime,
) -> None:
    """Atomically save raw messages, then rebuild safe derived memory views."""
    thread_id = filename.removesuffix(".json")
    project = runtime.current_project or "general"
    messages_dict = _ensure_message_ids(messages_to_dict(messages))
    json_data = _turn_messages_to_json(
        messages_dict,
        project=project,
        thread_id=thread_id,
    )
    current_date = datetime.datetime.now().strftime("%Y-%m-%d")
    file_path = settings.THREAD_OBJECTS_DIR / filename
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = file_path.with_suffix(file_path.suffix + ".tmp")
    temp_path.write_text(json_data, encoding="utf-8")
    temp_path.replace(file_path)

    source_hash = source_content_hash(messages_dict)
    source_version = None
    derived_error = None
    try:
        source_state = touch_thread_source(
            project=project,
            thread_id=thread_id,
            source_hash=source_hash,
        )
        source_version = source_state["source_version"]
        _, compact_payload = write_compact_messages(
            compact_dir=settings.COMPACT_THREADS_DIR,
            project=project,
            thread_id=thread_id,
            messages=messages_dict,
            source_version=source_version,
        )
        replace_conversation_chunks(compact_payload)
    except Exception as exc:
        derived_error = str(exc)
        print(f"Warning: raw snapshot saved, but derived memory update failed: {exc}")

    jsonl_info = {
        "thread_id": thread_id,
        "project": project,
        "date": current_date,
        "message_count": len(messages),
        "raw_messages_path": str(file_path),
        "source_hash": source_hash,
        "source_version": source_version,
    }
    if derived_error:
        jsonl_info["derived_memory_error"] = derived_error
    settings.THREAD_REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    with settings.THREAD_REGISTRY_PATH.open("a", encoding="utf-8") as registry:
        registry.write(json.dumps(jsonl_info, ensure_ascii=False) + "\n")
    print(f"Messages saved to {file_path}")


def load_messages_from_file(
    filename: str,
) -> list[langchain_core.messages.BaseMessage]:
    file_path = settings.THREAD_OBJECTS_DIR / filename
    with file_path.open(encoding="utf-8-sig") as source:
        data = json.load(source)
    return messages_from_dict(data.get("messages", []))


def load_thread_project(filename: str) -> str | None:
    """Read the project binding stored alongside an authoritative snapshot."""
    file_path = settings.THREAD_OBJECTS_DIR / filename
    with file_path.open(encoding="utf-8-sig") as source:
        data = json.load(source)
    project = data.get("project") if isinstance(data, dict) else None
    return str(project).strip() if project else None
