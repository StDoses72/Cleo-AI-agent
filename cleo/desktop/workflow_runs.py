"""A workflow run inside the turn of the conversation that started it (ADR 0020).

``/workflow <id> <task>`` starts a saved workflow; ``/workflow retry`` takes the conversation's
last run up again from the nodes that did not finish. The run holds the conversation's run slot
until it ends or is stopped. Each node's work is a session of its own under the conversation,
and every change of the run is written to the conversation's events, so the timeline shows the
same run after a reload, in another window, or after the app comes back.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import subprocess
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from cleo.desktop.projection import _message, stream_event_item
from cleo.harnesses.capabilities import Capability
from cleo.i18n import tr
from cleo.routing.permissions import NATIVE_PRESETS
from cleo.workflows.authoring import node_request, read_node, read_workflow
from cleo.workflows.engine import Handoff, NodeFailed, NodeTask, execute, leave, new_run
from cleo.workflows.handoff import node_prompt, read_reply
from cleo.workflows.models import Definition, Harness, Node
from cleo.workflows.validation import workflow_issues

Emit = Callable[[dict[str, Any]], Awaitable[None]]
RUN_ID = re.compile(r"[0-9a-f]{16}")
# What holds a node to reading, per harness type; a type that is not here cannot be held.
READ_ONLY = {
    "codex_sdk": {"sandbox": "read-only", "approval_mode": "deny_all"},
    "claude_sdk": {"approval_mode": "plan"},
    "antigravity_sdk": {"approval_mode": "deny_all"},
}


def node_options(kind: str, node: Node, *, effort: str | None, speed: str | None) -> dict[str, str]:
    """Purpose: The native session options that enforce a node's limits.

    Input: Harness type, the node and the effort and speed it runs at. Output: Options for
    ``update_session_options``. Raises NodeFailed for a node that may only read on a harness
    with nothing to hold it to that.
    """
    if node.access == "read":
        if kind not in READ_ONLY:
            raise NodeFailed(tr("workflows.cannot_hold_to_reading", p0=node.role))
        options = dict(READ_ONLY[kind])
    else:
        presets = NATIVE_PRESETS.get(kind, {})
        # A preset the harness lacks falls back to asking, never to more freedom.
        options = dict(presets.get(node.permission) or presets.get("ask") or {})
    if effort:
        options["effort"] = effort
    if speed:
        options["service_tier"] = speed
    return options


def add_worktree(cwd: str, name: str) -> tuple[str, str]:
    """Purpose: A git worktree of its own for a node that edits apart from the others.

    Output: Its path and branch, under the repository's ``.cleo/worktrees`` as the desktop's
    own worktrees are. It is kept after the run: merging it is the user's.
    """
    def git(*arguments: str) -> str:
        done = subprocess.run(["git", "-C", cwd, *arguments], capture_output=True, text=True,
                              timeout=60, check=False)
        if done.returncode:
            raise NodeFailed(done.stderr.strip() or "git worktree failed")
        return done.stdout.strip()

    root = git("rev-parse", "--show-toplevel")
    branch = f"cleo/workflow-{name}"
    path = Path(root) / ".cleo" / "worktrees" / f"workflow-{name}"
    git("worktree", "add", "-b", branch, str(path))
    return str(path), branch


def run_view(run: dict[str, Any]) -> dict[str, Any]:
    """The run as the timeline holds it: without what only the orchestrator needs."""
    private = {"progress", "threadId", "turnId"}
    return {key: value for key, value in run.items() if key not in private}


def run_item(run: dict[str, Any]) -> dict[str, Any]:
    """The run's one timeline item. It keeps the turn it started in, so a later turn that takes
    the run up again changes this item instead of adding another."""
    return {"id": f"{run['turnId']}:workflow-{run['id']}", "type": "workflow",
            "run": run_view(run), "turnId": run["turnId"]}


class WorkflowRuns:
    """Purpose: Run workflows for the desktop service and keep each run in a file of its own."""

    def __init__(self, service: Any) -> None:
        self._service = service
        self._live: set[str] = set()
        # Approval requests of node sessions that are waiting, by id: the session that asked.
        self._approvals: dict[str, str] = {}
        self._swept = False

    @property
    def _root(self) -> Path:
        return Path(self._service.settings.DATA_DIR) / "workflows" / "runs"

    def load(self, run_id: str) -> dict[str, Any] | None:
        if not RUN_ID.fullmatch(run_id or ""):
            return None
        try:
            return json.loads((self._root / f"{run_id}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _save(self, run: dict[str, Any]) -> None:
        self._root.mkdir(parents=True, exist_ok=True)
        path = self._root / f"{run['id']}.json"
        draft = path.with_suffix(".json.tmp")
        draft.write_text(json.dumps(run, ensure_ascii=False), encoding="utf-8")
        os.replace(draft, path)

    def _marker(self, run_id: str) -> Path:
        # One empty file per run under way: what a later start has to look at is only these.
        return self._root / "active" / run_id

    def _record(self, manifest: dict[str, Any], run: dict[str, Any]) -> None:
        self._save(run)
        self._service.store.append_event(
            space=str(manifest["space"]), project=str(manifest["project"]),
            session_id=str(manifest["id"]), event_type="workflow_run", actor="system",
            data={"run": run_view(run), "turn_id": run["turnId"]})

    def sweep(self) -> None:
        """Purpose: Runs the app quit under are shown as paused, once per start. Only runs that
        were under way are read."""
        if self._swept or getattr(self._service.settings, "DATA_DIR", None) is None:
            return
        self._swept = True
        active = self._root / "active"
        if not active.is_dir():
            return
        for marker in active.iterdir():
            run = self.load(marker.name)
            if marker.name in self._live:
                continue
            marker.unlink(missing_ok=True)
            if run is None or not leave(run):
                continue
            try:
                self._record(self._service.store.load_manifest(run["threadId"]), run)
            except (OSError, KeyError, ValueError):
                self._save(run)

    def approval_owner(self, approval_id: str) -> str | None:
        return self._approvals.get(approval_id)

    def approval_resolved(self, thread_id: str, approval_id: str) -> None:
        self._approvals.pop(approval_id, None)
        self._service._runs.drop_approval(thread_id, approval_id)

    async def turn(self, manifest: dict[str, Any], prompt: str, emit: Emit) -> None:
        """Purpose: One ``/workflow`` turn, from the command to the run's end.

        Input: The conversation, the command as typed and the turn's event sink. Raises
        ValueError before anything is written when there is nothing to run.
        """
        service = self._service
        self.sweep()
        target, _, task = prompt.partition(" ")[2].strip().partition(" ")
        task = task.strip()
        if target == "retry":
            run = self.load(str(manifest.get("workflow_run_id") or ""))
            if run is None or run["status"] not in {"failed", "paused"} or run["id"] in self._live:
                raise ValueError(tr("workflows.nothing_to_take_up"))
            shown = tr("workflows.continue" if run["status"] == "paused" else "workflows.retry")
        else:
            library = service._workflow_library()
            definition = library.definition(target)
            if definition is None:
                raise ValueError(tr("workflows.not_found"))
            if not task:
                raise ValueError(tr("workflows.task_required"))
            used: dict[str, set[str]] = {}
            for node in definition.nodes:
                if node.harness is not None:
                    used.setdefault(node.harness, set()).add(node.model or "")
            # Models are the harness's to know: a model it does not have fails its node.
            harnesses = [Harness(id=item["id"], read_only=item["readOnly"], tools=item["tools"],
                                 models=frozenset(used.get(item["id"], ())))
                         for item in library.view()["harnesses"]]
            issues = workflow_issues(definition, harnesses)
            if issues:
                raise ValueError(tr("workflows.cannot_run", p0=issues[0].subject or issues[0].code))
            run = new_run(definition, task, workflow_id=definition.id,
                          project_id=str(manifest["project"]))
            run["threadId"] = manifest["id"]
            shown = task
        turn_id = f"turn-{secrets.token_hex(12)}"
        run.setdefault("turnId", turn_id)
        if not manifest.get("title"):
            service.store.rename_session(manifest["id"], shown)
        service.store.append_events(
            space=str(manifest["space"]), project=str(manifest["project"]),
            session_id=str(manifest["id"]),
            events=[{"id": turn_id, "type": "user_message", "actor": "agent", "content": prompt,
                     "data": {"display_prompt": shown}},
                    {"type": "session_running", "actor": "system"}],
            manifest_updates={"status": "running", "workflow_run_id": run["id"]})
        await emit({"type": "turn-started",
                    "item": {**_message(turn_id, "user", shown, None), "turnId": turn_id}})

        async def changed(current: dict[str, Any]) -> None:
            self._record(manifest, current)
            await emit({"type": "upsert-item", "item": run_item(current)})

        async def runner(node_task: NodeTask) -> Handoff:
            return await self._run_node(manifest, emit, run, node_task)

        self._live.add(run["id"])
        self._marker(run["id"]).parent.mkdir(parents=True, exist_ok=True)
        self._marker(run["id"]).touch()
        try:
            await execute(run, runner, changed)
        finally:
            self._live.discard(run["id"])
            self._marker(run["id"]).unlink(missing_ok=True)
        if run["status"] == "completed":
            written = service.store.append_event(
                space=str(manifest["space"]), project=str(manifest["project"]),
                session_id=str(manifest["id"]), event_type="assistant_message",
                actor=str(manifest["provider"]), content=run.get("result") or "")
            await emit({"type": "upsert-item", "item": {
                **_message(written["id"], "assistant", run.get("result") or "",
                           written.get("created_at")), "turnId": turn_id}})
            service.store.set_status(manifest["id"], "completed")
        else:
            # The run's card says what failed; the conversation only needs to ask for attention.
            service.store.update_manifest(manifest["id"], status="failed")
        await emit({"type": "done", "summary": run["definition"]["name"]})

    async def propose(self, manifest: dict[str, Any], emit: Emit) -> None:
        """Purpose: After a ``/create-workflow`` turn, put the workflow the agent handed back
        into the conversation as a card. The user opens it on the canvas; saving is theirs.
        A reply without a workflow (a question back, say) adds nothing."""
        service = self._service
        turn_id, reply = "initial", ""
        for event in service.store.read_events(manifest["id"]):
            steered = (event.get("data") or {}).get("steer_id")
            if event.get("type") == "user_message" and not steered:
                turn_id, reply = str(event.get("id")), ""
            elif event.get("type") == "assistant_message" and isinstance(event.get("content"), str):
                reply = event["content"]
        try:
            definition = read_workflow(reply)
        except ValueError as error:
            await emit({"type": "upsert-item", "item": {
                "id": f"notice-{secrets.token_hex(4)}", "type": "notice", "tone": "warning",
                "title": tr("workflows.proposal_unreadable"), "detail": str(error)}})
            return
        if definition is None:
            return
        body = definition.model_dump(by_alias=True)
        written = service.store.append_event(
            space=str(manifest["space"]), project=str(manifest["project"]),
            session_id=str(manifest["id"]), event_type="workflow_proposal", actor="system",
            data={"definition": body})
        await emit({"type": "upsert-item", "item": {
            "id": f"{turn_id}:{written['id']}", "type": "workflow-proposal", "definition": body,
            "turnId": turn_id}})

    async def draft_node(self, intent: str, definition: dict[str, Any],
                         node_id: str) -> dict[str, Any]:
        """Purpose: One node's definition from a sentence, written by the default harness in a
        session that only reads and is not kept."""
        service = self._service
        intent = str(intent).strip()
        if not intent:
            raise ValueError(tr("workflows.intent_required"))
        request = node_request(intent, Definition.model_validate(definition), node_id)
        adapter = service._adapter()
        provider = service.settings.productivity.default_provider
        session = await adapter.create_session(
            provider, project_path=str(service.settings.active_directory_profile.root_path),
            model=None, project="general")
        try:
            kind = adapter.session_provider_type(session.id)
            if kind in READ_ONLY:
                await adapter.update_session_options(session.id, **READ_ONLY[kind])
            result = await adapter.prompt(session.id, request)
        finally:
            try:
                await asyncio.shield(adapter.close(session.id))
            finally:
                service.store.delete_session(session.id)
        if result.status != "completed":
            raise ValueError(result.error or result.status)
        return read_node(result.response or "")

    async def _run_node(self, manifest: dict[str, Any], emit: Emit, run: dict[str, Any],
                        task: NodeTask) -> Handoff:
        """One session of a node: opened under the conversation, held to the node's limits,
        given the node's one message, and closed whatever happens."""
        service, node, record = self._service, task.node, task.session
        adapter = service._adapter()
        parent = manifest.get("runtime_options") or {}
        own = node.harness is not None
        provider = node.harness if own else str(manifest["provider"])
        model = node.model if own else parent.get("model")
        cwd = str(manifest.get("cwd") or ".")
        if node.access == "write" and node.workspace == "worktree":
            cwd, record["branch"] = await asyncio.to_thread(add_worktree, cwd, record["id"])
        session = await adapter.create_session(provider, project_path=cwd, model=model,
                                               project=manifest["project"])
        result = None
        try:
            title = " · ".join(part for part in (
                node.role, tr("workflows.round", p0=task.round) if task.round else "",
                task.item or "") if part)
            service.store.update_manifest(
                session.id, parent_session_id=manifest["id"], title=title[:120],
                workflow_session={"runId": run["id"], "nodeId": node.id, "sessionId": record["id"]})
            record.update(threadId=session.id, executor=" · ".join(filter(None, (provider, model))))
            if task.changed:
                await task.changed()
            kind = adapter.session_provider_type(session.id)
            options = node_options(
                kind, node, effort=node.effort if own else parent.get("effort"),
                speed=node.speed if own else parent.get("service_tier"))
            asks = node.access == "write" and options.get("approval_mode") not in {None, "deny_all"}
            if asks and Capability.USER_APPROVALS in adapter.session_capabilities(session.id):
                await adapter.enable_user_approvals(session.id)
            if options:
                await adapter.update_session_options(session.id, **options)
            if node.delegation != "default":
                stored = service.store.load_manifest(session.id).get("runtime_options") or {}
                service.store.update_manifest(session.id, runtime_options={
                    **stored, "routing_mode": "auto" if node.delegation == "on" else "manual"})
            state: dict[str, Any] = {"run_id": record["id"]}

            async def on_event(event: Any) -> None:
                # The session writes its own timeline; the conversation is only told of what
                # needs the user: an action waiting for approval.
                for projected in stream_event_item(event, state):
                    if projected["type"] == "approval-request":
                        request = {**projected["request"], "threadId": manifest["id"]}
                        self._approvals[request["id"]] = session.id
                        service._runs.add_approval(manifest["id"], request)
                        await emit({"type": "approval-request", "request": request})
                    elif projected["type"] == "approval-resolved":
                        self.approval_resolved(manifest["id"], projected["response"]["id"])
                        await emit(projected)

            service._productivity_sessions[session.id] = session
            result = await adapter.prompt(session.id, node_prompt(task), on_event=on_event)
        except asyncio.CancelledError:
            try:
                await asyncio.shield(adapter.cancel(session.id))
            except Exception:  # noqa: BLE001  The stop itself must not be lost to a harness error.
                pass
            raise
        finally:
            service._productivity_sessions.pop(session.id, None)
            waiting = [key for key, owner in self._approvals.items() if owner == session.id]
            for approval_id in waiting:
                self.approval_resolved(manifest["id"], approval_id)
            try:
                await asyncio.shield(adapter.close(session.id))
            except Exception:  # noqa: BLE001  A session that will not close is not the node's failure.
                pass
        if result.status != "completed":
            raise NodeFailed(result.error or result.status)
        return read_reply(task, result.response or "")
