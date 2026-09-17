"""Measured attempts and overlapping spans, isolated from model and memory evidence."""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager, closing, contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from pathlib import Path

log = logging.getLogger(__name__)
current_timing = ContextVar("current_timing", default=None)
_parent = ContextVar("timing_parent", default=None)


def _stamp():
    return datetime.now(UTC).isoformat()


class TimingStore:
    def __init__(self, memory_root):
        self.path = Path(memory_root) / ".timings-v1.sqlite3"

    def _connect(self):
        if self.path.is_symlink():
            raise OSError("计时记录不能使用链接文件。")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=2)
        try:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in {0, 1}:
                raise sqlite3.DatabaseError("无法读取此版本的计时记录。")
            if version == 1:
                return db
            db.executescript("""
                CREATE TABLE IF NOT EXISTS attempts (
                    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL,
                    turn_id TEXT, created_at TEXT NOT NULL, summary TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS attempt_session ON attempts(session_id,kind,turn_id);
                CREATE INDEX IF NOT EXISTS attempt_recent ON attempts(kind,created_at);
                CREATE TABLE IF NOT EXISTS spans (
                    attempt_id TEXT NOT NULL, id TEXT NOT NULL, ordinal INTEGER NOT NULL,
                    body TEXT NOT NULL, PRIMARY KEY(attempt_id,id));
                PRAGMA user_version=1;
            """)
        except sqlite3.Error:
            db.close()
            raise
        return db

    def save(self, summary, spans):
        with closing(self._connect()) as db, db:
            db.execute("INSERT OR REPLACE INTO attempts VALUES (?,?,?,?,?,?)", (
                summary["id"], summary["sessionId"], summary["kind"], summary["turnId"],
                summary["createdAt"], json.dumps(summary, ensure_ascii=False),
            ))
            db.executemany("INSERT OR REPLACE INTO spans VALUES (?,?,?,?)", [
                (summary["id"], span["id"], span["ordinal"], json.dumps(span, ensure_ascii=False))
                for span in spans
            ])

    @staticmethod
    def _summary(raw):
        result = json.loads(raw)
        # Never extrapolate work from wall time after a process stopped reporting.
        if result["status"] == "running":
            age = (datetime.now(UTC) - datetime.fromisoformat(result["updatedAt"])).total_seconds()
            if age > 15:
                result["status"] = "unconfirmed"
        return result

    def summaries(self, *, session_id=None, kind=None, turn_ids=None, limit=30):
        if not self.path.exists() or turn_ids == []:
            return []
        where, values = [], []
        for key, value in (("session_id", session_id), ("kind", kind)):
            if value is not None:
                where.append(f"{key}=?")
                values.append(value)
        if turn_ids is not None:
            where.append("turn_id IN (" + ",".join("?" for _ in turn_ids) + ")")
            values.extend(turn_ids)
        values.append(limit)
        with closing(self._connect()) as db:
            return [self._summary(row[0]) for row in db.execute(
                "SELECT summary FROM attempts " + ("WHERE " + " AND ".join(where) if where else "")
                + " ORDER BY created_at DESC LIMIT ?", values,
            )]

    def detail(self, identifier):
        if not self.path.exists():
            raise ValueError("找不到这次计时记录。")
        with closing(self._connect()) as db:
            row = db.execute("SELECT summary FROM attempts WHERE id=?", (identifier,)).fetchone()
            if row is None:
                raise ValueError("找不到这次计时记录。")
            summary = self._summary(row[0])
            spans = [json.loads(row[0]) for row in db.execute(
                "SELECT body FROM spans WHERE attempt_id=? ORDER BY ordinal", (identifier,),
            )]
            attempts = [self._summary(row[0]) for row in db.execute(
                "SELECT summary FROM attempts WHERE session_id=? AND kind=? "
                "AND (kind='dream' OR (turn_id IS NOT NULL AND turn_id IS ?) OR id=?) "
                "ORDER BY created_at",
                (summary["sessionId"], summary["kind"], summary["turnId"], identifier),
            )]
            return {**summary, "spans": spans, "attempts": attempts,
                    "accumulatedMs": sum(attempt["elapsedMs"] for attempt in attempts)}


