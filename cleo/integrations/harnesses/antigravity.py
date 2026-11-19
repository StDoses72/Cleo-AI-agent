"""Google Antigravity SDK harness: Gemini development sessions through ``google-antigravity``.

The SDK runs its own ``localharness`` process per session and authenticates with a Gemini API
key or Google Cloud (Vertex) credentials. It has no Google-account sign-in; a personal Google AI
Pro / Ultra subscription is used through the Antigravity CLI instead (``agy acp``, an ACP
harness). See docs/adr/0016-antigravity-sdk-and-cli-harnesses.md.
"""

from __future__ import annotations

import asyncio
import os
import secrets
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from cleo.harnesses.approvals import PermissionBroker
from cleo.harnesses.capabilities import PROVIDER_CAPABILITIES
from cleo.harnesses.control import HarnessModel, SessionOptions
from cleo.harnesses.models import AgentEvent, EventCallback, emit_event
from cleo.harnesses.provider import ProviderSession, ProviderTurn

ANTIGRAVITY_APPROVAL_MODES = ("user", "auto_allow", "deny_all")
ANTIGRAVITY_AUTH = ("api_key", "vertex")
# Gemini models the SDK documents for text; the SDK has no model listing call.
ANTIGRAVITY_MODELS = (
    ("gemini-4-hydrogen", "Gemini 4 Hydrogen"),
)
_THINKING_LEVELS = ("minimal", "low", "medium", "high", "xhigh")
# Tools that only read: approved without asking, as Codex and Claude do for reads.
_READ_ONLY_TOOLS = frozenset({
    "view_file", "list_directory", "list_dir", "search_directory", "search_dir", "find_file",
    "read_url_content", "finish", "schedule", "skill_lookup",
})
_FILE_TOOLS = frozenset({"view_file", "create_file", "edit_file", "write_to_file"})


class AntigravityUnavailable(RuntimeError):
    """The SDK is missing, or neither an API key nor Google Cloud settings are present."""


def _sdk():
    """Import the SDK on first use so Cleo starts without it."""
    import importlib

    try:
        antigravity = importlib.import_module("google.antigravity")
        policy = importlib.import_module("google.antigravity.hooks.policy")
    except ImportError as error:
        raise AntigravityUnavailable(
            "The Google Antigravity SDK is not installed (pip install google-antigravity)."
        ) from error
    return antigravity, policy


def _tool_name(call: Any) -> str:
    name = getattr(call, "name", "")
    return str(getattr(name, "value", name))


@dataclass(slots=True)
class _Runtime:
    """One SDK agent: its conversation, Cleo's options and the turn being run."""

    agent: Any
    project: Path
    options: SessionOptions
    approvals: PermissionBroker
    approval_explicit: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    active: bool = False
    callback: EventCallback | None = None
    events: list[AgentEvent] = field(default_factory=list)


