import asyncio
from datetime import timedelta

import httpx
import pytest

from cleo.routing.benchmarks import BenchmarkCache, BenchmarkSnapshot, parse_api
from cleo.routing.models import RoutingSettings, utcnow


def payload():
    return {
        "tier": "free",
        "intelligence_index_version": 4.3,
        "pagination": {"page": 1, "has_more": False},
        "data": [
            {
                "id": "fixture",
                "slug": "fixture-model",
                "name": "Fixture model (high)",
                "evaluations": {
                    "artificial_analysis_intelligence_index": 42,
                    "artificial_analysis_coding_index": None,
                },
                "pricing": {"price_1m_input_tokens": 1, "price_1m_output_tokens": 2},
                "performance": {"median_output_tokens_per_second": 50},
                "artificial_analysis_intelligence_index_cost": {"cost_per_task": {"total_cost": 3}},
            }
        ],
    }


def test_refresh_api_auth_paging_and_safe_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("ARTIFICIAL_ANALYSIS_API_KEY", "private-test-key")
    seen = []

    def request(request):
        seen.append(request)
        assert request.headers["x-api-key"] == "private-test-key"
        value = payload()
        page = int(request.url.params["page"])
        value["pagination"] = {"page": page, "has_more": page == 1}
        value["data"][0]["id"] = f"fixture-{page}"
        return httpx.Response(200, json=value)

    cache = BenchmarkCache(
        tmp_path / "cache.json", RoutingSettings(), transport=httpx.MockTransport(request)
    )
    result = asyncio.run(cache.refresh())
    assert result.error is None and not result.stale
    assert len(result.snapshot.records) == 2
    assert seen[0].url.path == "/api/v2/language/models/free"
    assert result.snapshot.records[0].scores["artificial_analysis_coding_index"] is None
    assert result.snapshot.records[0].benchmark_cost_per_task == 3
    assert "private-test-key" not in cache.path.read_text()


def test_stale_cache_failure_and_no_key_remain_usable(tmp_path, monkeypatch):
    monkeypatch.setenv("ARTIFICIAL_ANALYSIS_API_KEY", "private-test-key")
    cache = BenchmarkCache(
        tmp_path / "cache.json",
        RoutingSettings(cache_ttl_seconds=1),
        transport=httpx.MockTransport(lambda _: httpx.Response(403)),
    )
    snapshot = parse_api(payload(), retrieved_at=utcnow() - timedelta(days=1))
    cache.path.write_text(snapshot.model_dump_json())
    result = asyncio.run(cache.refresh())
    assert result.error == "aa_http_403" and result.stale
    assert result.snapshot.retrieved_at == snapshot.retrieved_at
    monkeypatch.delenv("ARTIFICIAL_ANALYSIS_API_KEY")
    assert asyncio.run(cache.refresh()).error == "aa_api_key_missing"
    assert cache.read().snapshot is not None
    cache.path.unlink()
    assert cache.read().snapshot is None


def test_offline_snapshot_import_preserves_original_time_and_rejects_bad_input(tmp_path):
    cache = BenchmarkCache(tmp_path / "cache.json", RoutingSettings())
    fixture = tmp_path / "snapshot.json"
    snapshot = parse_api(payload(), retrieved_at=utcnow() - timedelta(days=2))
    fixture.write_text(snapshot.model_dump_json())
    view = cache.import_snapshot(fixture)
    assert view.snapshot.source_kind == "local_import"
    assert view.snapshot.retrieved_at == snapshot.retrieved_at
    fixture.write_text('{"schema_version": 99, "api_key": "do-not-copy"}')
    with pytest.raises(ValueError):
        cache.import_snapshot(fixture)
    assert cache.read().snapshot == view.snapshot
    assert "do-not-copy" not in cache.path.read_text()


@pytest.mark.parametrize(
    "invalid",
    [
        None,
        {"data": {}},
        {**payload(), "data": [None]},
        {**payload(), "data": [{**payload()["data"][0], "evaluations": [1]}]},
        {**payload(), "data": [{**payload()["data"][0], "name": None}]},
        {
            **payload(),
            "data": [
                {
                    **payload()["data"][0],
                    "artificial_analysis_intelligence_index_cost": {"cost_per_task": [1]},
                }
            ],
        },
    ],
)
def test_schema_errors_do_not_replace_valid_cache(tmp_path, monkeypatch, invalid):
    monkeypatch.setenv("ARTIFICIAL_ANALYSIS_API_KEY", "private-test-key")
    cache = BenchmarkCache(
        tmp_path / "cache.json",
        RoutingSettings(),
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json=invalid)),
    )
    original = BenchmarkSnapshot(source_kind="local_import", retrieved_at=utcnow(), records=[])
    cache.path.write_text(original.model_dump_json())
    result = asyncio.run(cache.refresh())
    assert result.error == "aa_refresh_failed"
    assert result.snapshot == original


def test_prepare_refreshes_once_then_uses_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("ARTIFICIAL_ANALYSIS_API_KEY", "fixture-secret")
    seen = []

    def request(request):
        seen.append(request)
        return httpx.Response(200, json=payload())

    cache = BenchmarkCache(tmp_path / "cache.json", RoutingSettings(),
                           transport=httpx.MockTransport(request))
    async def scenario():
        assert (await cache.prepare()).snapshot is not None
        assert (await cache.prepare()).snapshot is not None
        assert len(seen) == 1
    asyncio.run(scenario())


def test_prepare_failed_refresh_keeps_stale_snapshot_and_throttles_retry(tmp_path, monkeypatch):
    monkeypatch.setenv("ARTIFICIAL_ANALYSIS_API_KEY", "fixture-secret")
    seen = []

    def request(request):
        seen.append(request)
        return httpx.Response(503)

    cache = BenchmarkCache(tmp_path / "cache.json", RoutingSettings(),
                           transport=httpx.MockTransport(request))
    snapshot = parse_api(payload(), retrieved_at=utcnow() - timedelta(days=2))
    cache.path.write_text(snapshot.model_dump_json(), encoding="utf-8")
    async def scenario():
        assert (await cache.prepare()).snapshot == snapshot
        assert (await cache.prepare()).stale
        assert len(seen) == 1
    asyncio.run(scenario())
