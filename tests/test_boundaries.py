import inspect

import cleo.cli.application as application
from cleo.agents import Agent, DreamAgent
from cleo.integrations.codex import CodexAdapter


def test_primary_runtime_boundaries_are_async() -> None:
    assert inspect.iscoroutinefunction(application.amain)
    assert not inspect.iscoroutinefunction(application.main)
    assert inspect.isasyncgenfunction(Agent.stream_text)
    assert inspect.iscoroutinefunction(DreamAgent.invoke)
    assert inspect.iscoroutinefunction(CodexAdapter.start)
    assert inspect.iscoroutinefunction(CodexAdapter.reply)