class AntigravityProvider:
    """Purpose: Run Gemini development sessions through the Antigravity SDK.

    Input: auth ("api_key" reads ``GEMINI_API_KEY``; "vertex" uses Application Default
    Credentials with a project and location), the default model and approval mode.
    Output: an ``AgentProvider`` with streaming text and thinking, tool events, approvals routed
    to Cleo, cancel, and resume by conversation id from a Cleo-owned save directory.
    """

    provider_type = "antigravity_sdk"
    capabilities = PROVIDER_CAPABILITIES["antigravity_sdk"]

    def __init__(
        self,
        name: str = "antigravity",
        *,
        default_model: str | None = None,
        auth: str = "api_key",
        project: str | None = None,
        location: str | None = None,
        approval_mode: str = "user",
        save_root: Path | None = None,
        environment: dict[str, str] | None = None,
    ) -> None:
        if auth not in ANTIGRAVITY_AUTH:
            raise ValueError(f"Unsupported Antigravity auth: {auth}")
        if approval_mode not in ANTIGRAVITY_APPROVAL_MODES:
            raise ValueError(f"Unsupported Antigravity approval mode: {approval_mode}")
        self.name = name
        self._default_model = default_model
        self._auth = auth
        self._project = project
        self._location = location
        self._approval_mode = approval_mode
        self._environment = environment
        if save_root is None:
            from cleo.config.settings import APP_HOME

            save_root = APP_HOME / "data" / "antigravity"
        self._save_root = save_root
        self._sessions: dict[str, _Runtime] = {}

    # Connection and models ------------------------------------------------------------

    def auth_status(self) -> dict[str, Any]:
        """Purpose: Say how this harness authenticates and who is billed, without a request.

        Output: ``{"auth", "billing", "ready", "reason"}``; reason names what is missing.
        """
        env = self._environment if self._environment is not None else os.environ
        if self._auth == "vertex":
            project = self._project or env.get("GOOGLE_CLOUD_PROJECT")
            location = self._location or env.get("GOOGLE_CLOUD_LOCATION")
            missing = [name for name, value in (("GOOGLE_CLOUD_PROJECT", project),
                                                ("GOOGLE_CLOUD_LOCATION", location)) if not value]
            return {"auth": "vertex", "billing": "google_cloud_project", "ready": not missing,
                    "reason": f"Set {' and '.join(missing)} and run "
                              "`gcloud auth application-default login`." if missing else None}
        ready = bool(env.get("GEMINI_API_KEY"))
        return {"auth": "api_key", "billing": "gemini_api_key", "ready": ready,
                "reason": None if ready else "Set GEMINI_API_KEY to a Gemini API key."}

    async def check_connection(self, project_path: str) -> None:
        """Fail with an actionable reason when the SDK or credentials are missing."""
        _sdk()
        status = self.auth_status()
        if not status["ready"]:
            raise AntigravityUnavailable(status["reason"])

    async def list_models(self, project_path: str = ".") -> tuple[HarnessModel, ...]:
        """The SDK cannot list models; offer the documented default and any configured one."""
        await self.check_connection(project_path)
        known = dict(ANTIGRAVITY_MODELS)
        default = self._default_model or ANTIGRAVITY_MODELS[0][0]
        identifiers = list(dict.fromkeys([default, *known]))
        return tuple(
            HarnessModel(
                id=identifier, display_name=known.get(identifier, identifier),
                description="Gemini through the Antigravity SDK", is_default=identifier == default,
                default_effort=None, supported_efforts=_THINKING_LEVELS,
                availability_source="catalog_only",
            )
            for identifier in identifiers
        )

    # Sessions ---------------------------------------------------------------------------

    def _config(self, project: Path, model: str | None, effort: str | None,
                conversation_id: str | None, runtime_ref: list[_Runtime]) -> Any:
        antigravity, policy = _sdk()
        target = model or self._default_model or ANTIGRAVITY_MODELS[0][0]
        options = antigravity.GeminiModelOptions(
            thinking_level=antigravity.ThinkingLevel(effort) if effort else None,
        )
        endpoint = (
            antigravity.VertexEndpoint(project=self._project, location=self._location,
                                       options=options)
            if self._auth == "vertex" else antigravity.GeminiAPIEndpoint(options=options)
        )

        async def decide(call: Any, reason: str | None = None) -> bool:
            return await self._decide(runtime_ref[0], call, reason)

        self._save_root.mkdir(parents=True, exist_ok=True)
        return antigravity.LocalAgentConfig(
            models=[antigravity.ModelTarget(name=target, types=[antigravity.ModelType.TEXT],
                                            endpoint=endpoint)],
            workspaces=[str(project)],
            policies=[policy.ask_user("*", handler=decide, name="cleo")],
            conversation_id=conversation_id,
            session_continuation_mode=(
                antigravity.types.SessionContinuationMode.RESUME if conversation_id else None
            ),
            save_dir=str(self._save_root),
            env=self._environment,
        )

    async def _start(self, project_path: str, model: str | None, effort: str | None,
                     conversation_id: str | None) -> tuple[str, _Runtime]:
        await self.check_connection(project_path)
        antigravity, _policy = _sdk()
        project = Path(project_path).expanduser().resolve()
        holder: list[_Runtime] = []
        agent = antigravity.Agent(self._config(project, model, effort, conversation_id, holder))
        runtime = _Runtime(
            agent=agent, project=project,
            options=SessionOptions(model=model or self._default_model or ANTIGRAVITY_MODELS[0][0],
                                   effort=effort, approval_mode=self._approval_mode),
            approvals=PermissionBroker(self.name),
        )
        holder.append(runtime)
        await agent.__aenter__()
        session_id = conversation_id or agent.conversation_id or f"agy_{secrets.token_hex(8)}"
        return session_id, runtime

    async def create_session(self, project_path: str, model: str | None = None,
                             **_kwargs: Any) -> ProviderSession:
        session_id, runtime = await self._start(project_path, model, None, None)
        self._sessions[session_id] = runtime
        return ProviderSession(id=session_id, native_id=None)

    async def resume_session(self, native_session_id: str, project_path: str,
                             model: str | None = None, **_kwargs: Any) -> ProviderSession:
        session_id, runtime = await self._start(project_path, model, None, native_session_id)
        self._sessions[session_id] = runtime
        return ProviderSession(id=session_id, native_id=native_session_id)

    def session_native_id(self, session_id: str) -> str | None:
        runtime = self._sessions[session_id]
        return runtime.agent.conversation_id or None

    def session_options(self, session_id: str) -> SessionOptions:
        return self._sessions[session_id].options

    async def update_session_options(self, session_id: str, *, model: str | None = None,
                                     effort: str | None = None, approval_mode: str | None = None,
                                     sandbox: str | None = None, **_kwargs: Any) -> SessionOptions:
        """Approvals change at once; a model or thinking change restarts the agent on the same
        conversation before the next turn (the SDK fixes both when the agent starts)."""
        if sandbox is not None:
            raise ValueError("The Antigravity harness does not expose sandbox controls.")
        if approval_mode is not None and approval_mode not in ANTIGRAVITY_APPROVAL_MODES:
            raise ValueError(f"Unsupported Antigravity approval mode: {approval_mode}")
        if effort is not None and effort not in _THINKING_LEVELS:
            raise ValueError(f"Unsupported Gemini thinking level: {effort}")
        runtime = self._sessions[session_id]
        async with runtime.lock:
            if approval_mode is not None:
                runtime.options = replace(runtime.options, approval_mode=approval_mode)
                runtime.approval_explicit = True
            changed = ((model is not None and model != runtime.options.model)
                       or (effort is not None and effort != runtime.options.effort))
            if changed:
                conversation = runtime.agent.conversation_id or None
                next_model = model or runtime.options.model
                next_effort = effort or runtime.options.effort
                holder = [runtime]
                antigravity, _policy = _sdk()
                agent = antigravity.Agent(self._config(
                    runtime.project, next_model, next_effort, conversation, holder))
                await runtime.agent.__aexit__(None, None, None)
                await agent.__aenter__()
                runtime.agent = agent
                runtime.options = replace(runtime.options, model=next_model, effort=next_effort)
            return runtime.options

    async def enable_user_approvals(self, session_id: str) -> None:
        runtime = self._sessions[session_id]
        runtime.approvals.enabled = True
        if not runtime.approval_explicit:
            runtime.options = replace(runtime.options, approval_mode="user")

    async def resolve_approval(self, session_id: str, approval_id: str, decision: str) -> dict:
        return await self._sessions[session_id].approvals.resolve(approval_id, decision)

    # Approvals --------------------------------------------------------------------------

    def _outside_workspace(self, runtime: _Runtime, call: Any) -> bool:
        if _tool_name(call) not in _FILE_TOOLS:
            return False
        raw = getattr(call, "canonical_path", None) or next(
            (call.args.get(key) for key in ("path", "file_path", "TargetFile")
             if isinstance(getattr(call, "args", None), dict) and call.args.get(key)), None)
        if not raw:
            return False
        try:
            return not Path(str(raw)).expanduser().resolve().is_relative_to(runtime.project)
        except (OSError, ValueError):
            return True

    async def _decide(self, runtime: _Runtime, call: Any, reason: str | None) -> bool:
        """Purpose: Cleo's approval policy for one SDK tool call.

        Output: True to run it. Reads run; file tools outside the workspace never run; then the
        session's mode decides: auto_allow runs, deny_all refuses, user asks in Cleo.
        """
        name = _tool_name(call)
        if self._outside_workspace(runtime, call):
            return False
        if name in _READ_ONLY_TOOLS:
            return True
        mode = runtime.options.approval_mode or "user"
        args = dict(getattr(call, "args", None) or {})
        command = str(args.get("CommandLine") or args.get("command_line") or args.get("command")
                      or name)
        request = runtime.approvals.request(
            method="antigravity/tool", itemId=str(getattr(call, "id", "") or ""),
            cwd=str(runtime.project), command=command, permissions=args,
            title="允许此工具操作？", reason=reason or "由 Antigravity 请求。",
            availableDecisions=["accept", "decline", "cancel"],
        )
        if mode == "user":
            decision = await runtime.approvals.ask(request)
        else:
            decision = "accept" if mode == "auto_allow" else "decline"
            await runtime.approvals.record(request, decision, source="policy", policy=mode)
        return decision in {"accept", "acceptForSession"}

    # Turns ------------------------------------------------------------------------------

    async def _emit(self, runtime: _Runtime, event_type: str, *, text: str | None = None,
                    native: str, payload: dict[str, Any]) -> None:
        event = AgentEvent(provider=self.name, type=event_type, text=text, data={
            "provider_event_type": native, "schema_version": 1, "payload": payload,
        })
        runtime.events.append(event)
        await emit_event(runtime.callback, event)

    async def _approval_event(self, runtime: _Runtime, event: AgentEvent) -> None:
        runtime.events.append(event)
        await emit_event(runtime.callback, event)

    async def prompt(self, session_id: str, prompt: str,
                     on_event: EventCallback | None = None) -> ProviderTurn:
        """Purpose: Run one turn and stream it as Cleo events.

        Output: the turn's status ("completed", "cancelled" or "failed"), its reply and events.
        Thinking and text arrive as deltas; each tool call is reported once when it starts and
        once with its result.
        """
        runtime = self._sessions[session_id]
        async with runtime.lock:
            runtime.callback = on_event
            runtime.events = []
            runtime.approvals.callback = lambda event: self._approval_event(runtime, event)
            runtime.active = True
            reply: list[str] = []
            started_tools: set[str] = set()
            status, error = "completed", None
            conversation = runtime.agent.conversation
            try:
                await conversation.send(prompt)
                async for step in conversation.receive_steps():
                    await self._step(runtime, step, reply, started_tools)
                    if str(getattr(step.status, "value", step.status)).lower() == "error" \
                            and step.depth == 0 and step.error:
                        status, error = "failed", step.error
            except asyncio.CancelledError:
                await conversation.cancel()
                raise
            except Exception as failure:  # The SDK raises its own cancelled/execution errors.
                kind = type(failure).__name__
                status = "cancelled" if "Cancelled" in kind else "failed"
                error = None if status == "cancelled" else str(failure)
            finally:
                runtime.active = False
                await runtime.approvals.cancel_all()
                runtime.approvals.callback = None
                runtime.callback = None
        return ProviderTurn(
            native_session_id=runtime.agent.conversation_id or None,
            turn_id=f"agy_{secrets.token_hex(6)}", status=status,
            response="".join(reply) or None, error=error, events=tuple(runtime.events),
        )

    async def _step(self, runtime: _Runtime, step: Any, reply: list[str],
                    started_tools: set[str]) -> None:
        """Translate one SDK step: deltas from the root agent, tool calls and their results."""
        root = not step.parent_trajectory_id and step.depth == 0
        source = str(getattr(step.source, "value", step.source)).lower()
        target = str(getattr(step.target, "value", step.target)).lower()
        if root and source.endswith("model") and target.endswith("user"):
            if step.thinking_delta:
                await self._emit(runtime, "thought", text=step.thinking_delta,
                                 native="thinking_delta", payload={"step": step.step_index})
            if step.content_delta:
                reply.append(step.content_delta)
                await self._emit(runtime, "assistant_message_chunk", text=step.content_delta,
                                 native="content_delta", payload={"step": step.step_index})
        for call in step.tool_calls or ():
            call_id = str(call.id or f"{step.trajectory_id}:{step.step_index}:{_tool_name(call)}")
            payload = {"toolCallId": call_id, "title": _tool_name(call), "rawInput": call.args,
                       "status": str(getattr(step.status, "value", step.status)).lower(),
                       "depth": step.depth}
            if call_id not in started_tools:
                started_tools.add(call_id)
                await self._emit(runtime, "tool_call", native="tool_call", payload=payload)
            state = payload["status"]
            if state in {"done", "error", "completed"}:
                await self._emit(runtime, "tool_result", native="tool_call_update", payload={
                    **payload, "error": step.error or None, "content": step.content or None,
                })

    async def cancel(self, session_id: str) -> None:
        runtime = self._sessions[session_id]
        await runtime.approvals.cancel_all()
        if runtime.active:
            await runtime.agent.conversation.cancel()

    async def close(self, session_id: str) -> None:
        runtime = self._sessions.pop(session_id, None)
        if runtime is None:
            return
        if runtime.active:
            await runtime.agent.conversation.cancel()
        await runtime.approvals.cancel_all()
        await runtime.agent.__aexit__(None, None, None)
