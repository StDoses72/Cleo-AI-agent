import ast
import inspect
import subprocess
import sys
from pathlib import Path

import cleo.cli.application as application
from cleo.agents import Agent, DreamAgent
from cleo.integrations.codex import CodexAdapter

ROOT = Path(__file__).resolve().parents[1]


def test_desktop_does_not_import_terminal_presentation() -> None:
    violations = []
    for path in (ROOT / "cleo" / "desktop").glob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            imports = (
                [node.module or ""] if isinstance(node, ast.ImportFrom)
                else [alias.name for alias in node.names] if isinstance(node, ast.Import)
                else []
            )
            for name in imports:
                if name == "cleo.cli" or name.startswith("cleo.cli."):
                    violations.append(f"{path.relative_to(ROOT)}:{node.lineno}: {name}")
    assert not violations, "Desktop must use shared services:\n" + "\n".join(violations)


def test_harness_core_imports_without_infrastructure() -> None:
    script = """
import importlib.abc
import sys

class RejectInfrastructure(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        forbidden = (
            'cleo.cli', 'cleo.desktop', 'cleo.config', 'cleo.integrations',
            'cleo.sessions.store', 'sqlite3', 'langchain_core', 'openai_codex',
            'claude_agent_sdk', 'acp', 'rich', 'textual',
        )
        if any(fullname == name or fullname.startswith(name + '.') for name in forbidden):
            raise AssertionError('Core imported infrastructure: ' + fullname)

sys.meta_path.insert(0, RejectInfrastructure())
from cleo.harnesses.service import AgentService
from cleo.harnesses.events import capture_context_usage
from cleo.sessions.ports import SessionRepository
from cleo.sessions.policy import has_user_interaction
"""
    result = subprocess.run(
        [sys.executable, "-B", "-c", script],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr


def test_primary_runtime_boundaries_are_async() -> None:
    assert inspect.iscoroutinefunction(application.amain)
    assert not inspect.iscoroutinefunction(application.main)
    assert inspect.isasyncgenfunction(Agent.stream_text)
    assert inspect.iscoroutinefunction(DreamAgent.invoke)
    assert inspect.iscoroutinefunction(CodexAdapter.start)
    assert inspect.iscoroutinefunction(CodexAdapter.reply)
