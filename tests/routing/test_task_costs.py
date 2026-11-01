"""Standard-rate conversion uses only local validated evidence and reported tokens."""

import json

import pytest

from cleo.routing.benchmarks import BenchmarkRecord, BenchmarkSnapshot
from cleo.routing.models import Candidate, CandidatePolicy, utcnow
from cleo.runtime.task_costs import TaskPrices


def prices(tmp_path, candidates, snapshot=None):
    """Purpose: Write offline evidence in production format. Output: immutable price view."""
    root = tmp_path / ".routing"
    root.mkdir()
    (root / "catalog.json").write_text(json.dumps({"candidates": [
        candidate.model_dump(mode="json") for candidate in candidates]}), encoding="utf-8")
    if snapshot:
        (root / "benchmarks.json").write_text(snapshot.model_dump_json(), encoding="utf-8")
    return TaskPrices(tmp_path)


def candidate(**updates):
    """Purpose: Build one exact executable variant. Output: validated catalog item."""
    return Candidate(id="fixture/high", connection="fixture", provider="fixture",
                     backend="codex", model="fixture", model_version="v1", effort="high",
                     **updates)


def test_configured_subscription_reference_is_not_free_or_an_invoice(tmp_path):
    book = prices(tmp_path, [candidate(policy=CandidatePolicy(cost_type="subscription",
        input_usd_per_million=2, output_usd_per_million=10))])
    result = book.reference({"model": "fixture", "input": 1000000, "output": 200000})
    assert result["referenceUsd"] == 4 and result["priceBasis"] == "standard_token_rates"
    assert "actualCostUsd" not in result
    assert book.reference({"model": "alias", "input": 100, "output": 10})["referenceUsd"] is None
    assert book.reference({"model": "fixture", "input": None, "output": 10})["referenceUsd"] is None


@pytest.mark.parametrize("effort, expected", [("high", 4), ("low", None)])
def test_exact_benchmark_binding_and_effort_are_required(tmp_path, effort, expected):
    snapshot = BenchmarkSnapshot(source_kind="local_import", retrieved_at=utcnow(), records=[
        BenchmarkRecord(id="aa", slug="fixture", name="fixture", effort=effort,
                        version="index-v1", input_usd_per_million=2, output_usd_per_million=10)])
    policy = CandidatePolicy(benchmark={"record_id": "aa", "model_version": "v1", "effort": "high"})
    book = prices(tmp_path, [candidate(policy=policy)], snapshot)
    assert book.reference({"model": "fixture", "input": 1000000, "output": 200000})[
        "referenceUsd"] == expected


def test_missing_corrupt_and_ambiguous_prices_remain_unknown(tmp_path):
    assert TaskPrices(tmp_path).reference({"model": "fixture"})["referenceUsd"] is None
    one = candidate(policy=CandidatePolicy(input_usd_per_million=1, output_usd_per_million=2))
    two = one.model_copy(update={"id": "another", "policy": CandidatePolicy(
        input_usd_per_million=3, output_usd_per_million=4)})
    book = prices(tmp_path, [one, two])
    assert book.reference({"model": "fixture", "input": 10, "output": 10})["referenceUsd"] is None
    (tmp_path / ".routing/catalog.json").write_text("not json", encoding="utf-8")
    assert TaskPrices(tmp_path).reference({"model": "fixture"})["referenceUsd"] is None


def test_provider_reported_cost_precedes_rate_conversion(tmp_path):
    assert TaskPrices(tmp_path).reference({'model': 'unknown', 'reportedCostUsd': .031})[
        'referenceUsd'] == .031
    assert TaskPrices(tmp_path).reference({'model': 'unknown', 'reportedCostUsd': -1})[
        'referenceUsd'] is None


def test_cache_rates_apply_without_double_counting_and_missing_rate_is_unknown(tmp_path):
    book = prices(tmp_path, [candidate(policy=CandidatePolicy(input_usd_per_million=2,
        output_usd_per_million=10, cache_hit_usd_per_million=.2, cache_write_usd_per_million=3))])
    assert book.reference({'model': 'fixture', 'input': 1000000, 'output': 100000,
        'cacheRead': 500000, 'cacheWrite': 100000})['referenceUsd'] == pytest.approx(2.2)
    book.rates['fixture'] = ((2, 10, None, None), 'fixture', None)
    assert book.reference({'model': 'fixture', 'input': 100, 'output': 10,
        'cacheRead': 50})['referenceUsd'] is None


def test_identical_model_tariff_does_not_claim_performance_variant_match(tmp_path):
    snapshot = BenchmarkSnapshot(source_kind='local_import', retrieved_at=utcnow(), records=[
        BenchmarkRecord(id='aa-model', slug='fixture-model', name='Fixture (max)', effort='max',
                        version='index-v1', input_usd_per_million=2, output_usd_per_million=10)])
    item = candidate().model_copy(update={'model': 'fixture-model', 'model_version': None})
    book = prices(tmp_path, [item], snapshot)
    result = book.reference({'model': 'fixture-model', 'input': 1000000, 'output': 200000})
    assert result['referenceUsd'] == 4 and result['priceMatch'] == 'model_identifier_only'
    assert book.reference({'model': 'fixture', 'input': 10, 'output': 10})['referenceUsd'] is None
