import asyncio
import copy

import pytest

from cleo.workflows.engine import Handoff, NodeFailed, execute, leave, new_run
from tests.workflows.test_workflows import agent, graph


class Script:
    """A runner that answers from a table and remembers what each session was handed."""

    def __init__(self, **replies) -> None:
        self.replies = replies
        self.seen: list[tuple[str, int | None, str | None, tuple]] = []
        self.active = 0
        self.most = 0

    async def __call__(self, task) -> Handoff:
        self.seen.append((task.node.id, task.round, task.item, task.inputs))
        self.active += 1
        self.most = max(self.most, self.active)
        try:
            await asyncio.sleep(0)
            reply = self.replies.get(task.node.id, f"{task.node.id} done")
            if isinstance(reply, list):
                reply = reply.pop(0) if len(reply) > 1 else reply[0]
            if isinstance(reply, Exception):
                raise reply
            if callable(reply):
                reply = reply(task)
            return reply if isinstance(reply, Handoff) else Handoff(text=reply)
        finally:
            self.active -= 1


def run_of(definition, task: str = "the task") -> dict:
    return new_run(definition, task, workflow_id=definition.id, project_id="p")


def carry(run: dict, script: Script) -> tuple[dict, list[str]]:
    statuses: list[str] = []

    async def changed(current: dict) -> None:
        statuses.append(current["status"])

    asyncio.run(execute(run, script, changed))
    return run, statuses


def test_a_chain_hands_each_reply_to_the_next_node() -> None:
    script = Script()
    definition = graph([agent("a"), agent("b")], ["start>a", "a>b", "b>end"])
    run, statuses = carry(run_of(definition), script)
    assert (run["status"], run["result"]) == ("completed", "b done")
    assert [(seen[0], seen[3]) for seen in script.seen] == [("a", ()), ("b", (("a", "a done"),))]
    assert [session["status"] for session in run["sessions"]] == ["done", "done"]
    assert statuses[0] == "running" and statuses[-1] == "completed"
    assert run["finishedAt"] >= run["startedAt"]


def test_nodes_side_by_side_run_together_and_a_join_waits_for_all() -> None:
    script = Script()
    definition = graph([agent("a"), agent("b"), agent("c")],
                       ["start>a", "start>b", "a>c", "b>c", "c>end"])
    run, _ = carry(run_of(definition), script)
    assert run["status"] == "completed" and script.most == 2
    assert script.seen[-1] == ("c", None, None, (("a", "a done"), ("b", "b done")))


def test_a_judge_sends_the_work_round_again_until_it_passes() -> None:
    script = Script(judge=[Handoff("fix it", verdict="revise"), Handoff("fine", verdict="pass")])
    definition = graph([agent("plan"), agent("judge"), agent("do")],
                       ["start>plan", "plan>judge", "judge>do", "do>end", "judge>plan*3"])
    run, _ = carry(run_of(definition), script)
    assert run["status"] == "completed" and run["rounds"] == {"e4": 2}
    assert [(seen[0], seen[1]) for seen in script.seen] == [
        ("plan", 1), ("judge", 1), ("plan", 2), ("judge", 2), ("do", None)]
    assert script.seen[2][3] == (("judge", "fix it"),), "the second round reads the verdict"
    assert [s.get("verdict") for s in run["sessions"]] == [None, "revise", None, "pass", None]


def test_rounds_that_run_out_stop_the_run_or_carry_on_as_the_loop_says() -> None:
    links = ["start>plan", "plan>judge", "judge>end", "judge>plan*2"]
    stop, _ = carry(run_of(graph([agent("plan"), agent("judge")], links)),
                    Script(judge=Handoff("no", verdict="revise")))
    assert stop["status"] == "failed" and "2" in stop["error"]
    going = graph([agent("plan"), agent("judge")], links)
    going.edges[-1].loop.on_exhausted = "continue"
    carried, _ = carry(run_of(going), Script(judge=Handoff("no", verdict="revise")))
    assert (carried["status"], carried["result"]) == ("completed", "no")


def test_a_node_runs_once_per_item_of_the_list_before_it() -> None:
    script = Script(list=Handoff("three things", items=("x", "y", "z")),
                    item=lambda task: f"did {task.item}")
    definition = graph([agent("list"), agent("item", each=2), agent("last")],
                       ["start>list", "list>item", "item>last", "last>end"])
    run, _ = carry(run_of(definition), script)
    assert run["status"] == "completed"
    assert sorted(seen[2] for seen in script.seen if seen[0] == "item") == ["x", "y"]
    assert script.seen[-1][3] == (("item", "【x】\ndid x\n\n【y】\ndid y"),)
    empty, _ = carry(run_of(definition), Script(list="no list here"))
    assert empty["status"] == "failed" and len(empty["sessions"]) == 4, "tried, then three retries"


