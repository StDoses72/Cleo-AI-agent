"""Account discovery fixtures never send prompts or use real credentials."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from cleo.integrations.harnesses import codex_models
from cleo.integrations.harnesses.codex import CodexProvider


@pytest.mark.parametrize("status,payload,expected", [
    (200, {"models": [{"slug": "permitted", "visibility": "list"},
                      {"slug": "hidden", "visibility": "hide"}]}, frozenset({"permitted"})),
    (403, {}, None),
    (200, {"data": [{"id": "bundled"}]}, None),
    (200, {"models": [{"unexpected": "schema"}]}, None),
])
def test_oauth_catalog_is_metadata_only_and_unknown_stays_unknown(
    tmp_path, monkeypatch, status, payload, expected,
):
    (tmp_path / "auth.json").write_text(json.dumps({
        "tokens": {"access_token": "fixture-token", "account_id": "fixture-account"},
    }))
    monkeypatch.setattr("cleo.integrations.harness_home.harness_home", lambda *a, **k: tmp_path)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)

    def reply(request):
        assert request.method == "GET" and request.url == "https://api.openai.com/v1/models"
        assert request.headers["authorization"] == "Bearer fixture-token"
        return httpx.Response(status, json=payload)

    client = httpx.AsyncClient
    monkeypatch.setattr(codex_models.httpx, "AsyncClient",
                        lambda **kw: client(**kw, transport=httpx.MockTransport(reply)))
    assert asyncio.run(codex_models.account_model_ids()) == expected


def test_custom_harness_backend_never_forwards_native_credentials(tmp_path, monkeypatch):
    (tmp_path / "config.toml").write_text('model_provider = "custom"')
    monkeypatch.setattr("cleo.integrations.harness_home.harness_home", lambda *a, **k: tmp_path)
    monkeypatch.setattr(codex_models.httpx, "AsyncClient", lambda **kw: pytest.fail("No HTTP"))
    assert asyncio.run(codex_models.account_model_ids()) is None


@pytest.mark.parametrize("allowed,expected", [
    (frozenset({"allowed"}), [True, False, False, False]),
    (None, [None, None, False, False]),
])
def test_codex_bundled_names_hidden_and_restricted_entries_are_not_granted_access(
    monkeypatch, allowed, expected,
):
    def model(identifier, **changes):
        return SimpleNamespace(model=identifier, display_name=identifier, description="fixture",
                               is_default=False, default_reasoning_effort="high",
                               supported_reasoning_efforts=[], **changes)

    models = [model("allowed"), model("catalog-only"), model("hidden", hidden=True),
              model("restricted", availability_nux={"message": "account upgrade required"})]
    client = AsyncMock()
    client.__aenter__.return_value = client
    client.models.return_value = SimpleNamespace(data=models)
    monkeypatch.setattr(CodexProvider, "_client", lambda _: client)
    monkeypatch.setattr(codex_models, "account_model_ids", AsyncMock(return_value=allowed))
    provider = CodexProvider("allowed")
    result = asyncio.run(provider.list_models())
    assert [item.available for item in result] == expected
