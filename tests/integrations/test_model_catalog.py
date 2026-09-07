import asyncio

import httpx
import pytest

from cleo.config.settings import AgentProfile
from cleo.integrations.model_catalog import list_api_models


def client(monkeypatch, handler):
    original = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        "cleo.integrations.model_catalog.httpx.AsyncClient",
        lambda **kw: original(
            transport=transport,
            **kw,
        ),
    )


@pytest.mark.parametrize("provider", ["openai", "anthropic", "google_genai"])
def test_api_discovery_uses_metadata_requests_and_handles_pages(monkeypatch, provider):
    requests = []

    def handler(request):
        requests.append(request)
        assert request.method == "GET"
        assert "private-key" not in str(request.url)
        if provider == "google_genai":
            assert request.headers["x-goog-api-key"] == "private-key"
            if len(requests) == 1:
                return httpx.Response(
                    200,
                    json={
                        "models": [
                            {
                                "name": "models/gemini-a",
                                "supportedGenerationMethods": ["generateContent"],
                            },
                            {
                                "name": "models/embed",
                                "supportedGenerationMethods": ["embedContent"],
                            },
                        ],
                        "nextPageToken": "page2",
                    },
                )
            assert request.url.params["pageToken"] == "page2"
            return httpx.Response(
                200,
                json={
                    "models": [
                        {
                            "name": "models/gemini-b",
                            "supportedGenerationMethods": ["generateContent"],
                        },
                    ]
                },
            )
        if provider == "anthropic":
            assert request.headers["x-api-key"] == "private-key"
            assert request.headers["anthropic-version"] == "2023-06-01"
            if len(requests) == 1:
                return httpx.Response(
                    200, json={"data": [{"id": "model-a"}], "has_more": True, "last_id": "model-a"}
                )
            assert request.url.params["after_id"] == "model-a"
        else:
            assert request.headers["authorization"] == "Bearer private-key"
        return httpx.Response(200, json={"data": [{"id": "model-a"}, {"id": "model-b"}]})

    client(monkeypatch, handler)
    result = asyncio.run(
        list_api_models(
            AgentProfile(
                provider=provider,
                model="model",
                api_key="private-key",
            )
        )
    )
    assert result == {
        "status": "connected",
        "models": ["gemini-a", "gemini-b"]
        if provider == "google_genai"
        else ["model-a", "model-b"],
    }


@pytest.mark.parametrize("status", [401, 403, 429, 500, 302])
def test_probe_errors_are_not_reported_as_success_and_do_not_echo_secrets(monkeypatch, status):
    client(monkeypatch, lambda _: httpx.Response(status, json={"error": "private-key"}))
    with pytest.raises(ValueError) as exc:
        asyncio.run(
            list_api_models(AgentProfile(provider="openai", model="x", api_key="private-key"))
        )
    assert "private-key" not in str(exc.value)


def test_missing_model_endpoint_requires_manual_entry_not_fake_validation(monkeypatch):
    client(monkeypatch, lambda _: httpx.Response(404))
    result = asyncio.run(
        list_api_models(AgentProfile(provider="openai", model="x", api_key="test"))
    )
    assert result["status"] == "manual"
    assert result["models"] == []