def test_a_failed_node_is_tried_again_three_times_while_its_neighbours_finish() -> None:
    definition = graph([agent("a"), agent("b"), agent("c")],
                       ["start>a", "start>b", "a>c", "b>c", "c>end"])
    recovered, _ = carry(run_of(definition), Script(a=[NodeFailed("limit"), "a at last"]))
    assert recovered["status"] == "completed"
    assert [s["status"] for s in recovered["sessions"] if s["nodeId"] == "a"] == ["failed", "done"]

    script = Script(a=NodeFailed("limit"))
    run, _ = carry(run_of(definition), script)
    assert run["status"] == "failed" and "limit" in run["error"]
    by_node = {node: [s["status"] for s in run["sessions"] if s["nodeId"] == node]
               for node in "abc"}
    assert by_node == {"a": ["failed"] * 4, "b": ["done"], "c": []}

    # Taken up again, only what did not finish runs.
    script.replies["a"] = "a now"
    script.seen.clear()
    carry(run, script)
    assert run["status"] == "completed" and [seen[0] for seen in script.seen] == ["a", "c"]


def test_a_run_left_by_a_quit_is_paused_and_goes_on_from_its_node() -> None:
    definition = graph([agent("a"), agent("b")], ["start>a", "a>b", "b>end"])
    saved: list[dict] = []

    async def changed(current: dict) -> None:
        # What the file on disk holds at the moment the app quits: b has just started.
        if not saved and current["sessions"] and current["sessions"][-1]["nodeId"] == "b":
            saved.append(copy.deepcopy(current))

    asyncio.run(execute(run_of(definition), Script(), changed))
    run = saved[0]
    assert run["status"] == "running" and run["sessions"][-1]["status"] == "running"
    assert leave(run) and not leave(run)
    assert (run["status"], run["sessions"][-1]["status"]) == ("paused", "cancelled")
    script = Script()
    carry(run, script)
    assert run["status"] == "completed" and [seen[0] for seen in script.seen] == ["b"]


def test_stopping_cancels_every_session_and_the_run() -> None:
    definition = graph([agent("a"), agent("b")], ["start>a", "start>b", "a>end", "b>end"])
    run = run_of(definition)

    async def scenario() -> None:
        async def runner(task) -> Handoff:
            await asyncio.sleep(30)
            return Handoff("never")

        async def changed(_run) -> None:
            pass

        task = asyncio.create_task(execute(run, runner, changed))
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert run["status"] == "cancelled"
    assert [session["status"] for session in run["sessions"]] == ["cancelled", "cancelled"]


def test_no_more_than_four_sessions_run_at_once() -> None:
    names = [f"n{index}" for index in range(7)]
    definition = graph([agent(name) for name in names],
                       [link for name in names for link in (f"start>{name}", f"{name}>end")])
    script = Script()
    run, _ = carry(run_of(definition), script)
    assert run["status"] == "completed" and script.most == 4


def test_retry_preserves_completed_items_and_explicitly_resumes_a_write() -> None:
    definition = graph([agent("list"), agent("apply", each=2, access="write")],
                       ["start>list", "list>apply", "apply>end"])
    script = Script(list=Handoff("items", items=("first", "second")))

    def apply(task):
        if task.item == "second":
            raise NodeFailed("save failed")
        return Handoff("saved first")

    script.replies["apply"] = apply
    run, _ = carry(run_of(definition), script)
    assert run["status"] == "failed"
    assert [t[2] for t in script.seen if t[0] == "apply"] == ["first", "second"]
    script.seen.clear()
    script.replies["apply"] = "saved second"
    carry(run, script)
    assert [t[2] for t in script.seen] == ["second"]
    assert run["result"] == "【first】\nsaved first\n\n【second】\nsaved second"


def test_each_judge_submits_verdict_and_items_for_each_copy() -> None:
    definition = graph(
        [agent("list"), agent("review", each=2), agent("worker", each=2)],
        ["start>list", "list>review", "review>list*2", "review>worker", "worker>end"])
    def review(task):
        assert task.judge and task.lists
        return Handoff("feedback", verdict="revise" if task.item == "a" and task.round == 1
                       else "pass", items=(task.item.upper(),))
    script = Script(list=Handoff("items", items=("a", "b")), review=review)
    run, _ = carry(run_of(definition), script)
    assert run["status"] == "completed"
    assert [t[1] for t in script.seen if t[0] == "review"] == [1, 1, 2, 2]
    assert [t[2] for t in script.seen if t[0] == "worker"] == ["A", "B"]
