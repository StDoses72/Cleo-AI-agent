import asyncio
import json
import sqlite3
from datetime import UTC, datetime, timedelta

import pytest

from cleo.runtime.timing import TimingStore, measure, stage


def test_measures_overlaps_and_persists_without_counting_shutdown_time(tmp_path):
    async def run():
        now = [0.0]
        async with measure(tmp_path, session_id="s", space="productivity", project="p",
                           kind="reply", clock=lambda: now[0]) as timer:
            timer.summary["turnId"] = "t"
            timer.phase("prepare")
            now[0] = 2
            timer.phase("runtime")
            with stage("model", category="model"):
                now[0] = 3
                with stage("tool", category="tool"):
                    now[0] = 5
                now[0] = 6
            now[0] = 7
        identifier = timer.summary["id"]
        now[0] = 1_000_000
        return TimingStore(tmp_path).detail(identifier)
    result = asyncio.run(run())
    assert result["status"] == "completed"
    assert result["elapsedMs"] == 7000
    assert [span["elapsedMs"] for span in result["spans"]] == [2000, 5000, 4000, 2000]
    assert result["spans"][3]["parentId"] == result["spans"][2]["id"]
    assert result["accumulatedMs"] == 7000


@pytest.mark.parametrize("failure", [ValueError, asyncio.CancelledError])
def test_failed_and_cancelled_attempts_keep_completed_and_partial_work(tmp_path, failure):
    async def run():
        now = [0.0]
        with pytest.raises(failure):
            async with measure(tmp_path, session_id="s", space="productivity", project="p",
                               kind="dream", clock=lambda: now[0]) as timer:
                timer.phase("read")
                now[0] = 1
                timer.phase("model")
                now[0] = 4
                raise failure()
        async with measure(tmp_path, session_id="s", space="productivity", project="p",
                           kind="dream", clock=lambda: now[0]) as retry:
            now[0] = 6
        return TimingStore(tmp_path).detail(timer.summary["id"]), retry.summary["id"]
    result, retry = asyncio.run(run())
    assert result["status"] == ("failed" if failure is ValueError else "cancelled")
    assert result["spans"][0]["status"] == "completed"
    assert result["spans"][1]["status"] == result["status"]
    assert result["elapsedMs"] == 4000
    assert result["accumulatedMs"] == 6000
    assert [attempt["id"] for attempt in result["attempts"]][-1] == retry


def test_lost_process_reports_last_observation_not_elapsed_wall_time(tmp_path):
    store = TimingStore(tmp_path)
    summary = {"id": "old", "sessionId": "s", "kind": "reply", "turnId": "t",
               "createdAt": datetime.now(UTC).isoformat(), "status": "running", "elapsedMs": 1234,
               "updatedAt": (datetime.now(UTC) - timedelta(days=3)).isoformat()}
    store.save(summary, [])
    assert store.detail("old")["status"] == "unconfirmed"
    assert store.detail("old")["elapsedMs"] == 1234
    assert store.summaries(session_id="other") == []
    # Reading never rewrites authoritative observations or resumes an attempt.
    with sqlite3.connect(store.path) as db:
        assert json.loads(db.execute("SELECT summary FROM attempts").fetchone()[0]) == summary


def test_unrelated_preparation_failures_are_not_counted_as_one_reply(tmp_path):
    store = TimingStore(tmp_path)
    for identifier, elapsed in (("a", 100), ("b", 300)):
        store.save({"id": identifier, "sessionId": "s", "kind": "reply", "turnId": None,
                    "status": "failed", "elapsedMs": elapsed,
                    "createdAt": datetime.now(UTC).isoformat()}, [])
    assert store.detail("a")["accumulatedMs"] == 100


def test_timing_failure_does_not_change_primary_result(tmp_path, monkeypatch):
    def broken(*args):
        raise OSError("disk full")
    monkeypatch.setattr(TimingStore, "save", broken)
    async def run():
        emitted = []
        async def emit(value):
            emitted.append(value)
        async with measure(tmp_path, session_id="s", space="productivity", project="p",
                           kind="dream", emit=emit):
            with stage("publish"):
                (tmp_path / "primary.txt").write_text("published")
        return emitted
    result = asyncio.run(run())
    assert (tmp_path / "primary.txt").read_text() == "published"
    assert result[-1]["status"] == "completed"
    assert result[-1]["persistenceError"]


def test_model_and_tool_callbacks_keep_parallel_calls_separate(tmp_path):
    from cleo.runtime.timing_callbacks import timing_config

    async def run():
        async with measure(tmp_path, session_id="s", space="non_productivity", project="p",
                           kind="reply") as timer:
            handler = timing_config()["callbacks"][0]
            await handler.on_chat_model_start({}, [], run_id="first")
            await handler.on_chat_model_start({}, [], run_id="second")
            await handler.on_tool_start({"name": "read_file"}, "secret content", run_id="tool")
            await handler.on_llm_error(ValueError("provider error"), run_id="first")
            await handler.on_tool_end("private output", run_id="tool")
            await handler.on_llm_end(None, run_id="second")
        return TimingStore(tmp_path).detail(timer.summary["id"])
    result = asyncio.run(run())
    assert [span["status"] for span in result["spans"]] == ["failed", "completed", "completed"]
    assert "secret" not in json.dumps(result) and "private output" not in json.dumps(result)
    assert timing_config() == {}
