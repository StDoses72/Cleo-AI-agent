import copy
import json
from pathlib import Path
from types import SimpleNamespace

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage, messages_to_dict

from core.memory.compaction import compact_messages
from core.memory.state import (
    get_thread_source,
    mark_consolidated,
    needs_consolidation,
    touch_thread_source,
)
from core.memory.store import (
    count_source_memories,
    replace_conversation_chunks,
    search_conversation_history,
    search_memories,
    upsert_memory,
)


def test_directory_profile_uses_memory_policy_name_and_accepts_legacy_alias(
    tmp_path: Path,
) -> None:
    from config.settings import DirectoryProfile

    current = DirectoryProfile(
        root_dir=tmp_path,
        memory_policy_path="memory/MEMORY_POLICY.md",
    )
    legacy = DirectoryProfile(
        root_dir=tmp_path,
        memory_agent_path="memory/legacy-policy.md",
    )

    assert current.memory_policy_file == (tmp_path / "memory" / "MEMORY_POLICY.md")
    assert legacy.memory_policy_file == (tmp_path / "memory" / "legacy-policy.md")


def test_project_memory_reads_legacy_agent_file_only_as_fallback(
    tmp_path: Path,
    monkeypatch,
) -> None:
    from tools import dream_agent_tools

    projects_dir = tmp_path / "projects"
    project_dir = projects_dir / "cleo"
    project_dir.mkdir(parents=True)
    monkeypatch.setattr(
        dream_agent_tools,
        "settings",
        SimpleNamespace(MEMORY_PROJECTS_DIR=projects_dir),
    )

    (project_dir / "AGENT.md").write_text("legacy project memory", encoding="utf-8")
    legacy_result = dream_agent_tools.read_project_memory.invoke({"project": "cleo"})
    assert "legacy project memory" in legacy_result

    (project_dir / "MEMORY.md").write_text("current project memory", encoding="utf-8")
    current_result = dream_agent_tools.read_project_memory.invoke({"project": "cleo"})
    assert "current project memory" in current_result
    assert "legacy project memory" not in current_result


def test_compactor_preserves_bodies_merges_tools_and_redacts() -> None:
    messages = messages_to_dict(
        [
            HumanMessage(content="请分析这个文件", id="human-1"),
            AIMessage(
                content="",
                id="ai-call-1",
                tool_calls=[
                    {
                        "id": "call-1",
                        "name": "read_file",
                        "args": {
                            "file_path": "design.md",
                            "api_key": "should-not-survive",
                        },
                    }
                ],
            ),
            ToolMessage(
                content="X" * 10_000,
                tool_call_id="call-1",
                name="read_file",
                id="tool-1",
                status="success",
            ),
            AIMessage(
                content=[{"type": "text", "text": "文件显示方案需要调整。" + "很长" * 1000}],
                id="ai-final-1",
            ),
        ]
    )
    original = copy.deepcopy(messages)

    payload = compact_messages(
        project="project-a",
        thread_id="thread-a",
        messages=messages,
        source_version=3,
    )

    assert messages == original
    assert [item["type"] for item in payload["messages"]] == [
        "human",
        "tool_event",
        "ai",
    ]
    assert payload["messages"][0]["content"] == "请分析这个文件"
    assert payload["messages"][2]["content"][0]["text"].endswith("很长" * 1000)
    tool_event = payload["messages"][1]
    assert tool_event["args"]["api_key"] == "<redacted>"
    assert tool_event["result_omitted"] is True
    assert tool_event["original_result_characters"] == 10_000
    assert tool_event["source_message_ids"] == ["ai-call-1", "tool-1"]
    assert payload["source"]["source_version"] == 3


def test_memory_state_advances_only_for_changed_hash_and_explicit_completion(
    tmp_path: Path,
) -> None:
    state_path = tmp_path / "memory_state.json"
    first = touch_thread_source(
        project="project-a",
        thread_id="thread-a",
        source_hash="sha256:first",
        path=state_path,
    )
    repeated = touch_thread_source(
        project="project-a",
        thread_id="thread-a",
        source_hash="sha256:first",
        path=state_path,
    )
    changed = touch_thread_source(
        project="project-a",
        thread_id="thread-a",
        source_hash="sha256:second",
        path=state_path,
    )

    assert first["source_version"] == repeated["source_version"] == 1
    assert changed["source_version"] == 2
    assert needs_consolidation(
        "project-a", "thread-a", "sha256:second", path=state_path
    )

    mark_consolidated(
        "project-a",
        "thread-a",
        "sha256:second",
        durable_memory_count=0,
        no_durable_memory_reason="No durable project information in this thread.",
        path=state_path,
    )
    state = get_thread_source("project-a", "thread-a", path=state_path)
    assert state is not None
    assert state["consolidated_version"] == 2
    assert not needs_consolidation(
        "project-a", "thread-a", "sha256:second", path=state_path
    )


