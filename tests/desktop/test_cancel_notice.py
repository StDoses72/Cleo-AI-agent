"""A cancelled run blames a tool only when one was left running (issue #179)."""

from cleo.desktop.projection import timeline_from_events


def _notices(events):
    return [item for item in timeline_from_events(events) if item["type"] == "notice"]


def test_plain_cancel_is_a_neutral_notice_without_a_tool_warning():
    notices = _notices([
        {"id": "u1", "type": "user_message", "content": "hello"},
        {"id": "a1", "type": "assistant_message", "content": "done"},
        {"id": "c1", "type": "session_cancelled"},
    ])

    assert len(notices) == 1
    assert notices[0]["tone"] == "info"
    assert notices[0]["title"] == "运行已取消"
    assert notices[0]["detail"] == ""


def test_cancel_with_a_tool_still_running_keeps_the_tool_warning():
    notices = _notices([
        {"id": "u1", "type": "user_message", "content": "hello"},
        {"id": "t1", "type": "tool_call", "data": {"payload": {"id": "call-1", "name": "Bash"}}},
        {"id": "c1", "type": "session_cancelled"},
    ])

    assert len(notices) == 1
    assert notices[0]["tone"] == "warning"
    assert notices[0]["detail"] == "任务在工具完成前结束。"


def test_cancel_reason_from_the_backend_is_shown_as_given():
    notices = _notices([
        {"id": "u1", "type": "user_message", "content": "hello"},
        {"id": "c1", "type": "session_cancelled", "content": "Stopped by the user"},
    ])

    assert notices[0]["tone"] == "warning"
    assert notices[0]["detail"] == "Stopped by the user"
