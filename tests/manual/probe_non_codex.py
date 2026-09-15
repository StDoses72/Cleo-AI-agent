"""Opt-in real harness probes using temporary Cleo data and the existing vendor login.

Run with the installed Cleo Python: tests/manual/probe_non_codex.py cli|sdk|mcp.
These backend probes do not mark desktop/manual acceptance cases as passed.
"""

import asyncio
import json
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


def report(**data):
    """Purpose: Print bounded, redacted probe evidence without raw protocol logs.
    Input: Only selected status fields and diagnostic strings.
    Output: One JSON line on stdout.
    """
    from cleo.integrations.runtime_diagnostics import diagnostic_text

    print(json.dumps({k: diagnostic_text(v) if isinstance(v, str) else v
                      for k, v in data.items()}, ensure_ascii=False), flush=True)


async def probe(mode, root, profile_data):
    """Purpose: Check real transports against disposable fixtures.
    Input: Probe mode, temporary root and the selected CLI profile's public fields.
    Output: Status evidence; no Cleo thread or live data is created or changed.
    """
    from cleo.config.settings import AgentProfile
    from cleo.integrations.subscriptions import AgentMcp, inspect_connection

    profile = AgentProfile(**profile_data)
    project = root / "project"
    project.mkdir()
    (project / "probe.txt").write_text("CLEO_MCP_OK", encoding="utf-8")
    mcp = AgentMcp(profile, project, "Use only the requested read-only tools.")
    if mode == "mcp":
        from fastmcp import Client
        from fastmcp.client.transports import StdioTransport

        # This transport supplies the same inherited environment as the actual CLI.
        transport = StdioTransport(command=sys.executable, args=mcp.args,
                                   env=dict(os.environ), cwd=str(project), keep_alive=False)
        async with asyncio.timeout(25), Client(transport) as client:
            tools = await client.list_tools()
            result = await client.call_tool("read_file", {"path": "probe.txt"})
            report(stage="mcp", tool_count=len(tools),
                   read_fixture_ok="CLEO_MCP_OK" in str(result))
        return

    if mode == "cli":
        from cleo.integrations.claude_cli import ClaudeCliProvider

        connection = await inspect_connection(profile)
        report(stage="connection", status=connection["status"],
               model_count=len(connection["models"]), model_turn_checked=False)
        provider = ClaudeCliProvider(profile, mcp)
        original_spawn = asyncio.create_subprocess_exec

        class ObservedOutput:
            def __init__(self, stream):
                self.stream = stream

            async def __aiter__(self):
                async for line in self.stream:
                    try:
                        payload = json.loads(line)
                    except ValueError:
                        payload = {}
                    if payload.get("type") == "system":
                        if payload.get("subtype") == "init":
                            for server in payload.get("mcp_servers", []):
                                if server.get("name") == "cleo-tools":
                                    report(stage="cli_mcp", status=server.get("status"))
                        elif payload.get("subtype") == "api_retry":
                            report(stage="api_retry", error=str(payload.get("error")),
                                   status=str(payload.get("error_status")))
                    yield line

        async def observed_spawn(*args, **kwargs):
            process = await original_spawn(*args, **kwargs)
            if process.stdout:
                process.stdout = ObservedOutput(process.stdout)
            return process

        asyncio.create_subprocess_exec = observed_spawn
    else:
        from cleo.integrations.harnesses.claude import ClaudeProvider
        from cleo.integrations.harnesses.memory import MemoryMcp
        from cleo.sessions.store import SessionStore

        SessionStore(root / "memory")
        provider = ClaudeProvider(memory_mcp=MemoryMcp(root / "memory"))
    session = None
    try:
        async with asyncio.timeout(35):
            session = await provider.create_session(str(project))
        report(stage="session", status="created", provider=provider.name)
        prompts = [
            "Reply exactly CLEO_OK. Do not use tools. Remember the word amber.",
            ("Use mcp__cleo-tools__read_file to read probe.txt and report its content."
             if mode == "cli" else "Use Cleo memory list_threads to list the fixture threads."),
            "Which word did I ask you to remember? Do not use tools.",
        ]
        native_id = None
        for index, prompt in enumerate(prompts):
            events = []
            async with asyncio.timeout(35):
                turn = await provider.prompt(session.id, prompt, events.append)
            native_id = turn.native_session_id
            report(stage=f"turn_{index + 1}", status=turn.status,
                   has_reply=bool(turn.response), error=turn.error or "",
                   tool_calls=sum(e.type == "tool_call" for e in events),
                   tool_results=sum(e.type == "tool_result" for e in events),
                   remembered=index == 2 and "amber" in (turn.response or "").lower())
            if turn.status != "completed":
                return
        if native_id:
            await provider.close(session.id)
            session = None
            async with asyncio.timeout(35):
                session = await provider.resume_session(native_id, str(project))
                turn = await provider.prompt(session.id, prompts[-1])
            report(stage="resume", status=turn.status,
                   remembered="amber" in (turn.response or "").lower())
    finally:
        if session:
            await provider.close(session.id)


def main():
    """Purpose: Isolate all Cleo storage before importing runtime modules.
    Input: cli, sdk or mcp argument; public fields from the current Claude profile.
    Output: Probe evidence; temporary data is removed on exit.
    """
    mode = sys.argv[1] if len(sys.argv) == 2 else ""
    if mode not in {"cli", "sdk", "mcp"}:
        raise SystemExit("usage: probe_non_codex.py cli|sdk|mcp")
    config_path = os.environ.get("CLEO_CONFIG_PATH")
    raw = json.loads(Path(config_path).read_text(encoding="utf-8")) if config_path else {}
    selected = next((p for p in raw.get("profiles", {}).get("agents", {}).values()
                     if p.get("backend") == "claude_code"), {})
    profile = {"backend": "claude_code", "provider": "claude_code", "model": "default"}
    profile.update({k: selected[k] for k in ("model", "executable") if k in selected})
    with TemporaryDirectory(prefix="cleo-noncodex-", dir=Path(__file__).parent) as tmp:
        root = Path(tmp).resolve()
        config = root / "cleo.json"
        harnesses = root / "harnesses.json"
        config.write_text(json.dumps({"active_profiles": {"agent": "probe"}, "profiles": {
            "agents": {"probe": profile}, "directories": {"default": {"root_dir": str(root)}},
        }}), encoding="utf-8")
        harnesses.write_text('{}', encoding="utf-8")
        # Overrides exist only inside this disposable probe process.
        os.environ.update(CLEO_HOME=str(root), CLEO_CONFIG_PATH=str(config),
                          CLEO_HARNESSES_CONFIG_PATH=str(harnesses))
        try:
            asyncio.run(probe(mode, root, profile))
        except Exception as exc:
            report(stage="blocked", type=type(exc).__name__, error=str(exc) or "probe timeout")
            raise SystemExit(1) from None


if __name__ == "__main__":
    main()
