"""Read Claude's model catalog without sending a user prompt or creating a Cleo thread."""

import asyncio
import os

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

from cleo.harnesses.control import HarnessModel


async def discover_claude_models(
    project_path: str, *, cli_path: str | None = None, env: dict[str, str] | None = None,
) -> tuple[HarnessModel, ...]:
    """Purpose: Query the installed Claude runtime's initialization catalog.

    Input: Working directory and optional official CLI path/environment.
    Output: Exact model IDs, labels and advertised effort levels; failures propagate.
    """
    # SDK overlays env onto the parent environment; explicitly clear excluded keys.
    sdk_env = {key: "" for key in os.environ if key not in env} | env if env is not None else {}
    options = ClaudeAgentOptions(cwd=project_path, cli_path=cli_path, env=sdk_env)
    async with asyncio.timeout(45):
        client = ClaudeSDKClient(options=options)
        try:
            await client.connect()
            info = await client.get_server_info()
        finally:
            await client.disconnect()
    if info is None:
        return ()
    entries = info.get("models", [])
    if not isinstance(entries, list):
        raise ValueError("Claude returned an invalid model catalog.")
    models: dict[str, HarnessModel] = {}
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("value"), str):
            continue
        identifier = entry["value"].strip()
        if not identifier:
            continue
        efforts = entry.get("supportedEffortLevels", [])
        supported = (
            tuple(value for value in efforts if isinstance(value, str))
            if isinstance(efforts, list) else ()
        )
        models[identifier] = HarnessModel(
            id=identifier,
            display_name=entry.get("displayName") or identifier,
            description=entry.get("description") or "",
            is_default=entry.get("isDefault") is True,
            default_effort=None,
            supported_efforts=supported,
        )
    return tuple(models.values())
