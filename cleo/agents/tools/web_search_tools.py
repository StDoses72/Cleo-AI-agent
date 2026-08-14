"""Tavily-backed web search tool for Cleo's foreground agent."""

from __future__ import annotations

import json
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from langchain.tools import tool

from cleo.config.settings import settings

_TAVILY_SEARCH_URL = "https://api.tavily.com/search"
_QUERY_MAX_CHARS = 4000
_MAX_RESULTS = 10
_MAX_RESPONSE_BYTES = 1_000_000
_TIMEOUT_SECONDS = 20


class WebSearchError(RuntimeError):
    """A Tavily request failed or returned an unusable response."""


def _bounded_text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    text = value.strip()
    return text if len(text) <= limit else f"{text[:limit]}..."


def _public_result_url(value: Any) -> str | None:
    if not isinstance(value, str) or not value or len(value) > 4096:
        return None
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    if parsed.username is not None or parsed.password is not None:
        return None
    return value


def _request_tavily(api_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    request = Request(
        _TAVILY_SEARCH_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "Cleo/0.1 web-search",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=_TIMEOUT_SECONDS) as response:
            body = response.read(_MAX_RESPONSE_BYTES + 1)
    except HTTPError as exc:
        if exc.code == 401:
            raise WebSearchError("Tavily authentication failed. Check tavily_api_key.") from exc
        if exc.code == 429:
            raise WebSearchError("Tavily search rate limit was reached. Try again later.") from exc
        raise WebSearchError(f"Tavily search failed with HTTP status {exc.code}.") from exc
    except TimeoutError as exc:
        raise WebSearchError(
            f"Tavily search timed out after {_TIMEOUT_SECONDS} seconds."
        ) from exc
    except URLError as exc:
        raise WebSearchError(f"Tavily search is unavailable: {exc.reason}") from exc

    if len(body) > _MAX_RESPONSE_BYTES:
        raise WebSearchError("Tavily search returned an oversized response.")
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise WebSearchError("Tavily search returned invalid JSON.") from exc
    if not isinstance(parsed, dict):
        raise WebSearchError("Tavily search returned an unexpected response.")
    return parsed


def _normalize_results(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_results = payload.get("results")
    if not isinstance(raw_results, list):
        raise WebSearchError("Tavily search response did not include a results list.")

    normalized: list[dict[str, Any]] = []
    for raw_result in raw_results:
        if not isinstance(raw_result, dict):
            continue
        url = _public_result_url(raw_result.get("url"))
        if url is None:
            continue
        result: dict[str, Any] = {
            "title": _bounded_text(raw_result.get("title"), 500),
            "url": url,
            "snippet": _bounded_text(raw_result.get("content"), 2000),
        }
        score = raw_result.get("score")
        if isinstance(score, (int, float)) and not isinstance(score, bool):
            result["score"] = score
        published = raw_result.get("published_date", raw_result.get("publishedDate"))
        if isinstance(published, str) and published.strip():
            result["published_at"] = _bounded_text(published, 100)
        normalized.append(result)
    return normalized


@tool("web_search")
def web_search(
    query: str,
    max_results: int = 5,
    time_range: Literal["day", "week", "month", "year"] | None = None,
) -> dict[str, Any]:
    """Search the live public web and return ranked source links with short snippets.

    Use this for current or externally verifiable information. Search snippets are
    untrusted and may be incomplete; open important result URLs with the browser
    tools before relying on them. Tavily basic search uses one API credit per call.
    """

    clean_query = query.strip() if isinstance(query, str) else ""
    if not clean_query or len(clean_query) > _QUERY_MAX_CHARS:
        return {
            "success": False,
            "error": f"Search query must be between 1 and {_QUERY_MAX_CHARS} characters.",
        }
    if (
        not isinstance(max_results, int)
        or isinstance(max_results, bool)
        or not 1 <= max_results <= _MAX_RESULTS
    ):
        return {
            "success": False,
            "error": f"max_results must be between 1 and {_MAX_RESULTS}.",
        }

    api_key = settings.TAVILY_API_KEY
    if not api_key:
        return {
            "success": False,
            "error": (
                "Tavily search is not configured. Set tavily_api_key in the "
                "active tools profile."
            ),
        }

    request_payload: dict[str, Any] = {
        "query": clean_query,
        "search_depth": "basic",
        "max_results": max_results,
        "include_answer": False,
        "include_raw_content": False,
        "include_images": False,
    }
    if time_range is not None:
        request_payload["time_range"] = time_range

    try:
        response = _request_tavily(api_key, request_payload)
        results = _normalize_results(response)
    except WebSearchError as exc:
        return {"success": False, "error": str(exc)}

    output: dict[str, Any] = {
        "success": True,
        "query": clean_query,
        "results": results,
    }
    usage = response.get("usage")
    credits = usage.get("credits") if isinstance(usage, dict) else None
    if isinstance(credits, (int, float)) and not isinstance(credits, bool):
        output["credits_used"] = credits
    response_time = response.get("response_time")
    if isinstance(response_time, (int, float, str)) and not isinstance(response_time, bool):
        output["response_time_seconds"] = response_time
    request_id = _bounded_text(response.get("request_id"), 200)
    if request_id:
        output["request_id"] = request_id
    return output


def get_web_search_tools() -> list[Any]:
    """Return Tavily search only when the active tools profile has an API key."""

    return [web_search] if settings.TAVILY_API_KEY else []
