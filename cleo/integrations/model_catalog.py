"""Discover API models without issuing a paid inference request."""

from urllib.parse import urlsplit

import httpx

from cleo.config.settings import AgentProfile


async def list_api_models(profile: AgentProfile) -> dict:
    defaults = {
        "openai": "https://api.openai.com/v1",
        "anthropic": "https://api.anthropic.com",
        "google_genai": "https://generativelanguage.googleapis.com",
    }
    if profile.provider not in defaults:
        raise ValueError("此 API 类型暂不支持自动读取模型，请使用 OpenAI 兼容接口。")
    base = (profile.base_url or defaults[profile.provider]).rstrip("/")
    url = urlsplit(base)
    if (
        url.scheme not in {"http", "https"}
        or not url.hostname
        or (url.username or url.password or url.query or url.fragment)
    ):
        raise ValueError("Base URL 必须是 HTTP(S) 地址，且不能包含账号、查询参数或片段。")
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
                    raise ValueError("API 认证失败，请检查密钥及账号权限。")
                if response.status_code in {404, 405, 501}:
                    return {
                        "status": "manual",
                        "models": [],
                        "message": "服务未提供模型列表，请手动填写模型 ID。",
                    }
                if response.status_code == 429:
                    raise ValueError("服务请求受限，请稍后重试。")
                if response.status_code != 200:
                    raise ValueError(f"模型列表请求失败（HTTP {response.status_code}）。")
                try:
                    payload = response.json()
                except ValueError as exc:
                    raise ValueError("服务没有返回有效的模型列表。") from exc
                if not isinstance(payload, dict):
                    raise ValueError("服务没有返回有效的模型列表。")
                items = payload.get("models" if profile.provider == "google_genai" else "data")
                if not isinstance(items, list):
                    raise ValueError("服务没有返回有效的模型列表。")
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
                    raise ValueError("模型列表分页返回异常，请稍后重试。")
                seen_cursors.add(cursor)
                params = {parameter: cursor}
    except httpx.HTTPError as exc:
        raise ValueError("无法读取模型列表，请检查 API 地址及网络连接。") from exc
    return {"status": "connected", "models": list(dict.fromkeys(models))}
