from __future__ import annotations

import json
from types import SimpleNamespace
from urllib.error import HTTPError, URLError

import cleo.agents.tools.web_search_tools as search_module


class _FakeResponse:
    def __init__(self, payload: dict) -> None:
        self.body = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None

    def read(self, limit: int) -> bytes:
        return self.body[:limit]


def _settings(api_key: str | None) -> SimpleNamespace:
    return SimpleNamespace(TAVILY_API_KEY=api_key)


def test_web_search_is_registered_only_with_api_key(monkeypatch) -> None:
    monkeypatch.setattr(search_module, "settings", _settings(None))
    assert search_module.get_web_search_tools() == []

    monkeypatch.setattr(search_module, "settings", _settings("secret-key"))
    assert search_module.get_web_search_tools() == [search_module.web_search]


def test_web_search_sends_basic_request_and_normalizes_results(monkeypatch) -> None:
    monkeypatch.setattr(search_module, "settings", _settings("secret-key"))
    captured = {}

    def fake_urlopen(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return _FakeResponse(
            {
                "results": [
                    {
                        "title": " Example result ",
                        "url": "https://example.com/article",
                        "content": " Useful summary ",
                        "score": 0.91,
                        "published_date": "2026-08-14",
                    },
                    {"title": "Unsafe", "url": "file:///etc/passwd", "content": "x"},
                ],
                "response_time": 1.25,
                "usage": {"credits": 1},
                "request_id": "request-1",
            }
        )

    monkeypatch.setattr(search_module, "urlopen", fake_urlopen)

    result = search_module.web_search.invoke(
        {"query": "current example", "max_results": 3, "time_range": "week"}
    )

    request = captured["request"]
    payload = json.loads(request.data.decode("utf-8"))
    assert request.full_url == "https://api.tavily.com/search"
    assert request.get_header("Authorization") == "Bearer secret-key"
    assert captured["timeout"] == 20
    assert payload == {
        "query": "current example",
        "search_depth": "basic",
        "max_results": 3,
        "include_answer": False,
        "include_raw_content": False,
        "include_images": False,
        "time_range": "week",
    }
    assert result == {
        "success": True,
        "query": "current example",
        "results": [
            {
                "title": "Example result",
                "url": "https://example.com/article",
                "snippet": "Useful summary",
                "score": 0.91,
                "published_at": "2026-08-14",
            }
        ],
        "credits_used": 1,
        "response_time_seconds": 1.25,
        "request_id": "request-1",
    }


def test_web_search_rejects_invalid_input_without_request(monkeypatch) -> None:
    monkeypatch.setattr(search_module, "settings", _settings("secret-key"))
    monkeypatch.setattr(
        search_module,
        "urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("unexpected request")),
    )

    assert search_module.web_search.invoke({"query": ""})["success"] is False
    assert search_module.web_search.invoke({"query": "ok", "max_results": 11})[
        "success"
    ] is False


def test_web_search_returns_safe_network_errors(monkeypatch) -> None:
    monkeypatch.setattr(search_module, "settings", _settings("secret-key"))

    def unauthorized(*_args, **_kwargs):
        raise HTTPError("https://api.tavily.com/search", 401, "no", {}, None)

    monkeypatch.setattr(search_module, "urlopen", unauthorized)
    result = search_module.web_search.invoke({"query": "example"})
    assert result == {
        "success": False,
        "error": "Tavily authentication failed. Check tavily_api_key.",
    }

    monkeypatch.setattr(
        search_module,
        "urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(URLError("offline")),
    )
    result = search_module.web_search.invoke({"query": "example"})
    assert result == {"success": False, "error": "Tavily search is unavailable: offline"}