def test_atomic_memory_is_idempotent_evidence_backed_and_project_scoped(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "memory.sqlite3"
    kwargs = {
        "project": "cleo",
        "thread_id": "thread-a",
        "source_hash": "sha256:source",
        "category": "decision",
        "subject": "Memory retrieval",
        "content": "Use a local lexical index before adding vector infrastructure.",
        "evidence_message_ids": ["human-1"],
        "tags": ["memory", "retrieval"],
        "path": database_path,
    }
    first = upsert_memory(**kwargs)
    repeated = upsert_memory(**kwargs)

    assert first["id"] == repeated["id"]
    assert repeated["evidence_count"] == 1
    assert count_source_memories(
        "cleo", "thread-a", "sha256:source", path=database_path
    ) == 1
    results = search_memories(
        project="cleo",
        query="local lexical index",
        path=database_path,
    )
    assert [item["id"] for item in results] == [first["id"]]
    assert search_memories(
        project="another-project",
        query="local lexical index",
        path=database_path,
    ) == []


def test_history_search_rejects_stale_compact_sources(tmp_path: Path) -> None:
    database_path = tmp_path / "memory.sqlite3"
    compact_dir = tmp_path / "compact"
    thread_objects_dir = tmp_path / "thread_objects"
    compact_dir.mkdir()
    thread_objects_dir.mkdir()
    raw_messages = messages_to_dict(
        [
            HumanMessage(content="为什么先用词法检索？", id="human-1"),
            AIMessage(
                content="因为它不需要 Qdrant 和本地模型，部署更轻。",
                id="ai-1",
            ),
        ]
    )
    payload = compact_messages(
        project="cleo",
        thread_id="thread-a",
        messages=raw_messages,
    )
    compact_path = compact_dir / "thread-a.json"
    compact_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    (thread_objects_dir / "thread-a.json").write_text(
        json.dumps({"messages": raw_messages}, ensure_ascii=False), encoding="utf-8"
    )
    assert replace_conversation_chunks(payload, path=database_path) == 1

    results = search_conversation_history(
        project="cleo",
        query="Qdrant 部署",
        path=database_path,
        compact_dir=compact_dir,
        thread_objects_dir=thread_objects_dir,
    )
    assert len(results) == 1
    assert results[0]["message_ids"] == ["human-1", "ai-1"]

    payload["source"]["source_content_hash"] = "sha256:changed"
    compact_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    assert search_conversation_history(
        project="cleo",
        query="Qdrant 部署",
        path=database_path,
        compact_dir=compact_dir,
        thread_objects_dir=thread_objects_dir,
    ) == []


def test_snapshot_to_dream_completion_protocol(
    tmp_path: Path,
    monkeypatch,
) -> None:
    from core.memory import state, store, thread_memory
    from tools import dream_agent_tools

    fake_settings = SimpleNamespace(
        THREAD_OBJECTS_DIR=tmp_path / "thread_objects",
        COMPACT_THREADS_DIR=tmp_path / "compact_threads",
        THREAD_REGISTRY_PATH=tmp_path / "threads.jsonl",
        MEMORY_STATE_PATH=tmp_path / "memory_state.json",
        MEMORY_DATABASE_PATH=tmp_path / "memory.sqlite3",
        MEMORY_PROJECTS_DIR=tmp_path / "projects",
    )
    monkeypatch.setattr(thread_memory, "settings", fake_settings)
    monkeypatch.setattr(state, "settings", fake_settings)
    monkeypatch.setattr(store, "settings", fake_settings)
    monkeypatch.setattr(dream_agent_tools, "settings", fake_settings)

    thread_memory.save_messages_to_file(
        [
            HumanMessage(content="Cleo 先采用本地词法检索。", id="human-1"),
            AIMessage(content="已记录这个架构决策。"),
        ],
        "thread-a.json",
        SimpleNamespace(current_project="cleo"),
    )
    payload = json.loads(
        (fake_settings.COMPACT_THREADS_DIR / "thread-a.json").read_text(encoding="utf-8")
    )
    raw_payload = json.loads(
        (fake_settings.THREAD_OBJECTS_DIR / "thread-a.json").read_text(encoding="utf-8")
    )
    assert raw_payload["project"] == "cleo"
    assert raw_payload["messages"][1]["data"]["id"] == "ai-1"
    source_hash = payload["source"]["source_content_hash"]

    remembered = dream_agent_tools.remember_durable_knowledge.invoke(
        {
            "project": "cleo",
            "thread_id": "thread-a",
            "source_hash": source_hash,
            "category": "decision",
            "subject": "Initial retrieval backend",
            "content": "Use local lexical retrieval before vector infrastructure.",
            "evidence_message_ids": ["human-1"],
            "tags": ["memory", "retrieval"],
        }
    )
    assert json.loads(remembered)["status"] == "stored"

    written = dream_agent_tools.write_memory_to_markdown.invoke(
        {
            "project": "cleo",
            "thread_id": "thread-a",
            "source_hash": source_hash,
            "executive_summary": "Selected the initial retrieval backend.",
            "decisions": "- Start with local lexical retrieval.",
        }
    )
    assert written.startswith("Project memory written")
    completed = dream_agent_tools.complete_memory_consolidation.invoke(
        {
            "project": "cleo",
            "thread_id": "thread-a",
            "source_hash": source_hash,
            "durable_memory_count": 1,
        }
    )
    assert json.loads(completed)["status"] == "complete"
    source_state = state.get_thread_source("cleo", "thread-a")
    assert source_state is not None
    assert source_state["consolidated_hash"] == source_hash
    assert "thread-a#human-1" in (
        fake_settings.MEMORY_PROJECTS_DIR / "cleo" / "MEMORY.md"
    ).read_text(encoding="utf-8")
