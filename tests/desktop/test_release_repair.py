import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from cleo.desktop.release_repair import repair_release


@pytest.mark.parametrize("publishing", [False, True])
def test_repair_uses_pinned_harness_in_isolated_session(tmp_path, publishing):
    (tmp_path / ".git").mkdir()
    config = SimpleNamespace(enabled=True, type="codex_sdk")
    settings = SimpleNamespace(productivity=SimpleNamespace(providers={"selected": config}))
    provider = SimpleNamespace(create_session=AsyncMock(return_value=SimpleNamespace(id="repair")),
                               update_session_options=AsyncMock(), close=AsyncMock(),
                               prompt=AsyncMock(return_value=SimpleNamespace(status="completed")))
    create = Mock(return_value=provider)
    request = {"source": str(tmp_path), "publishing": publishing,
               "runtime": {"provider": "selected", "model": "chosen-model", "effort": "high"},
               "diagnostics": "compiler error"}
    asyncio.run(repair_release(request, settings, create))
    create.assert_called_once_with("selected", config)
    provider.create_session.assert_awaited_once_with(str(tmp_path.resolve()), "chosen-model")
    provider.update_session_options.assert_awaited_once_with(
        "repair", effort="high", sandbox="workspace-write", approval_mode="deny_all")
    assert "compiler error" in provider.prompt.call_args.args[1]
    provider.close.assert_awaited_once_with("repair")


def test_failed_harness_is_closed_and_does_not_claim_repair(tmp_path):
    (tmp_path / ".git").mkdir()
    config = SimpleNamespace(enabled=True, type="acp")
    settings = SimpleNamespace(productivity=SimpleNamespace(providers={"acp": config}))
    provider = SimpleNamespace(create_session=AsyncMock(return_value=SimpleNamespace(id="repair")),
                               close=AsyncMock(),
                               prompt=AsyncMock(side_effect=RuntimeError("offline")))
    with pytest.raises(RuntimeError, match="offline"):
        asyncio.run(repair_release({"source": str(tmp_path), "runtime": {"provider": "acp"}},
                                  settings, Mock(return_value=provider)))
    provider.close.assert_awaited_once_with("repair")
