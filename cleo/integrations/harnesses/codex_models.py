"""Read account model entitlements through the official metadata endpoint, never inference."""
import json
import os
import tomllib

import httpx


async def account_model_ids() -> frozenset[str] | None:
    """Purpose: Distinguish an authenticated account catalog from bundled CLI model names.

    Input: Cleo's isolated native Codex auth/config. Output: server IDs or unknown on failure.
    Credentials stay on the backend and are sent only to the fixed official metadata endpoint.
    """
    from cleo.integrations.harness_home import harness_home

    home = harness_home("codex", create=False)
    try:
        config = tomllib.loads((home / "config.toml").read_text(encoding="utf-8"))
    except FileNotFoundError:
        config = {}
    except (OSError, ValueError):
        return None
    if config.get("model_provider", "openai") != "openai":
        return None
    custom = config.get("model_providers", {}).get("openai", {}).get("base_url")
    if custom or os.environ.get("OPENAI_BASE_URL"):
        return None
    try:
        auth = json.loads((home / "auth.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    token = (auth.get("tokens") or {}).get("access_token")
    token = token or auth.get("OPENAI_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not isinstance(token, str) or not token:
        return None
    try:
        async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
            response = await client.get("https://api.openai.com/v1/models", headers={
                "Authorization": f"Bearer {token}",
            })
            response.raise_for_status()
            payload = response.json()
        # OAuth catalog uses models/slug/visibility; API catalogs use data/id.
        if isinstance(payload.get("models"), list):
            entries = payload["models"]
            if not all(isinstance(item, dict) and isinstance(item.get("slug"), str)
                       for item in entries):
                return None
            return frozenset(item["slug"] for item in entries if item.get("visibility") == "list")
        if isinstance(payload.get("data"), list) and not auth.get("tokens"):
            entries = payload["data"]
            if all(isinstance(item, dict) and isinstance(item.get("id"), str) for item in entries):
                return frozenset(item["id"] for item in entries)
    except (httpx.HTTPError, ValueError, TypeError, AttributeError):
        pass
    return None
