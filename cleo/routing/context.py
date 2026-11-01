"""Bounded, credential-free reference facts for evaluator decisions."""
import hashlib
import json
import re

from cleo.routing.benchmarks import match_record
from cleo.routing.models import ModelRecommendation, RouteRequest
from cleo.routing.router import METRICS, route


def canonical_digest(value) -> str:
    """Purpose: Bind decisions to trusted inputs. Input: JSON value. Output: stable digest."""
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def reference_records(candidate, snapshot):
    """Purpose: Separate calibrated matches from family references. Output: grade and records."""
    exact, status = match_record(candidate, snapshot)
    if exact:
        return "exact", [exact], status
    if snapshot is None:
        return "unmatched", [], "benchmark_missing"
    def normalized(value):
        """Purpose: Compare catalog identifiers without punctuation, never infer permissions."""
        return re.sub(r"[^a-z0-9]", "", value.casefold())

    model = normalized(candidate.model.split("[")[0])
    if model in {"default", "auto"}:
        return "unmatched", [], "mutable_alias_unmatched"
    aliases = {model, "claude" + model} if model in {"opus", "sonnet", "haiku"} else {model}
    references = [record for record in snapshot.records if record.family == "model"
                  and (normalized(record.slug) in aliases
                       or any(re.fullmatch(re.escape(alias) + r"\d.*", normalized(record.slug))
                              for alias in aliases if alias.startswith("claude")))
                  and record.effort in {None, candidate.effort}]
    # Multiple versions remain separate references, never a fabricated exact match.
    return ("family" if references else "unmatched", references[:3],
            "family_reference_not_exact_variant" if references else status)


def build_context(assessment, candidates, policy, benchmarks, feedback, project, parent):
    """Purpose: Give the evaluator eligible configurations and attributable reference rankings.

    Input: Host-bound task, metadata and policy. Output: bounded immutable decision context.
    """
    cards, rejected = [], {}
    for candidate in sorted(candidates, key=lambda item: item.id):
        checked = route(assessment, [candidate], policy, benchmarks,
                        RouteRequest(candidate_id=candidate.id))
        if checked.selected is None:
            rejected[candidate.id] = checked.rejected.get(candidate.id, checked.reasons)
            continue
        grade, records, status = reference_records(candidate, benchmarks.snapshot)
        cards.append({
            "id": candidate.id, "connection": candidate.connection,
            "backend": candidate.backend, "model": candidate.model, "effort": candidate.effort,
            "runtime_scope": candidate.availability_scope,
            "capabilities": candidate.capabilities, "context_window": candidate.context_window,
            "operator_tier": candidate.policy.tier, "cost_type": candidate.policy.cost_type,
            "reference_grade": grade, "reference_status": status,
            "references": [record.model_dump(mode="json") for record in records],
            "reference_warning": ("API prices are references, not subscription invoices; "
                                  "scores are not success probabilities"),
            "estimate": checked.estimates.get(candidate.id),
            "local_experience": feedback.summary(candidate, assessment.task_type, project, policy),
            "evidence_ids": [f"candidate:{candidate.id}",
                             *[f"aa:{record.id}" for record in records]],
        })
    if len(cards) > 128:
        raise ValueError("Candidate context exceeds 128 configurations; narrow enabled connections")
    rankings = []
    metric = METRICS[assessment.task_type]
    groups = {}
    for card in cards:
        if len(card["references"]) != 1:
            continue
        for record in card["references"]:
            for dimension in set(METRICS.values()):
                score = record["scores"].get(dimension)
                if score is not None and record["version"]:
                    key = (record["family"], record["version"], dimension)
                    groups.setdefault(key, {})[card["id"]] = score
    for (family, version, dimension), scores in sorted(
        groups.items(), key=lambda item: (item[0][2] != metric, item[0]),
    ):
        # AA scores remain unchanged; local preference is separately visible to the evaluator.
        baseline = sorted(scores, key=lambda identifier: (-scores[identifier], identifier))
        by_id = {card["id"]: card for card in cards}
        levels = sorted(set(scores.values()))
        ordinal = {identifier: levels.index(scores[identifier]) / max(1, len(levels) - 1)
                   for identifier in baseline}
        effective = sorted(baseline, key=lambda identifier: (
            -(ordinal[identifier] + by_id[identifier]["local_experience"]["adjustment"]),
            identifier,
        ))
        rankings.append({"dimension": dimension, "task_related": dimension == metric,
                         "family": family, "index_version": version,
                         "order": baseline, "effective_order": effective,
                         "adjustment_meaning": "bounded ordinal preference, not AA score"})
    for field, ascending in (("input_usd_per_million", True), ("output_usd_per_million", True),
                             ("output_tokens_per_second", False)):
        values = {card["id"]: card["references"][0][field] for card in cards
                  if len(card["references"]) == 1 and card["references"][0].get(field) is not None}
        if values:
            rankings.append({"dimension": field, "meaning": "reference_only",
                             "order": sorted(values, key=lambda key: (
                                 values[key] if ascending else -values[key], key))})
    result = {
        "strategy": "evaluator", "candidates": cards, "rejected": rejected,
        "rankings": rankings, "preference": policy.preference,
        "benchmark": {"source": benchmarks.snapshot.source if benchmarks.snapshot else None,
                      "retrieved_at": benchmarks.snapshot.retrieved_at.isoformat()
                      if benchmarks.snapshot else None, "stale": benchmarks.stale,
                      "error": benchmarks.error},
        "feedback_enabled": policy.feedback_enabled,
        "conservative_reference": policy.fallback_candidate,
    }
    result["context_id"] = "ctx_" + canonical_digest({
        "context": result, "assessment": assessment.model_dump(mode="json"),
        "policy": policy.model_dump(mode="json"), "parent": parent, "project": project,
        "feedback_revision": feedback.revision(),
    })
    return result


def validate_recommendation(value, context):
    """Purpose: Reject stale or invented choices. Output: typed, evidence-bound choice."""
    choice = ModelRecommendation.model_validate(value)
    if choice.context_id != context["context_id"]:
        raise ValueError("Routing context changed; obtain a fresh context and reassess")
    cards = {item["id"]: item for item in context["candidates"]}
    if choice.candidate_id not in cards or any(key not in cards for key in choice.alternatives):
        raise ValueError("Evaluator selected an unavailable or unknown candidate")
    evidence = set(cards[choice.candidate_id]["evidence_ids"])
    if not set(choice.evidence_refs) <= evidence:
        raise ValueError("Evaluator evidence does not belong to the selected candidate")
    return choice
