import asyncio
import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

from cleo.desktop.projection import internal_prompt_display, relative_time, visible_user_prompt
from cleo.desktop.runtime_permissions import permission_choices
from cleo.desktop.server import ProtocolServer
from cleo.desktop.service import DesktopService
from cleo.desktop.timeline import TimelineIndex
from cleo.i18n import language_context
from cleo.runtime.state import Runtime
from cleo.sessions.store import SessionStore


def test_catalog_languages_and_parameters_match():
    path = Path(__file__).parents[2] / "cleo/locales.json"
    for key, messages in json.loads(path.read_text(encoding="utf-8")).items():
        assert set(messages) == {"zh-CN", "en"}, key
        assert sorted(re.findall(r"\{(\w+)\}", messages["zh-CN"])) == sorted(
            re.findall(r"\{(\w+)\}", messages["en"])
        ), key


def test_relative_time_uses_the_selected_language_and_english_plurals():
    now = datetime.now(UTC)
    with language_context("en"):
        assert relative_time((now - timedelta(seconds=90)).isoformat()) == "1 minute ago"
        assert relative_time((now - timedelta(seconds=150)).isoformat()) == "2 minutes ago"
        assert relative_time((now - timedelta(minutes=90)).isoformat()) == "1 hour ago"
        assert relative_time((now - timedelta(hours=36)).isoformat()) == "1 day ago"
    with language_context("zh-CN"):
        assert relative_time((now - timedelta(seconds=90)).isoformat()) == "1 分钟前"


def test_runtime_language_roundtrips_through_the_real_protocol(tmp_path, monkeypatch):
    import cleo.config.settings as config

    monkeypatch.setattr(config, "settings", SimpleNamespace(
        RUNTIME_STATE_PATH=tmp_path / "runtime.json", MEMORY_DIR=tmp_path / "memory",
    ))
    service = object.__new__(DesktopService)
    service.runtime = Runtime()
    server = ProtocolServer(service=service)
    responses = []

    async def write(value):
        responses.append(value)

    server._write = write
    asyncio.run(server._handle({"id": "set", "method": "set_ui_language",
                                "params": {"language": "en"}}))
    assert responses[-1]["result"] == "en"
    service.runtime = Runtime()
    asyncio.run(server._handle({"id": "get", "method": "get_ui_language"}))
    assert responses[-1]["result"] == "en"
    asyncio.run(server._handle({"id": "bad", "method": "set_ui_language",
                                "params": {"language": "system"}}))
    assert responses[-1]["type"] == "error"
    assert Runtime().ui_language == "en"


def test_permission_labels_follow_language_without_changing_permissions():
    current = ["zh-CN"]
    with language_context(lambda: current[0]):
        chinese = permission_choices("codex_sdk")
        current[0] = "en"
        english = permission_choices("codex_sdk")
    assert chinese["presets"][0]["label"] == "请求批准"
    assert english["presets"][0]["label"] == "Request approval"
    assert [item["update"] for item in chinese["presets"]] == [
        item["update"] for item in english["presets"]
    ]


def test_subscription_catalog_localizes_without_mutating_the_runtime_registry():
    from cleo.integrations.subscriptions import RUNTIMES, runtime_definitions

    original = json.loads(json.dumps(RUNTIMES))
    with language_context("en"):
        catalog = runtime_definitions()
    assert catalog["codex"]["label"] == "Codex (ChatGPT sign-in; uses Codex quota)"
    assert catalog["codex"]["command"] == RUNTIMES["codex"]["command"]
    assert catalog["gemini"]["args"] == RUNTIMES["gemini"]["args"]
    assert RUNTIMES == original


def test_history_relocalizes_labels_without_rewriting_conversation_data(tmp_path):
    store = SessionStore(tmp_path / "memory")
    manifest = store.create_session(session_id="language", space="productivity", project="p",
                                    provider="codex", owner_type="user")
    for kind, content in [("user_message", "用户原文"), ("assistant_message", "模型原文"),
                          ("error", "")]:
        store.append_event(session_id="language", space="productivity", project="p",
                           actor="codex", event_type=kind, content=content)
    index = TimelineIndex(store, manifest)
    original = index.source.read_bytes()
    for language, title in [("zh-CN", "运行需要查看"), ("en", "Run needs attention"),
                            ("zh-CN", "运行需要查看")]:
        with language_context(language):
            items = index.page()["items"]
        assert [item["content"] for item in items if item["type"] == "message"] == [
            "用户原文", "模型原文",
        ]
        assert items[-1]["title"] == title
    assert index.source.read_bytes() == original


def test_english_internal_prompts_stay_hidden_in_both_interface_languages():
    prompt = ("[[CLEO_ACCEPTANCE_REQUEST:x]]\nKeep my request\n"
              "Continuation approach and assumptions: generated\n\n"
              "The following cases have been saved and frozen by the desktop app. internal")
    computer = ("Use computer_tools and computer_call to complete the computer task below.\n"
                "Internal rules\nUser task:用户要求")
    for language in ("zh-CN", "en"):
        with language_context(language):
            assert internal_prompt_display(prompt) == "Keep my request"
            assert visible_user_prompt(computer).endswith("用户要求")
            assert "Internal rules" not in visible_user_prompt(computer)
