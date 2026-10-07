"""B7 — Process entry points other than the desktop protocol.

Harnesses launch Cleo's MCP servers with the exact command line Cleo hands them, the
desktop shell probes the backend with one-off Python processes, and the ``cleo`` console
script is a public command. Their surfaces are contracts independent of internal layout.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from typing import Any

from fastmcp import Client
from fastmcp.client.transports import StdioTransport

from .support.backend import REPO_ROOT, Backend
from .support.golden import assert_golden
from .support.home import CleoHome
from .support.views import read_jsonl


def _tool_catalog(command: str, args: list[str], env: dict[str, str], cwd: str) -> Any:
    async def collect() -> Any:
        transport = StdioTransport(command=command, args=args, env=env, cwd=cwd,
                                   keep_alive=False)
        async with Client(transport) as client:
            tools = await client.list_tools()
            return [
                {
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.inputSchema,
                    "annotations": tool.annotations.model_dump(exclude_none=True)
                    if tool.annotations else None,
                }
                for tool in sorted(tools, key=lambda item: item.name)
            ]

    return asyncio.run(collect())


def _isolated_env(home: CleoHome) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("CLEO_", "CODEX_", "CLAUDE_"))}
    env.update(home.env())
    return env


def test_what_cleo_hands_to_a_harness(
    backend: Backend, cleo_home: CleoHome, replacements: dict,
) -> None:
    """The MCP servers, working directory and prompt envelope given to an ACP harness."""
    thread = backend.call("create_thread", space="productivity",
                          project_id_value="productivity:workspace",
                          project_path=str(cleo_home.workspace))
    backend.run_turn(thread["id"], "Check the build")
    backend.kill()
    requests = read_jsonl(cleo_home.acp_log)
    session = next(entry for entry in requests if entry["method"] == "session/new"
                   and entry["mcp_servers"])
    catalogs = {
        server["name"]: _tool_catalog(server["command"], server["args"],
                                      {**_isolated_env(cleo_home),
                                       **{item["name"]: item["value"]
                                          for item in server.get("env", [])}},
                                      str(cleo_home.workspace))
        for server in session["mcp_servers"]
    }
    assert_golden("entrypoints/harness_handoff", {
        "requests": requests,
        "mcp_tool_catalogs": catalogs,
    }, replacements)


def test_codex_mcp_server_catalog(cleo_home: CleoHome, replacements: dict) -> None:
    catalog = _tool_catalog(sys.executable, ["-m", "cleo.mcp.codex_server"],
                            _isolated_env(cleo_home), str(REPO_ROOT))
    assert_golden("entrypoints/codex_mcp", catalog, replacements)


def test_agent_tool_server_catalogs(cleo_home: CleoHome, replacements: dict) -> None:
    catalogs = {
        mode: _tool_catalog(sys.executable,
                            ["-m", "cleo.mcp.agent_server", "--mode", mode,
                             "--project-path", str(cleo_home.workspace),
                             "--scope", json.dumps({"space": "non_productivity",
                                                    "project": "general"})],
                            _isolated_env(cleo_home), str(REPO_ROOT))
        for mode in ("chat", "dream", "dream_extract")
    }
    assert_golden("entrypoints/agent_tool_servers", catalogs, replacements)


def test_desktop_probes_and_cli_surface(cleo_home: CleoHome, replacements: dict) -> None:
    env = {**_isolated_env(cleo_home), "PYTHONPATH": str(REPO_ROOT)}

    def run(*args: str) -> dict[str, Any]:
        result = subprocess.run([sys.executable, *args], cwd=REPO_ROOT, env=env,
                                capture_output=True, text=True, encoding="utf-8", timeout=120)
        return {"exit": result.returncode, "stdout": result.stdout.replace("\r\n", "\n")}

    assert_golden("entrypoints/cli", {
        # ui/electron/dependencies.mjs and setup-manager.mjs import-probe the backend.
        "server_import_probe": run("-c", "from cleo.desktop.server import main")["exit"],
        # The ``cleo`` console script calls cleo.cli.application:main.
        "console_script_help": run("-c", "import sys; sys.argv = ['cleo', '--help']; "
                                   "from cleo.cli.application import main; main()"),
        # Pinned quirk: the module has no __main__ guard, so ``-m`` does nothing.
        "module_run_help": run("-m", "cleo.cli.application", "--help"),
        "main_py_help": run("main.py", "--help"),
        "dream_worker_bad_args": run("-m", "cleo.cli.dream_worker")["exit"],
        "dream_worker_bad_json": run("-m", "cleo.cli.dream_worker", "not-json")["exit"],
    }, replacements)
