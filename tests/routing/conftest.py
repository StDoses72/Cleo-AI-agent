import asyncio
from types import SimpleNamespace

import pytest

from cleo.config.settings import CodexHarnessSettings, ProductivitySettings
from cleo.harnesses.adapter import AgentAdapter
from cleo.harnesses.control import HarnessModel, SessionOptions
from cleo.harnesses.models import AgentEvent, emit_event
from cleo.harnesses.provider import ProviderSession, ProviderTurn
from cleo.routing.catalog import candidate_id
from cleo.routing.execution import RoutingService
from cleo.routing.models import CandidatePolicy, EvaluatorSettings, RoutingSettings
from cleo.sessions.store import SessionStore


class FakeProvider:
    provider_type = "codex_sdk"
    capabilities = frozenset()

    def __init__(self, name, *, behavior="complete", events=()):
        self.name, self.behavior, self.events = name, behavior, events
        self.sessions, self.prompts, self.closed, self.discoveries = {}, [], [], 0
        self.started = asyncio.Event()

    async def account_status(self):
        return SimpleNamespace(authenticated=self.behavior != "unauthenticated")

    async def list_models(self, project_path="."):
        self.discoveries += 1
        return (HarnessModel("fixture-model", "Fixture", "Offline fake", True, "high", ("high",),
                             available=True, availability_source="fixture_account_catalog"),)

    async def create_session(self, project_path, model=None):
        identifier = f"{self.name}-{len(self.sessions) + len(self.closed)}"
        self.sessions[identifier] = SessionOptions(model=model)
        return ProviderSession(identifier, identifier)

    async def resume_session(self, native_session_id, project_path, model=None):
        self.sessions[native_session_id] = SessionOptions(model=model)
        return ProviderSession(native_session_id, native_session_id)

    def session_options(self, identifier):
        return self.sessions[identifier]

    async def update_session_options(self, identifier, **updates):
        self.sessions[identifier] = SessionOptions(
            **{
                **self.sessions[identifier].as_dict(),
                **{key: value for key, value in updates.items() if value is not None},
            }
        )
        return self.sessions[identifier]

    async def prompt(self, identifier, prompt, on_event=None):
        self.prompts.append((identifier, prompt, self.sessions[identifier]))
        self.started.set()
        if self.behavior == "wait":
            await asyncio.Event().wait()
        for event in self.events:
            await emit_event(on_event, AgentEvent(provider=self.name, **event))
        if self.behavior == "failure":
            return ProviderTurn(identifier, "turn", "failed", error="network private-test-token")
        return ProviderTurn(identifier, "turn", "completed", response="Agent claims done")

    async def cancel(self, identifier):
        pass

    async def close(self, identifier):
        self.closed.append(identifier)
        self.sessions.pop(identifier, None)


@pytest.fixture
def assessment():
    return {
        "task_type": "coding",
        "complexity": "low",
        "required_capabilities": ["text"],
        "context_requirement": None,
        "uncertainty": "low",
        "failure_impact": "low",
        "acceptance_criteria": ["Configured checks pass"],
    }


@pytest.fixture
def service_factory(tmp_path):
    def create(*, policy=None, behavior="complete", events=()):
        store = SessionStore(tmp_path / "memory")
        try:
            store.load_manifest("parent")
        except FileNotFoundError:
            store.create_session(
                session_id="parent",
                space="non_productivity",
                project="project",
                provider="cleo",
                cwd=str(tmp_path),
                owner_type="user",
            )
            store.update_manifest("parent", runtime_options={"model": "main-model"})
        productivity = ProductivitySettings(
            default_provider="economy",
            providers={
                "economy": CodexHarnessSettings(model="fixture-model"),
                "strong": CodexHarnessSettings(model="fixture-model"),
            },
        )
        adapter = AgentAdapter(tmp_path, session_store=store)
        providers = [
            FakeProvider("economy", behavior=behavior, events=events),
            FakeProvider("strong"),
        ]
        for provider in providers:
            adapter.register(provider)
        base = RoutingSettings(
            enabled=True,
            evaluator=EvaluatorSettings(mode="main"),
            fallback_candidate=candidate_id("economy", "fixture-model", "high"),
            candidates={
                candidate_id("economy", "fixture-model", "high"): CandidatePolicy(tier="economy"),
                candidate_id("strong", "fixture-model", "high"): CandidatePolicy(tier="strong"),
            },
        )
        if policy:
            base = RoutingSettings.model_validate({**base.model_dump(), **policy})
        service = RoutingService(
            adapter, store, productivity, base, tmp_path / "routing-state", "parent"
        )
        return service, providers

    return create
