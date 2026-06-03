import json
import langchain_core
from langchain_core.messages import messages_to_dict, messages_from_dict
import datetime

from config.settings import settings

from core.runtime.model import Runtime

thread_objects_dir = settings.THREAD_OBJECTS_DIR

def _turn_messages_to_dict(messages: list[langchain_core.messages.BaseMessage]) -> dict:
    return {"messages": messages_to_dict(messages)}

def _turn_messages_to_json(messages: list[langchain_core.messages.BaseMessage]) -> str:
    return json.dumps(_turn_messages_to_dict(messages),ensure_ascii=False, indent=2, default=str)

def save_messages_to_file(messages: list[langchain_core.messages.BaseMessage], filename: str, runtime: Runtime) -> None:
    json_data = _turn_messages_to_json(messages)
    current_date = datetime.datetime.now().strftime("%Y-%m-%d")
    file_path = thread_objects_dir / filename
    file_path.parent.mkdir(parents=True, exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(json_data)
    jsonl_info = {
        "thread_id": filename.replace(".json", ""),
        "project": runtime.current_project,
        "date": current_date,
        "message_count": len(messages),
        "raw_messages_path": str(file_path),
    }
    settings.THREAD_REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(settings.THREAD_REGISTRY_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(jsonl_info, ensure_ascii=False) + "\n")
    print(f"Messages saved to {file_path}")

def load_messages_from_file(filename: str) -> list[langchain_core.messages.BaseMessage]:
    file_path = thread_objects_dir / filename
    with open(file_path, "r", encoding="utf-8-sig") as f:
        data = json.load(f)
    messages_dict = data.get("messages", [])
    messages = messages_from_dict(messages_dict)
    return messages
