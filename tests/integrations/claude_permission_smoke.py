"""Opt-in native Claude startup/permission smoke; never sends a model prompt."""

import asyncio
from tempfile import TemporaryDirectory

from cleo.integrations.harnesses.claude import ClaudeProvider


async def main():
    """Purpose: Check real CLI permission transitions. Input: local runtime. Output: verdict."""
    with TemporaryDirectory(prefix="cleo-permission-smoke-") as directory:
        provider = ClaudeProvider()
        session = await provider.create_session(directory)
        try:
            await provider.update_session_options(session.id, approval_mode="default")
            await provider.update_session_options(session.id, approval_mode="auto")
            await provider.update_session_options(session.id, approval_mode="bypassPermissions")
            # This request is rejected by a real CLI process without the required startup flag.
            await provider._sessions[session.id].client.set_permission_mode("bypassPermissions")
            await provider.update_session_options(session.id, approval_mode="acceptEdits")
            print("NATIVE_CLAUDE_PERMISSION_TRANSITIONS_PASSED; model_requests=0")
        finally:
            await provider.close(session.id)


if __name__ == "__main__":
    asyncio.run(asyncio.wait_for(main(), 90))
