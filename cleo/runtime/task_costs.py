"""Offline standard-rate USD references, never subscription invoices or task quotes."""

import json
from pathlib import Path

from cleo.routing.benchmarks import BenchmarkSnapshot, match_record
from cleo.routing.models import Candidate
from cleo.runtime.task_usage import cost_number


class TaskPrices:
    """Read existing price evidence once per ledger view; never refresh or infer aliases."""

    def __init__(self, memory_root):
        """Purpose: Read validated local catalog/cache. Output: reference rates or unknown."""
        root = Path(memory_root) / ".routing"
        self.rates = {}
        try:
            catalog = json.loads((root / "catalog.json").read_text(encoding="utf-8"))
            candidates = [Candidate.model_validate(item) for item in catalog["candidates"]]
        except (OSError, ValueError, TypeError, KeyError):
            return
        try:
            snapshot = BenchmarkSnapshot.model_validate_json(
                (root / "benchmarks.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            snapshot = None
        grouped = {}
        for candidate in candidates:
            record, _ = match_record(candidate, snapshot)
            policy = candidate.policy
            rates = (policy.input_usd_per_million, policy.output_usd_per_million)
            cache_rates = (policy.cache_hit_usd_per_million, policy.cache_write_usd_per_million)
            source, as_of = "configured", catalog.get("checked_at")
            price_match = "configured"
            if None in rates and record and record.family == "model":
                rates = (record.input_usd_per_million, record.output_usd_per_million)
                cache_rates = (record.cache_hit_usd_per_million, record.cache_write_usd_per_million)
                source, as_of = snapshot.source, snapshot.retrieved_at.isoformat()
                price_match = "calibrated_variant"
            elif (None in rates and snapshot and not policy.benchmark
                  and not candidate.model_version):
                # Token tariffs can be compared by an identical provider model identifier.
                # This does not assert that its performance/effort variant is calibrated.
                mutable = {"default", "auto", "opus", "sonnet", "haiku"}
                matching = [item for item in snapshot.records if item.family == "model"
                            and item.slug == candidate.model
                            and candidate.model not in mutable]
                tariffs = {(item.input_usd_per_million, item.output_usd_per_million,
                            item.cache_hit_usd_per_million, item.cache_write_usd_per_million)
                           for item in matching}
                if len(tariffs) == 1 and None not in next(iter(tariffs))[:2]:
                    tariff = next(iter(tariffs))
                    rates, cache_rates = tariff[:2], tariff[2:]
                    source, as_of = snapshot.source, snapshot.retrieved_at.isoformat()
                    price_match = "model_identifier_only"
            grouped.setdefault(candidate.model, []).append(
                (rates + cache_rates, source, as_of, price_match))
        for model, evidence in grouped.items():
            # A usage row may span effort/connection variants. Every variant must have
            # identical reliable rates, otherwise attributing a single price is ambiguous.
            pairs = {item[0] for item in evidence}
            if len(pairs) == 1 and None not in next(iter(pairs))[:2]:
                self.rates[model] = evidence[0]

    def reference(self, row):
        """Purpose: Convert reported tokens at standard rates. Output: explicitly reference USD.

        Apply reported cache quantities only when corresponding rates are available.
        Subscription terms and tax are not inferred. Missing prices remain unknown.
        """
        reported = cost_number(row.get("reportedCostUsd"))
        if reported is not None:
            return {"referenceUsd": reported, "priceSource": "harness_report",
                    "priceAsOf": None, "priceBasis": "reported_cost"}
        evidence = self.rates.get(row.get("model"))
        amount = None
        source = as_of = None
        if evidence and row.get("input") is not None and row.get("output") is not None:
            (incoming, outgoing, cache_read, cache_write), source, as_of = evidence[:3]
            read, write = row.get("cacheRead") or 0, row.get("cacheWrite") or 0
            if (read + write <= row["input"] and (not read or cache_read is not None)
                    and (not write or cache_write is not None)):
                amount = ((row["input"] - read - write) * incoming
                          + row["output"] * outgoing + read * (cache_read or 0)
                          + write * (cache_write or 0)) / 1_000_000
        return {"referenceUsd": amount, "priceSource": source, "priceAsOf": as_of,
                "priceMatch": evidence[3] if evidence and len(evidence) > 3 else None,
                "priceBasis": "cache_aware_rates" if row.get("cacheRead") or row.get("cacheWrite")
                else "standard_token_rates"}
