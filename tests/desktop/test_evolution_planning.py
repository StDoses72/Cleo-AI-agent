import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from cleo.desktop.evolution_planning import INSTRUCTIONS, plan_request, source_inventory, analyze_request


REQUEST = "给侧栏按钮显示文字"


def fixture(tmp_path):
    source = tmp_path / "ui" / "src"
    source.mkdir(parents=True)
    (source / "Button.tsx").write_text("<button aria-label='侧栏'><Icon /></button>\n", encoding="utf-8")
    return {"intent": "change", "cases": [{"title": "显示标签", "requirement": REQUEST,
        "current": "按钮只有图标", "trigger": "打开侧栏", "expectation": "文字标签可见",
        "references": [{"path": "ui/src/Button.tsx", "line": 1}]}]}


def run_plan(root, result):
    calls = []

    async def complete(instructions, prompt):
        calls.append((instructions, json.loads(prompt)))
        return json.dumps({"paths": ["ui/src/Button.tsx"]} if len(calls) == 1 else result)

    return asyncio.run(plan_request(root, REQUEST, complete)), calls


def test_reads_related_code_before_preparing_grounded_manual_cases(tmp_path):
    result, calls = run_plan(tmp_path, fixture(tmp_path))
    assert "<button" in calls[1][1]["sources"]["ui/src/Button.tsx"]
    case = result["cases"][0]
    assert case["current"].startswith("尚未验证")
    assert case["method"] == "manual"
    assert case["requirement"] == REQUEST
    assert "Button.tsx:1:" in case["evidence"]
    assert "fixture" not in case


@pytest.mark.parametrize("intent", ["question", "clarification"])
def test_nonediting_intents_return_no_cases(tmp_path, intent):
    fixture(tmp_path)
    result, _ = run_plan(tmp_path, {"intent": intent, "answer": "解释或澄清问题", "cases": ["ignored"]})
    assert result["intent"] == intent
    assert result["cases"] == []


@pytest.mark.parametrize("change", ["line", "path", "requirement", "missing-trigger", "empty-cases"])
def test_rejects_fabricated_evidence_and_incomplete_cases(tmp_path, change):
    result = fixture(tmp_path)
    if change == "line":
        result["cases"][0]["references"][0]["line"] = 200
    elif change == "path":
        result["cases"][0]["references"][0]["path"] = "unread.tsx"
    elif change == "requirement":
        result["cases"][0]["requirement"] = "delete memory"
    elif change == "missing-trigger":
        del result["cases"][0]["trigger"]
    else:
        result["cases"] = []
    with pytest.raises(ValueError):
        run_plan(tmp_path, result)


def test_source_inventory_excludes_user_data_and_rejects_unselected_paths(tmp_path):
    fixture(tmp_path)
    for folder in ["memory", "data", "config", "ui/src/node_modules"]:
        directory = tmp_path / folder
        directory.mkdir(parents=True)
        (directory / "private.py").write_text("private content", encoding="utf-8")
    assert source_inventory(tmp_path) == ["ui/src/Button.tsx"]
    model = AsyncMock(return_value=json.dumps({"paths": ["../memory/private.py"]}))
    with pytest.raises(ValueError, match="有效的相关源码"):
        asyncio.run(plan_request(tmp_path, REQUEST, model))
    assert model.await_count == 1


