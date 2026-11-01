"""Runtime compatibility evidence is local metadata, never a paid probe."""
import asyncio
from types import SimpleNamespace

import pytest

from cleo.desktop.projection import stream_event_item, timeline_from_events
from cleo.harnesses.availability import provider_scope, runtime_identity
from cleo.harnesses.models import AgentEvent


def test_same_runtime_bytes_share_scope_across_install_paths(tmp_path):
    first, second = tmp_path / "old.exe", tmp_path / "new.exe"
    first.write_bytes(b"fixture-runtime")
    second.write_bytes(first.read_bytes())
    assert runtime_identity("codex", str(first)) == runtime_identity("codex", str(second))
    base = dict(name="codex", provider_type="codex_sdk", availability_identity="account")
    original = provider_scope(SimpleNamespace(**base, availability_runtime="cli-v1"))
    assert original != provider_scope(SimpleNamespace(**base, availability_runtime="cli-v2"))


def test_duplicate_native_and_terminal_error_render_once():
    error = "The 'fixture' model is not supported when using Codex with a ChatGPT account."
    events = [{"id": "one", "type": "error", "content": error},
              {"id": "two", "type": "session_failed", "content": error}]
    notices = [item for item in timeline_from_events(events) if item["type"] == "notice"]
    assert len(notices) == 1 and "运行路径" in notices[0]["detail"]
    state = {}
    event = AgentEvent(provider="codex", type="error", text=error)
    assert len(stream_event_item(event, state)) == 1
    assert stream_event_item(event, state) == []


def test_account_change_between_decision_and_execution_requires_refresh(service_factory):
    async def scenario():
        service, providers = service_factory()
        root = str(service._project("."))
        candidate = (await service.catalog.list(root))[0]
        providers[0].availability_identity = "new-account"
        with pytest.raises(ValueError, match="account/runtime changed"):
            await service.catalog.validate(candidate, root)
        assert not any(provider.prompts for provider in providers)
    asyncio.run(scenario())
