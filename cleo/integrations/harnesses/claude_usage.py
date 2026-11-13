"""Read the Claude account's plan usage without sending a prompt or creating a Cleo thread."""

import asyncio
import os
import tempfile
from datetime import datetime
from typing import Any

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

from cleo.runtime.usage import RateLimitWindowUsage

# The usage endpoint groups its rows; these are the two whose length is known.
_GROUP_MINUTES = {"session": 300, "weekly": 10_080}


async def read_claude_usage(
    *, cli_path: str | None = None, env: dict[str, str] | None = None,
) -> tuple[RateLimitWindowUsage, ...]:
    """Purpose: Ask the installed Claude runtime for the plan's usage rows.

    Input: Optional official CLI path/environment. Output: one window per row the server
    sent; empty for an account without plan limits. No model is called and no transcript is
    written. Failures propagate.
    """
    # SDK overlays env onto the parent environment; explicitly clear excluded keys.
    sdk_env = {key: "" for key in os.environ if key not in env} | env if env is not None else {}
    options = ClaudeAgentOptions(
        cwd=tempfile.gettempdir(), cli_path=cli_path, env=sdk_env, setting_sources=[],
    )
    async with asyncio.timeout(30):
        client = ClaudeSDKClient(options=options)
        try:
            await client.connect()
            # The CLI answers a get_usage control request; this SDK version has no public
            # method for it, so the request goes through the client's own control channel.
            send = getattr(getattr(client, "_query", None), "_send_control_request", None)
            reply = await send({"subtype": "get_usage"}) if callable(send) else None
        finally:
            await client.disconnect()
    return usage_windows(reply)


def usage_windows(reply: Any) -> tuple[RateLimitWindowUsage, ...]:
    """Purpose: Turn a get_usage reply into windows. Rows of an unknown group are left out.

    Input: The control reply. Output: windows in the server's order.
    """
    limits = reply.get("rate_limits") if isinstance(reply, dict) else None
    rows = limits.get("limits") if isinstance(limits, dict) else None
    windows = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        minutes = _GROUP_MINUTES.get(row.get("group"))
        percent = row.get("percent")
        if minutes is None or isinstance(percent, bool) or not isinstance(percent, (int, float)):
            continue
        scope = row.get("scope") if isinstance(row.get("scope"), dict) else {}
        labels = [item.get("display_name") for item in (scope.get("model"), scope.get("surface"))
                  if isinstance(item, dict)]
        windows.append(RateLimitWindowUsage(
            used_percent=max(0, min(round(percent), 100)),
            window_minutes=minutes,
            resets_at=_epoch(row.get("resets_at")),
            scope=next((label for label in labels if isinstance(label, str) and label), None),
        ))
    return tuple(windows)


def _epoch(value: Any) -> int | None:
    try:
        return int(datetime.fromisoformat(value).timestamp())
    except (TypeError, ValueError):
        return None
