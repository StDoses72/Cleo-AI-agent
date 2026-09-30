import asyncio
import json
import os
import subprocess
import sys
import uuid
from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage, HumanMessage, message_to_dict

from cleo.desktop.timeline import TimelineIndex
from cleo.harnesses.rewind import CLAUDE_TRANSCRIPT_SCRIPT, locate_turn
from cleo.integrations.harnesses.claude import ClaudeProvider
from cleo.integrations.harnesses.codex import CodexProvider
from cleo.memory.compaction import compact_events
from cleo.sessions.rewind import active_events
from cleo.sessions.store import SessionStore


def user(turn, text, **data):
    return {"id": turn, "type": "user_message", "actor": "user", "content": text, "data": data}


def answer(turn, text):
    return {"id": f"{turn}:answer", "type": "assistant_message", "actor": "codex", "content": text,
            "data": {"turn_id": turn, "timeline_id": f"{turn}:answer"}}


def rewind(turn):
    return {"type": "rewind", "actor": "user", "data": {"turn_id": turn}}


def index_for(tmp_path, events, space="productivity"):
    store = SessionStore(tmp_path / "memory")
    manifest = store.create_session(
        session_id="history", space=space, project="p", provider="codex", owner_type="user",
    )
    store.append_events(session_id="history", space=space, project="p", events=events)
    return store, manifest, TimelineIndex(store, manifest)


def test_active_events_drop_each_rewound_turn_and_its_followers():
    events = [user("a", "one"), answer("a", "r1"), user("b", "two"), answer("b", "r2"),
              rewind("b"), user("c", "three"), rewind("a"), user("d", "four")]
    assert [event.get("id") for event in active_events(events)] == ["d"]
    assert [event.get("id") for event in active_events(events[:6])] == ["a", "a:answer", "c"]
    # An unknown target leaves history untouched.
    assert active_events([user("a", "one"), rewind("missing")]) == [user("a", "one")]


def test_timeline_hides_rewound_turns_live_and_after_rebuild(tmp_path):
    store, manifest, index = index_for(tmp_path, [
        user("a", "one"), answer("a", "r1"), user("b", "two"), answer("b", "r2"),
    ])
    before = index.page()
    assert [item["id"] for item in before["items"]] == ["a", "a:answer", "b", "b:answer"]
    store.append_events(session_id="history", space="productivity", project="p",
                        events=[rewind("b"), user("c", "edited"), answer("c", "r3")])
    after = index.page()
    assert [item["id"] for item in after["items"]] == ["a", "a:answer", "c", "c:answer"]
    assert after["total"] == 4 and not after["hasAfter"]
    assert after["revision"] != before["revision"]
    with pytest.raises(ValueError):
        index.page(cursor=before["after"], direction="before")
    index.path.unlink()
    assert [item["id"] for item in TimelineIndex(store, manifest).page()["items"]] == [
        "a", "a:answer", "c", "c:answer"]


def test_editable_turns_stop_at_handoffs_and_skip_steers(tmp_path):
    store, _, index = index_for(tmp_path, [
        user("old", "before switch"),
        {"type": "provider_event", "actor": "system",
         "data": {"provider_event_type": "cleo/harness_switch"}},
        user("first", "delivers handoff"),
        {"type": "provider_event", "actor": "system",
         "data": {"provider_event_type": "cleo/handoff_submitted"}},
        user("a", "one"), user("steered", "queued", steer_ids=["s"]),
        user("native", "inline", steer_id="n"), user("b", "two"),
    ])
    assert index.editable_turns() == ["a", "b"]
    store.append_events(session_id="history", space="productivity", project="p",
                        events=[rewind("b"), user("c", "three")])
    assert index.editable_turns() == ["a", "c"]


def test_restored_chat_and_memory_leave_out_rewound_messages(tmp_path):
    store = SessionStore(tmp_path / "memory")
    store.create_session(session_id="chat", space="non_productivity", project="general",
                         provider="cleo", owner_type="user")
    events = []
    for turn, question, reply in (("a", "one", "r1"), ("b", "secret draft", "r2")):
        events.append({**user(turn, question),
                       "message": message_to_dict(HumanMessage(id=turn, content=question))})
        events.append({"id": f"{turn}:ai", "type": "ai", "actor": "cleo", "content": reply,
                       "message": message_to_dict(AIMessage(id=f"{turn}:ai", content=reply))})
    store.append_events(session_id="chat", space="non_productivity", project="general",
                        events=[*events, rewind("b")])
    assert [message.content for message in store.load_langchain_messages("chat")] == ["one", "r1"]
    compact = compact_events(space="non_productivity", project="general", session_id="chat",
                             events=store.read_events("chat"))
    assert "secret draft" not in json.dumps(compact, ensure_ascii=False)
    assert compact["source"]["to_seq"] == len(store.read_events("chat"))


