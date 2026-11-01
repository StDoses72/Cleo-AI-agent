"""Local, model-specific context metadata; output limits are never context capacities."""

import json
from pathlib import Path


def context_capacity(settings, model, backend=None, connection=None):
    """Purpose: Resolve current model capacity without inference or network access.

    Input: Selected configuration and local metadata. Output: positive capacity or zero
    (unknown). Native per-turn context notifications take precedence in the presenter.
    """
    backend = {"codex_sdk": "codex", "claude_sdk": "claude_code"}.get(backend, backend)
    if backend == "codex":
        from cleo.integrations.harness_home import harness_home

        try:
            cache = json.loads((harness_home("codex", create=False)
                                / "models_cache.json").read_text(encoding="utf-8"))
            for item in cache.get("models", []):
                if item.get("slug") != model:
                    continue
                window = item.get("context_window")
                percent = item.get("effective_context_window_percent", 100)
                if (type(window) is int and window > 0 and type(percent) is int
                        and 0 < percent <= 100):
                    return window * percent // 100
        except (OSError, ValueError, TypeError):
            pass
    try:
        root = Path(settings.MEMORY_DIR) / ".routing"
        catalog = json.loads((root / "catalog.json").read_text(encoding="utf-8"))
        values = {item["context_window"] for item in catalog.get("candidates", [])
                  if item.get("model") == model and (not backend or item.get("backend") == backend)
                  and (not connection or item.get("connection") == connection)
                  and type(item.get("context_window")) is int and item["context_window"] > 0}
        if len(values) == 1:
            return values.pop()
    except (OSError, ValueError, AttributeError, TypeError):
        pass
    return 0