class TimingRecorder:
    def __init__(self, store, *, session_id, space, project, kind,
                 emit=None, clock=time.perf_counter):
        self.store, self.emit, self.clock = store, emit, clock
        self.started = clock()
        self.summary = {
            "id": uuid.uuid4().hex, "sessionId": session_id, "space": space, "project": project,
            "kind": kind, "turnId": None, "createdAt": _stamp(), "status": "running",
            "unavailable": [], "persistenceError": None,
        }
        self.spans, self.dirty = {}, set()
        self.phase_id = None
        self.stopped = asyncio.Event()
        self.writer = asyncio.Lock()
        self.elapsed = None

    def start(self, label, *, category="stage", parent=None):
        identifier = uuid.uuid4().hex
        self.spans[identifier] = {
            "id": identifier, "ordinal": len(self.spans), "label": label, "category": category,
            "parentId": parent if parent is not None else _parent.get() or self.phase_id,
            "started": self.clock(), "status": "running",
        }
        self.dirty.add(identifier)
        return identifier

    def end(self, identifier, status="completed"):
        span = self.spans.get(identifier)
        if span is not None and span["status"] == "running":
            span["elapsedMs"] = max(0, (self.clock() - span["started"]) * 1000)
            span["status"] = status
            self.dirty.add(identifier)

    def phase(self, label, *, previous_status="completed"):
        self.end(self.phase_id, previous_status)
        self.phase_id = None
        if label is not None:
            self.phase_id = self.start(label)

    def snapshot(self):
        now = self.clock()
        active = [span for span in self.spans.values() if span["status"] == "running"]
        summary = {**self.summary, "updatedAt": _stamp(),
                   "elapsedMs": self.elapsed if self.elapsed is not None
                   else max(0, (now - self.started) * 1000),
                   "phase": active[-1]["label"] if active else None}
        dirty, self.dirty = self.dirty | {span["id"] for span in active}, set()
        spans = [{key: value for key, value in self.spans[identifier].items() if key != "started"}
                 | {"elapsedMs": self.spans[identifier].get(
                     "elapsedMs", max(0, (now - self.spans[identifier]["started"]) * 1000),
                 )} for identifier in dirty]
        return summary, spans

    async def flush(self):
        async with self.writer:
            summary, spans = self.snapshot()
            summary["persistenceError"] = None
            try:
                await asyncio.to_thread(self.store.save, summary, spans)
            except (OSError, sqlite3.Error) as error:
                self.dirty.update(span["id"] for span in spans)
                self.summary["persistenceError"] = "计时记录未能保存。"
                summary["persistenceError"] = self.summary["persistenceError"]
                log.warning("Timing persistence failed: %s", error)
            else:
                self.summary["persistenceError"] = None
            if self.emit is not None:
                try:
                    await self.emit(summary)
                except Exception:
                    # Diagnostics are best effort at the UI/network boundary.
                    log.warning("Timing update could not reach the UI", exc_info=True)

    async def tick(self):
        while not self.stopped.is_set():
            await self.flush()
            try:
                await asyncio.wait_for(self.stopped.wait(), timeout=1)
            except TimeoutError:
                pass

    async def finish(self, status):
        self.elapsed = max(0, (self.clock() - self.started) * 1000)
        self.summary["status"] = status
        for identifier in self.spans:
            self.end(identifier, status if status in {"failed", "cancelled"} else "completed")
        self.stopped.set()


@asynccontextmanager
async def measure(memory_root, **kwargs):
    recorder = TimingRecorder(TimingStore(memory_root), **kwargs)
    token = current_timing.set(recorder)
    parent_token = _parent.set(None)
    ticker = asyncio.create_task(recorder.tick())
    status = "completed"
    try:
        yield recorder
        status = recorder.summary["status"] if recorder.summary["status"] != "running" else status
    except asyncio.CancelledError:
        status = "cancelled"
        raise
    except BaseException:
        status = "failed"
        raise
    finally:
        await recorder.finish(status)
        # Drain an in-flight snapshot before writing final state; never cancel a file write.
        async def finish():
            await ticker
            await recorder.flush()
        saving = asyncio.create_task(finish())
        try:
            await asyncio.shield(saving)
        except asyncio.CancelledError:
            await saving
            raise
        finally:
            current_timing.reset(token)
            _parent.reset(parent_token)


@contextmanager
def stage(label, *, category="stage"):
    recorder = current_timing.get()
    if recorder is None:
        yield
        return
    identifier = recorder.start(label, category=category)
    token = _parent.set(identifier)
    status = "completed"
    try:
        yield
    except asyncio.CancelledError:
        status = "cancelled"
        raise
    except BaseException:
        status = "failed"
        raise
    finally:
        recorder.end(identifier, status)
        _parent.reset(token)


def phase(label, *, previous_status="completed"):
    recorder = current_timing.get()
    if recorder is not None:
        recorder.phase(label, previous_status=previous_status)
