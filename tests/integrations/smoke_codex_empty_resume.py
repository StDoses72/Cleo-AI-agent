"""Exercise real CLI draft reconnection without sending prompts or running a model."""

import asyncio
import tempfile
from pathlib import Path

from cleo.harnesses import AgentAdapter
from cleo.harnesses.provider import NativeSessionNotFoundError
from cleo.integrations.harnesses.codex import CodexProvider


async def main():
    """Purpose: Check real start/close/resume behavior with isolated Cleo records.

    Input: Installed Codex CLI via CLEO_CODEX_BIN. Output: deterministic identity assertions.
    """
    with tempfile.TemporaryDirectory(prefix="cleo-empty-resume-") as temporary:
        root = Path(temporary)
        provider = CodexProvider("gpt-5.6-sol")
        adapter = AgentAdapter(root)
        adapter.register(provider)
        original = await adapter.create_session("codex")
        await adapter.update_session_options(
            original.id, effort="max", approval_mode="deny_all", sandbox="workspace-write"
        )
        await adapter.close(original.id)
        # First demonstrate the underlying CLI condition independently of recovery.
        try:
            direct = await provider.resume_session(original.native_session_id, str(root))
        except NativeSessionNotFoundError:
            print("REPRODUCED: CLI cannot resume a draft without a rollout")
        else:
            await provider.close(direct.id)
            print("CLI persisted this draft; checking ordinary resume")
        for _ in range(2):
            current = adapter._store.load_manifest(original.id)
            recovered = AgentAdapter(root, session_store=adapter._store)
            recovered.register(provider)
            try:
                resumed = await recovered.resume_session("codex", current["native_session_id"])
                assert resumed.id == original.id
                assert recovered.session_options(resumed.id).effort == "max"
                assert recovered.session_options(resumed.id).sandbox == "workspace-write"
                assert all(
                    event["type"] in {"session_created", "session_closed"}
                    for event in adapter._store.read_events(original.id)
                )
            finally:
                await recovered.aclose()
        print(
            "PASS: real CLI reopens the same empty Cleo task twice; no prompt sent"
        )


if __name__ == "__main__":
    asyncio.run(asyncio.wait_for(main(), timeout=45))