def test_locate_turn_matches_prefixed_prompts_and_skips_turns_that_never_ran():
    native = [("n4", "ctx\n\nCurrent user request:\nlatest"), ("n3", "middle"),
              ("n2", "target"), ("n1", "target")]
    assert locate_turn(native, "target", ["middle", "latest"]) == "n2"
    assert locate_turn(native, "target", ["never started", "latest"]) == "n2"
    assert locate_turn(native, "target", []) == "n2"
    with pytest.raises(ValueError):
        locate_turn(native, "absent", [])


def test_codex_rewind_reverts_recorded_or_matched_turn():
    calls = []

    async def request(method, params, *, response_model):
        calls.append((method, params))
        if method == "thread/turns/list":
            return SimpleNamespace(next_cursor=None, data=[
                SimpleNamespace(id="t2", model_dump=lambda **_: {"items": [
                    {"type": "userMessage", "content": [{"type": "text", "text": "edit me"}]},
                    {"type": "userMessage", "content": [{"type": "text", "text": "native steer"}]},
                ]}),
                SimpleNamespace(id="t1", model_dump=lambda **_: {"items": [
                    {"type": "userMessage", "content": [{"type": "text", "text": "first"}]},
                ]}),
            ])
        return SimpleNamespace()

    provider = CodexProvider.__new__(CodexProvider)
    runtime = SimpleNamespace(active_turn=None, lock=asyncio.Lock(),
                              thread=SimpleNamespace(id="thread"),
                              client=SimpleNamespace(_client=SimpleNamespace(request=request)))
    provider._sessions = {"s": runtime}
    assert asyncio.run(provider.rewind("s", prompt="x", later=[], native_turn_id="t9")) == "thread"
    assert calls == [("thread/revert", {"threadId": "thread", "beforeTurnId": "t9"})]
    calls.clear()
    asyncio.run(provider.rewind("s", prompt="edit me", later=[]))
    assert calls[-1] == ("thread/revert", {"threadId": "thread", "beforeTurnId": "t2"})
    runtime.active_turn = object()
    with pytest.raises(RuntimeError):
        asyncio.run(provider.rewind("s", prompt="edit me", later=[]))


def test_claude_rewind_forks_before_the_edited_message_or_starts_fresh():
    requests, reconnects = [], []
    rows = [{"uuid": "u1", "text": "first"}, {"uuid": "a1", "text": None},
            {"uuid": "tool", "text": None}, {"uuid": "u2", "text": "ctx\nsecond"},
            {"uuid": "a2", "text": None}]

    async def transcript(_runtime, request):
        requests.append(request)
        return rows if request["action"] == "list" else {"session": "forked"}

    async def reconnect(runtime, *_args):
        reconnects.append(runtime.native_session_id)

    provider = ClaudeProvider.__new__(ClaudeProvider)
    runtime = SimpleNamespace(active=False, lock=asyncio.Lock(), native_session_id="source",
                              options=SimpleNamespace(model="m", effort=None, approval_mode=None))
    provider._sessions = {"s": runtime}
    provider._transcript, provider._reconnect_runtime = transcript, reconnect
    assert asyncio.run(provider.rewind("s", prompt="second", later=[])) == "forked"
    assert requests[-1] == {"action": "fork", "session": "source", "message": "tool"}
    assert reconnects == ["forked"]
    runtime.native_session_id = "source"
    assert asyncio.run(provider.rewind("s", prompt="first", later=["second"])) is None
    assert requests[-1]["action"] == "list" and reconnects[-1] is None


def test_claude_transcript_script_lists_and_forks_a_real_transcript(tmp_path):
    from claude_agent_sdk._internal.sessions import _canonicalize_path, _sanitize_path

    home, cwd = tmp_path / "claude", tmp_path / "project"
    cwd.mkdir()
    session, ids = str(uuid.uuid4()), [str(uuid.uuid4()) for _ in range(4)]
    folder = home / "projects" / _sanitize_path(_canonicalize_path(str(cwd)))
    folder.mkdir(parents=True)
    messages = [("user", "first"), ("assistant", "one"), ("user", "second"), ("assistant", "two")]
    lines = []
    for position, (role, text) in enumerate(messages):
        content = text if role == "user" else [{"type": "text", "text": text}]
        lines.append(json.dumps({
            "type": role, "uuid": ids[position],
            "parentUuid": ids[position - 1] if position else None,
            "sessionId": session, "cwd": str(cwd), "isSidechain": False,
            "timestamp": f"2026-09-30T00:00:0{position}Z",
            "message": {"role": role, "content": content},
        }))
    (folder / f"{session}.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
    env = {**os.environ, "CLAUDE_CONFIG_DIR": str(home)}

    def run(request):
        result = subprocess.run([sys.executable, "-c", CLAUDE_TRANSCRIPT_SCRIPT], cwd=cwd, env=env,
                                input=json.dumps({**request, "cwd": str(cwd)}), text=True,
                                capture_output=True, check=True)
        return json.loads(result.stdout)

    rows = run({"action": "list", "session": session})
    assert [row["text"] for row in rows] == ["first", None, "second", None]
    forked = run({"action": "fork", "session": session, "message": ids[1]})["session"]
    assert forked != session
    assert [row["text"] for row in run({"action": "list", "session": forked})] == ["first", None]
