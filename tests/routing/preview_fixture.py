"""Build a metadata-cached fixture for the HTTP bridge test; never call a provider."""

import hashlib
import json
import os
import sys
from pathlib import Path


def main():
    """Purpose: Write an offline catalog. Input: directory. Output: fixture files."""
    root = Path(sys.argv[1]).resolve()
    config = root / "config"
    config.mkdir(parents=True, exist_ok=True)
    repository = Path(__file__).resolve().parents[2]
    raw = json.loads((repository / "cleo/config/templates/cleo.example.json").read_text())
    raw["profiles"]["directories"]["default"]["root_dir"] = str(root)
    profile = raw["profiles"]["agents"]["moonshot_openai_compatible"]
    profile.update(model="fixture-primary", api_key="fixture-secret", base_url="https://fixture-secret.invalid")
    (config / "cleo.json").write_text(json.dumps(raw))
    (config / "harnesses.json").write_text(json.dumps({
        "default_provider": "codex", "providers": {
            "codex": {"type": "codex_sdk", "enabled": True, "model": "fixture-model"},
        },
    }))
    os.environ.update(CLEO_HOME=str(root), CLEO_CONFIG_PATH=str(config / "cleo.json"),
                      CLEO_HARNESSES_CONFIG_PATH=str(config / "harnesses.json"))
    from cleo.config.settings import current_settings
    from cleo.harnesses.availability import provider_scope
    from cleo.integrations.harnesses.codex import CodexProvider
    from cleo.routing.catalog import atomic_json
    from cleo.routing.models import Candidate, CandidatePolicy, RoutingSettings, utcnow

    policy = RoutingSettings(
        enabled=True, fallback_candidate="codex/fixture-model@high",
        candidates={"codex/fixture-model@high": CandidatePolicy(tier="strong")},
    )
    atomic_json(config / "routing.json", policy.model_dump(mode="json"))
    candidate = Candidate(
        id="codex/fixture-model@high", connection="codex", provider="codex", backend="codex_sdk",
        model="fixture-model", effort="high", available=True, checked_at=utcnow(),
        capabilities={"text": True},
        availability_scope=provider_scope(CodexProvider("fixture-model")),
        availability_source="fixture_account_catalog",
    )
    fingerprint = hashlib.sha256(
        current_settings().productivity.model_dump_json().encode(),
    ).hexdigest()
    atomic_json(root / "memory/.routing/catalog.json", {
        "fingerprint": fingerprint,
        "availability_version": 1,
        "project_path": str(root), "checked_at": utcnow().isoformat(),
        "candidates": [candidate.model_dump(mode="json")],
    })
    from cleo.sessions.store import SessionStore

    store = SessionStore(current_settings().MEMORY_DIR, current_settings().SESSION_INDEX_PATH)
    store.create_session(session_id="fixture-root", space="non_productivity", project="general",
                         provider="cleo", owner_type="user")
    store.update_manifest("fixture-root", usage_task_id="fixture-task")
    store.append_events(session_id="fixture-root", space="non_productivity", project="general",
        events=[{"type": "task_boundary", "actor": "system", "data": {
            "task_id": "fixture-task", "number": 1, "decision": "new", "status": "initial",
            "model": "fixture-primary", "abstract": "Fixture current task",
            "abstract_source": "evaluator"}},
            {"type": "provider_event", "actor": "system", "data": {"payload": {
                "tokenUsage": {"total": {"totalTokens": 120, "inputTokens": 100,
                                         "outputTokens": 20}}}}}])


if __name__ == "__main__":
    main()
