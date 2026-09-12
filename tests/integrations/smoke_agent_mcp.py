"""Exercise real subscription MCP startup with a packaged Python and isolated data.

Run with the bundled interpreter: python -I tests/integrations/smoke_agent_mcp.py.
No model request, vendor login, or live user data is used.
"""

import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from fastmcp import Client
from fastmcp.client.transports import StdioTransport


async def main():
    """Purpose: Reproduce import contamination at the actual DreamAgent MCP seam.
    Input: Current interpreter, source checkout, and inherited Python environment.
    Output: Successful real handshakes and unchanged fixture data, or child errors.
    """
    source = Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory(prefix="cleo-agent-handshake-") as temporary:
        root = Path(temporary)
        home = root / "home"
        home.mkdir()
        project = root / "project"
        project.mkdir()
        foreign = root / "foreign-packages"
        foreign.mkdir()
        config = home / "cleo.json"
        config.write_text(json.dumps({
            "active_profiles": {"agent": "subscription"},
            "profiles": {
                "agents": {"subscription": {
                    "backend": "codex", "provider": "codex", "model": "default",
                }},
                "directories": {"default": {"root_dir": str(project)}},
            },
        }), encoding="utf-8")
        harnesses = home / "harnesses.json"
        harnesses.write_bytes((source / "cleo/config/templates/harnesses.example.json").read_bytes())
        (home / "memory.md").write_text("Existing memory\n", encoding="utf-8")
        (home / "chat.json").write_text(
            '{"messages":["existing chat"],"future_field":{"preserve":["nonempty"]}}',
            encoding="utf-8",
        )
        (project / "brief.txt").write_text("local brief", encoding="utf-8")
        environment = {
            **os.environ,
            "CLEO_HOME": str(home),
            "CLEO_CONFIG_PATH": str(config),
            "CLEO_HARNESSES_CONFIG_PATH": str(harnesses),
        }
        before = {path.name: path.read_bytes() for path in home.iterdir()}
        bootstrap = (
            f"import sys; sys.path.insert(0, {str(source)!r}); "
            "import json; from pathlib import Path; "
            "from cleo.config.settings import AgentProfile; "
            "from cleo.integrations.subscriptions import AgentMcp; "
            "profile = AgentProfile(backend='codex', provider='codex', model='default'); "
            f"print(json.dumps({{mode: AgentMcp(profile, Path({str(project)!r}), '', mode).args "
            "for mode in ['dream_extract', 'chat']}))"
        )
        generated = subprocess.run(
            [sys.executable, "-I", "-c", bootstrap], cwd=project, env=environment,
            capture_output=True, text=True, timeout=30,
        )
        if generated.returncode:
            raise RuntimeError(generated.stderr)
        arguments = json.loads(generated.stdout)
        # An incompatible user dependency must never shadow the bundled dependency.
        poison = "raise ImportError('foreign pydantic: incompatible packaged dependency')\n"
        for scenario in ["inherited", "pythonpath", "cwd"]:
            child_env = dict(environment)
            if scenario == "pythonpath":
                (foreign / "pydantic.py").write_text(poison, encoding="utf-8")
                child_env["PYTHONPATH"] = str(foreign)
            if scenario == "cwd":
                (project / "pydantic.py").write_text(poison, encoding="utf-8")
            for mode, args in arguments.items():
                transport = StdioTransport(
                    command=sys.executable, args=args, cwd=str(project),
                    env=child_env, keep_alive=False,
                )
                async with asyncio.timeout(30):
                    async with Client(transport) as client:
                        names = {tool.name for tool in await client.list_tools()}
                        if mode == "dream_extract":
                            assert names == set(), names
                        else:
                            assert "read_file" in names, names
                            result = await client.call_tool("read_file", {"path": "/brief.txt"})
                            assert result.content[0].text == "local brief"
                print(f"PASS {mode}: {scenario}", flush=True)
        assert {path.name: path.read_bytes() for path in home.iterdir()} == before
        assert not (project / ".mcp.json").exists()
        print("PASS unchanged fixture data and no project MCP registration", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
