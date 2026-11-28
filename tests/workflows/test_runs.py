"""A `/workflow` turn against a real session store and a harness that answers from a table."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from cleo.config.settings import ProductivitySettings
from cleo.desktop.projection import timeline_from_events
from cleo.desktop.service import DesktopService
from cleo.desktop.workflow_runs import node_options
from cleo.harnesses.capabilities import Capability
from cleo.sessions.store import SessionStore
from cleo.workflows.engine import NodeFailed
from cleo.workflows.models import Node
from tests.workflows.test_workflows import agent, graph

KINDS = {"codex": "codex_sdk", "claude": "claude_sdk", "opencode": "acp"}


class Harnesses:
    """Stands in for the harness adapter: a session per call, a reply per node."""

    def __init__(self, store: SessionStore, replies: dict[str, object]) -> None:
        self.store = store
        self.replies = replies
        self.options: dict[str, dict] = {}
        self.prompts: dict[str, str] = {}
        self.closed: list[str] = []
        self.asked: list[str] = []
        self.count = 0

    async def create_session(self, provider, *, project_path, model, project):
        self.count += 1
        session_id = f"node-{self.count}"
        self.store.create_session(session_id=session_id, space="productivity", project=project,
                                  provider=provider, owner_type="user", cwd=project_path)
        self.options[session_id] = {"model": model}
        return SimpleNamespace(id=session_id)

    def session_provider_type(self, session_id):
        return KINDS[self.store.load_manifest(session_id)["provider"]]

    def session_capabilities(self, _session_id):
        return frozenset({Capability.USER_APPROVALS})

    async def enable_user_approvals(self, session_id):
        self.asked.append(session_id)

    async def update_session_options(self, session_id, **changes):
        self.options[session_id].update(changes)

    async def prompt(self, session_id, prompt, on_event=None):
        self.prompts[session_id] = prompt
        role = self.store.load_manifest(session_id)["title"].split(" · ")[0]
        reply = self.replies.get(role, f"{role} done")
        if isinstance(reply, list):
            reply = reply.pop(0) if len(reply) > 1 else reply[0]
        if isinstance(reply, Exception):
            return SimpleNamespace(status="failed", response="", error=str(reply))
        return SimpleNamespace(status="completed", response=reply, error=None)

    async def cancel(self, _session_id):
        pass

    async def close(self, session_id):
        self.closed.append(session_id)


@pytest.fixture
def desk(tmp_path):
    store = SessionStore(tmp_path / "memory", tmp_path / "memory" / "sessions.sqlite3")
    settings = SimpleNamespace(DATA_DIR=tmp_path / "data", MEMORY_DIR=tmp_path / "memory",
                               productivity=ProductivitySettings())
    harnesses = Harnesses(store, {})
    service = DesktopService(settings_model=settings, store=store, runtime=SimpleNamespace(),
                             adapter=harnesses)
    service.get_productivity_models = AsyncMock(return_value={
        "models": [{"id": "opus", "supportedEfforts": ["high"]}]})
    store.create_session(session_id="talk", space="productivity", project="general",
                         provider="codex", owner_type="user", cwd=str(tmp_path))
    store.update_manifest("talk", runtime_options={"model": "gpt", "effort": "low"})
    return SimpleNamespace(service=service, store=store, harnesses=harnesses)


def turn(desk, prompt: str) -> list[dict]:
    seen: list[dict] = []

    async def emit(event: dict) -> None:
        seen.append(json.loads(json.dumps(event)))

    asyncio.run(desk.service._workflow_runs.turn(desk.store.load_manifest("talk"), prompt, emit))
    return seen


def save(desk, definition) -> None:
    asyncio.run(desk.service.save_workflow(definition=definition.model_dump(by_alias=True)))


def card(desk) -> dict:
    items = [item for item in timeline_from_events(desk.store.read_events("talk"))
             if item["type"] == "workflow"]
    assert len(items) == 1, "a run is one item, however many times it changed"
    return items[0]["run"]


def test_a_workflow_runs_in_the_conversation_with_a_session_per_node(desk) -> None:
    save(desk, graph([agent("plan", harness="claude", model="opus", effort="high"),
                      agent("do", access="write", permission="ask")],
                     ["start>plan", "plan>do", "do>end"]))
    seen = turn(desk, "/workflow wf add paging to the export")

    assert [event["type"] for event in seen][:2] == ["turn-started", "upsert-item"]
    assert seen[0]["item"]["content"] == "add paging to the export"
    assert seen[-1] == {"type": "done", "summary": "w"}
    assert seen[-2]["item"]["role"] == "assistant" and seen[-2]["item"]["content"] == "do done"

    run = card(desk)
    assert run["status"] == "completed" and "progress" not in run and "threadId" not in run
    plan, do = run["sessions"]
    assert (plan["threadId"], plan["executor"]) == ("node-1", "claude · opus")
    assert plan["status"] == "done"
    assert do["executor"] == "codex · gpt", "a node without a harness follows the conversation"

    # Each node session is a conversation of its own under the one the workflow ran in.
    first = desk.store.load_manifest("node-1")
    assert (first["parent_session_id"], first["title"]) == ("talk", "plan")
    assert first["workflow_session"] == {"runId": run["id"], "nodeId": "plan",
                                         "sessionId": plan["id"]}
    # Reading is enforced; a node that may edit runs under its permission preset.
    assert desk.harnesses.options["node-1"] == {"model": "opus", "approval_mode": "plan",
                                                "effort": "high"}
    assert desk.harnesses.options["node-2"] == {"model": "gpt", "sandbox": "workspace-write",
                                                "approval_mode": "user", "effort": "low"}
    assert desk.harnesses.asked == ["node-2"] and desk.harnesses.closed == ["node-1", "node-2"]
    assert "From plan:\nplan done" in desk.harnesses.prompts["node-2"]

    talk = desk.store.load_manifest("talk")
    assert (talk["status"], talk["title"]) == ("completed", "add paging to the export")
    messages = [item for item in timeline_from_events(desk.store.read_events("talk"))
                if item["type"] == "message"]
    assert [(item["role"], item["content"]) for item in messages] == [
        ("user", "add paging to the export"), ("assistant", "do done")]


def test_a_failed_run_is_taken_up_again_in_the_same_card(desk) -> None:
    save(desk, graph([agent("a"), agent("b")], ["start>a", "a>b", "b>end"]))
    desk.harnesses.replies["b"] = RuntimeError("usage limit")
    seen = turn(desk, "/workflow wf review the change")
    run = card(desk)
    assert run["status"] == "failed" and "usage limit" in run["error"]
    assert [session["status"] for session in run["sessions"]] == ["done"] + ["failed"] * 4
    assert seen[-1]["type"] == "error" and desk.store.load_manifest("talk")["status"] == "failed"

    desk.harnesses.replies["b"] = "b at last"
    seen = turn(desk, "/workflow retry")
    assert seen[0]["item"]["content"] == "从失败处重试"
    run = card(desk)
    assert (run["status"], run["result"]) == ("completed", "b at last")
    assert desk.harnesses.count == 6, "only the node that failed ran again"
    with pytest.raises(ValueError):
        turn(desk, "/workflow retry")


def test_a_run_the_app_quit_under_is_paused_and_continued(desk) -> None:
    save(desk, graph([agent("a"), agent("b")], ["start>a", "a>b", "b>end"]))
    runs = desk.service._workflow_runs
    turn(desk, "/workflow wf the task")
    run = runs.load(card(desk)["id"])
    # As the files were when the app quit while b was running.
    run.update(status="running")
    run["sessions"][-1].update(status="running")
    run["progress"]["done"] = ["a"]
    for key in ("result", "finishedAt"):
        run.pop(key)
    runs._save(run)
    runs._marker(run["id"]).touch()
    runs._swept = False

    runs.sweep()
    paused = card(desk)
    assert (paused["status"], paused["sessions"][-1]["status"]) == ("paused", "cancelled")
    assert not runs._marker(run["id"]).exists()
    seen = turn(desk, "/workflow retry")
    assert seen[0]["item"]["content"] == "继续"
    assert card(desk)["status"] == "completed" and desk.harnesses.count == 3


def test_what_cannot_run_is_refused_before_anything_is_written(desk) -> None:
    save(desk, graph([agent("a")], ["start>a"]))
    before = len(desk.store.read_events("talk"))
    for prompt in ("/workflow missing do it", "/workflow wf", "/workflow wf do it",
                   "/workflow retry"):
        with pytest.raises(ValueError):
            turn(desk, prompt)
    assert len(desk.store.read_events("talk")) == before and desk.harnesses.count == 0


def test_a_nodes_limits_become_native_options() -> None:
    reader = Node(id="n", role="Reader")
    writer = Node(id="n", role="Writer", access="write", permission="review")
    assert node_options("codex_sdk", reader, effort=None, speed="fast") == {
        "sandbox": "read-only", "approval_mode": "deny_all", "service_tier": "fast"}
    assert node_options("antigravity_sdk", reader, effort=None, speed=None) == {
        "approval_mode": "deny_all"}
    with pytest.raises(NodeFailed):
        node_options("acp", reader, effort=None, speed=None)
    assert node_options("claude_sdk", writer, effort="high", speed=None) == {
        "approval_mode": "auto", "effort": "high"}
    assert node_options("antigravity_sdk", writer, effort=None, speed=None) == {
        "approval_mode": "user"}, "a preset the harness lacks falls back to asking"
    assert node_options("acp", writer, effort=None, speed=None) == {}


def test_a_workflow_handed_back_in_a_reply_becomes_a_card(desk) -> None:
    from tests.workflows.test_authoring import REPLY

    def say(text: str) -> list[dict]:
        desk.store.append_events(
            space="productivity", project="general", session_id="talk", events=[
                {"type": "user_message", "actor": "agent", "content": "/create-workflow twice"},
                {"type": "assistant_message", "actor": "codex", "content": text}])
        seen: list[dict] = []

        async def emit(event: dict) -> None:
            seen.append(event)

        manifest = desk.store.load_manifest("talk")
        asyncio.run(desk.service._workflow_runs.propose(manifest, emit))
        return seen

    assert say("What should the reviewers look at?") == []
    seen = say(REPLY)
    assert seen[0]["item"]["type"] == "workflow-proposal"
    assert seen[0]["item"]["definition"]["name"] == "Plan, refute, build"
    cards = [item for item in timeline_from_events(desk.store.read_events("talk"))
             if item["type"] == "workflow-proposal"]
    assert [card["definition"]["origin"] for card in cards] == ["drafted"]
    assert asyncio.run(desk.service.get_workflow_library())["workflows"] == [], "nothing is saved"
    assert say("```cleo-workflow\n{}\n```")[0]["item"]["type"] == "notice"


def test_a_node_is_drafted_in_a_session_that_reads_and_is_not_kept(desk, tmp_path) -> None:
    desk.service.settings.active_directory_profile = SimpleNamespace(root_path=tmp_path)
    desk.service.settings.productivity = SimpleNamespace(default_provider="codex")
    definition = graph([agent("Planner"), agent("blank")],
                       ["start>Planner", "Planner>blank", "blank>end"]).model_dump(by_alias=True)

    async def prompt(session_id, request, on_event=None):
        desk.harnesses.prompts[session_id] = request
        fields = '{"role": "Reviewer", "instructions": "Find gaps.", "access": "read"}'
        return SimpleNamespace(status="completed", error=None,
                               response=f"```cleo-node\n{fields}\n```")

    desk.harnesses.prompt = prompt
    fields = asyncio.run(desk.service.draft_workflow_node(
        intent="check the plan", definition=definition, node_id="blank"))
    assert fields == {"role": "Reviewer", "instructions": "Find gaps.", "access": "read"}
    assert "receives from: Planner" in desk.harnesses.prompts["node-1"]
    assert desk.harnesses.options["node-1"]["sandbox"] == "read-only"
    assert desk.harnesses.closed == ["node-1"]
    assert [row["id"] for row in desk.store.list_sessions()] == ["talk"]
    with pytest.raises(ValueError):
        asyncio.run(desk.service.draft_workflow_node(intent=" ", definition=definition,
                                                     node_id="blank"))


def test_a_node_apart_from_the_others_gets_a_worktree_that_is_kept(tmp_path) -> None:
    import subprocess

    from cleo.desktop.workflow_runs import add_worktree

    def git(*arguments: str) -> str:
        return subprocess.run(["git", "-C", str(tmp_path), *arguments], check=True,
                              capture_output=True, text=True).stdout.strip()

    git("init", "-q", "-b", "main")
    (tmp_path / "a.txt").write_text("a\n", encoding="utf-8")
    git("add", "a.txt")
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "first")
    path, branch = add_worktree(str(tmp_path), "abc123")
    assert branch == "cleo/workflow-abc123"
    assert (tmp_path / ".cleo/worktrees/workflow-abc123/a.txt").is_file()
    assert path.endswith("workflow-abc123") and branch in git("branch", "--list", branch)
    with pytest.raises(NodeFailed):
        add_worktree(str(tmp_path), "abc123")


def test_missing_model_or_unsupported_inherited_handoff_stops_before_the_first_node(desk):
    save(desk, graph([agent("first"), agent("later", harness="claude", model="absent")],
                     ["start>first", "first>later", "later>end"]))
    with pytest.raises(ValueError):
        turn(desk, "/workflow wf verify")
    assert desk.harnesses.count == 0
    save(desk, graph([agent("plan"), agent("judge")],
                     ["start>plan", "plan>judge", "judge>plan*2", "judge>end"]))
    desk.store.update_manifest("talk", provider="antigravity-sdk")
    with pytest.raises(ValueError):
        turn(desk, "/workflow wf verify")
    assert desk.harnesses.count == 0
