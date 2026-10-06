"""Command-created ACP sessions initialize approvals and retain policy after restart."""

from __future__ import annotations

import pytest

from .support.backend import Backend
from .support.home import CHAT_API_KEY, CleoHome


def _new_task(backend: Backend, home: CleoHome) -> dict:
    return backend.call("create_thread", space="productivity",
                        project_id_value="productivity:workspace",
                        project_path=str(home.workspace))


def _adopt(backend: Backend, source_id: str, command: str) -> dict:
    events = backend.run_turn(source_id, command)
    assert not [event for event in events if event["type"] == "error"]
    thread_id = next(event["activeThreadId"] for event in events if event["type"] == "refresh")
    assert thread_id != source_id
    return backend.call("load_thread", thread_id=thread_id)


def _ask_user(backend: Backend, thread_id: str) -> None:
    stream = backend.stream_turn(thread_id, "Check approval [[permission]]")
    request = stream.wait_for(lambda event: event["type"] == "approval-request")["request"]
    resolved = backend.call("resolve_approval", thread_id=thread_id,
                            approval_id=request["id"], decision="decline")
    assert resolved["decision"] == "decline"
    stream.result()
    assert any("permission: reject" in event["item"].get("content", "")
               for event in stream.events if event["type"] == "upsert-item")
    thread = backend.call("load_thread", thread_id=thread_id)
    assert thread["runtime"]["approval"] == "user"
    assert thread["pendingApprovals"] == []


def _assert_protocol(backend: Backend) -> None:
    assert not backend.unmatched
    assert not any(CHAT_API_KEY in line for line in backend.stdout_lines)


@pytest.mark.parametrize("command", ["cd", "resume-native"])
def test_command_adoption_asks_user_before_and_after_restart(
    backend: Backend, cleo_home: CleoHome, command: str,
) -> None:
    source = _new_task(backend, cleo_home)
    argument = str(cleo_home.workspace) if command == "cd" else "external-native-session"
    adopted = _adopt(backend, source["id"], f"/{command} {argument}")
    assert adopted["runtime"]["approval"] == "user"
    _ask_user(backend, adopted["id"])

    backend.kill()
    restarted = Backend(cleo_home).start()
    try:
        # The scripted agent reuses acp-session-1 in each process. Remove the unused
        # source before reconnecting so its fixture native ID cannot alias /cd's target.
        if command == "cd":
            restarted.call("delete_thread", thread_id=source["id"])
        _ask_user(restarted, adopted["id"])
    finally:
        restarted.kill()
    _assert_protocol(restarted)


@pytest.mark.parametrize("policy, outcome", [("deny_all", "reject"), ("auto_allow", "allow")])
def test_native_adoption_preserves_saved_explicit_approval_policy(
    backend: Backend, cleo_home: CleoHome, policy: str, outcome: str,
) -> None:
    source = _new_task(backend, cleo_home)
    command = "/resume-native saved-policy-session"
    adopted = _adopt(backend, source["id"], command)
    backend.call("update_runtime", thread_id=adopted["id"], update={"approval": policy})
    backend.kill()

    restarted = Backend(cleo_home).start()
    try:
        resumed = _adopt(restarted, source["id"], command)
        assert resumed["id"] == adopted["id"]
        assert resumed["runtime"]["approval"] == policy
        stream = restarted.stream_turn(resumed["id"], "Check saved policy [[permission]]")
        stream.result()
        assert not any(event["type"] == "approval-request" for event in stream.events)
        assert any(f"permission: {outcome}" in event["item"].get("content", "")
                   for event in stream.events if event["type"] == "upsert-item")
        assert restarted.call("load_thread", thread_id=resumed["id"])["runtime"][
            "approval"
        ] == policy
    finally:
        restarted.kill()
    _assert_protocol(restarted)