def test_subscription_analysis_uses_isolated_cwd_and_no_session_writes(monkeypatch, tmp_path):
    result = fixture(tmp_path)
    seen = []

    closed = []

    class Provider:
        async def create_session(self, root, model):
            assert Path(root) != tmp_path
            return SimpleNamespace(id="temporary")

        async def prompt(self, session_id, prompt, *, on_event):
            response = {"paths": ["ui/src/Button.tsx"]} if len(seen) == 1 else result
            return SimpleNamespace(status="completed", response=json.dumps(response))

        async def close(self, session_id):
            closed.append(session_id)

    def transport(profile, mcp):
        seen.append((mcp.project_path, mcp.mode, profile.backend, mcp.instructions))
        assert mcp.mode == "dream_extract"
        return Provider()

    monkeypatch.setattr("cleo.integrations.subscriptions.create_runtime", transport)
    def forbid_store(*args, **kwargs):
        raise AssertionError("Read-only preparation must not initialize a live session index")
    monkeypatch.setattr("cleo.sessions.store.SessionStore", forbid_store)
    settings = SimpleNamespace(productivity=SimpleNamespace(providers={"task": SimpleNamespace(
        type="codex_sdk", enabled=True, model="default")}))
    before = (tmp_path / "ui/src/Button.tsx").read_bytes()
    plan = asyncio.run(analyze_request(settings, {"provider": "task"}, tmp_path, REQUEST))
    assert plan["intent"] == "change"
    assert len(seen) == 2
    assert closed == ["temporary", "temporary"]
    assert all(not root.exists() for root, *_ in seen)
    assert (tmp_path / "ui/src/Button.tsx").read_bytes() == before


def test_unsupported_readonly_connection_fails_before_any_runtime(tmp_path):
    settings = SimpleNamespace(productivity=SimpleNamespace(providers={}),
                               active_agent_profile=SimpleNamespace(backend="unknown"))
    with pytest.raises(ValueError, match="只读分析"):
        asyncio.run(analyze_request(settings, {}, tmp_path, REQUEST))


def test_subscription_failure_closes_transport_without_creating_history(monkeypatch, tmp_path):
    from cleo.desktop.evolution_planning import subscription_text
    provider = SimpleNamespace(create_session=AsyncMock(return_value=SimpleNamespace(id="temporary")),
        prompt=AsyncMock(return_value=SimpleNamespace(status="failed", error="connection lost")), close=AsyncMock())
    monkeypatch.setattr("cleo.integrations.subscriptions.create_runtime", lambda *_: provider)
    with pytest.raises(ValueError, match="connection lost"):
        asyncio.run(subscription_text(SimpleNamespace(model="default"), tmp_path, "instructions", "request"))
    provider.close.assert_awaited_once_with("temporary")


def test_timeout_has_a_recoverable_reason(monkeypatch, tmp_path):
    fixture(tmp_path)
    settings = SimpleNamespace(productivity=SimpleNamespace(providers={"task": SimpleNamespace(
        type="codex_sdk", enabled=True, model="default")}))
    monkeypatch.setattr("cleo.desktop.evolution_planning.subscription_text", AsyncMock(side_effect=TimeoutError))
    with pytest.raises(ValueError, match="180 秒.*原需求已保留"):
        asyncio.run(analyze_request(settings, {"provider": "task"}, tmp_path, REQUEST))


def test_service_only_analyzes_managed_evolution_threads(monkeypatch, tmp_path):
    from cleo.desktop.service import DesktopService
    service = DesktopService.__new__(DesktopService)
    service.settings = object()
    service.store = SimpleNamespace(load_manifest=lambda _: {"cwd": str(tmp_path)})
    monkeypatch.setenv("CLEO_EVOLUTION_WORKSPACE", str(tmp_path))
    analyze = AsyncMock(return_value={"intent": "question", "answer": "read only", "cases": []})
    monkeypatch.setattr("cleo.desktop.evolution_planning.analyze_request", analyze)
    assert asyncio.run(service.is_evolution_thread(thread_id="test"))
    asyncio.run(service.analyze_evolution_request(thread_id="test", request="解释这个按钮"))
    analyze.assert_awaited_once()
    monkeypatch.setenv("CLEO_EVOLUTION_WORKSPACE", str(tmp_path / "different"))
    with pytest.raises(ValueError, match="进化会话"):
        asyncio.run(service.analyze_evolution_request(thread_id="test", request="change"))


def test_planning_policy_never_claims_executed_baseline_or_per_case_approval():
    assert "不得声称运行过旧版" in INSTRUCTIONS
    assert "明确的修改需求直接准备具体验收" in INSTRUCTIONS
    assert "普通界面需求" in INSTRUCTIONS
