"""Discover API models without issuing a paid inference request."""

from urllib.parse import urlsplit

import httpx

from cleo.config.settings import AgentProfile
from cleo.i18n import tr


async def list_api_models(profile: AgentProfile) -> dict:
    defaults = {
        "openai": "https://api.openai.com/v1",
        "anthropic": "https://api.anthropic.com",
        "google_genai": "https://generativelanguage.googleapis.com",
    }
    if profile.provider not in defaults:
        raise ValueError(tr("model_catalog.this_api_type_does_not_support_automatic_model_d"))
    base = (profile.base_url or defaults[profile.provider]).rstrip("/")
    url = urlsplit(base)
    if (
        url.scheme not in {"http", "https"}
        or not url.hostname
        or (url.username or url.password or url.query or url.fragment)
    ):
        raise ValueError(tr("model_catalog.base_url_must_be_an_http_s_url_without_credentia"))
    key = profile.api_key.get_secret_value()
    if profile.provider == "anthropic":
        endpoint = base + ("/models" if base.endswith("/v1") else "/v1/models")
        headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
    elif profile.provider == "google_genai":
        endpoint = base + ("/models" if base.endswith("/v1beta") else "/v1beta/models")
        headers = {"x-goog-api-key": key}
    else:
        endpoint = base + "/models"
        headers = {"Authorization": f"Bearer {key}"}
    models: list[str] = []
    params: dict[str, str] = {}
    seen_cursors: set[str] = set()
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
            while True:
                response = await client.get(endpoint, headers=headers, params=params)
                if response.status_code in {401, 403}:
                    raise ValueError(tr(
                        "model_catalog.api_authentication_failed_check_the_key_and_acco",
                    ))
                if response.status_code in {404, 405, 501}:
                    return {
                        "status": "manual",
                        "models": [],
                        "message": tr(
                            "model_catalog.this_provider_does_not_offer_a_model_list_enter_",
                        ),
                    }
                if response.status_code == 429:
                    raise ValueError(tr(
                        "model_catalog.the_provider_rate_limited_the_request_try_again_",
                    ))
                if response.status_code != 200:
                    raise ValueError(tr(
                        "model_catalog.model_list_request_failed_http_value",
                        p0=response.status_code,
                    ))
                try:
                    payload = response.json()
                except ValueError as exc:
                    raise ValueError(tr(
                        "model_catalog.the_provider_did_not_return_a_valid_model_list",
                    )) from exc
                if not isinstance(payload, dict):
                    raise ValueError(tr(
                        "model_catalog.the_provider_did_not_return_a_valid_model_list",
                    ))
                items = payload.get("models" if profile.provider == "google_genai" else "data")
                if not isinstance(items, list):
                    raise ValueError(tr(
                        "model_catalog.the_provider_did_not_return_a_valid_model_list",
                    ))
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    if profile.provider == "google_genai":
                        methods = item.get("supportedGenerationMethods")
                        if not isinstance(methods, list) or "generateContent" not in methods:
                            continue
                        identifier = item.get("name")
                        if isinstance(identifier, str):
                            identifier = identifier.removeprefix("models/")
                    else:
                        identifier = item.get("id")
                    if isinstance(identifier, str) and identifier.strip():
                        models.append(identifier.strip())
                if profile.provider == "google_genai":
                    cursor = payload.get("nextPageToken")
                    parameter = "pageToken"
                else:
                    cursor = payload.get("last_id") if payload.get("has_more") else None
                    parameter = "after_id" if profile.provider == "anthropic" else "after"
                if not cursor:
                    break
                if not isinstance(cursor, str) or cursor in seen_cursors:
                    raise ValueError(tr(
                        "model_catalog.unexpected_model_list_pagination_response_try_ag",
                    ))
                seen_cursors.add(cursor)
                params = {parameter: cursor}
    except httpx.HTTPError as exc:
        raise ValueError(tr(
            "model_catalog.could_not_read_the_model_list_check_the_api_url_",
        )) from exc
    return {"status": "connected", "models": list(dict.fromkeys(models))}
