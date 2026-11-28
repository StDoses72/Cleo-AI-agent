"""Typed, attempt-local workflow submissions shared with the harness's stdio MCP process."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import closing, contextmanager
from contextvars import ContextVar
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Annotated, Literal

from pydantic import Field, StringConstraints

from cleo.workflows.engine import Handoff, NodeFailed, NodeTask
from cleo.workflows.models import MAX_ITEMS

Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]
Items = Annotated[list[Text], Field(min_length=1, max_length=MAX_ITEMS)]
current_receipt: ContextVar[Path | None] = ContextVar("workflow_receipt", default=None)
VERDICT_TOOL = "submit_workflow_verdict"
ITEMS_TOOL = "submit_workflow_items"


@contextmanager
def submission_scope(task: NodeTask) -> Iterator[Path | None]:
    """Only this attempt's launched transports receive the private database path."""
    if not (task.judge or task.lists):
        yield None
        return
    with TemporaryDirectory(prefix="cleo-handoff-") as directory:
        path = Path(directory).resolve() / "receipt.sqlite3"
        with closing(sqlite3.connect(path)) as db, db:
            db.execute("CREATE TABLE receipts (kind TEXT PRIMARY KEY, body TEXT)")
            for kind, needed in ((VERDICT_TOOL, task.judge), (ITEMS_TOOL, task.lists)):
                if needed:
                    db.execute("INSERT INTO receipts (kind) VALUES (?)", (kind,))
        token = current_receipt.set(path)
        try:
            yield path
        finally:
            current_receipt.reset(token)


def _connect(path: Path):
    # A late call cannot recreate a finished attempt's database.
    return sqlite3.connect(path.as_uri() + "?mode=rw", uri=True)


def _submit(path: Path, kind: str, value: object) -> str:
    body = json.dumps(value, ensure_ascii=False)
    with closing(_connect(path)) as db, db:
        updated = db.execute("UPDATE receipts SET body=? WHERE kind=? AND (body IS NULL OR body=?)",
                             (body, kind, body))
        if updated.rowcount != 1:
            raise ValueError("This submission conflicts with the recorded handoff.")
    return "Recorded."


def register_tools(server, path: Path) -> None:
    """Expose exactly the kinds of handoff expected of this attempt."""
    with closing(_connect(path)) as db:
        kinds = {row[0] for row in db.execute("SELECT kind FROM receipts")}

    if VERDICT_TOOL in kinds:
        @server.tool(name=VERDICT_TOOL)
        def verdict(verdict: Literal["pass", "revise"], feedback: Text) -> str:
            """Submit your review decision and the evidence or changes it calls for."""
            return _submit(path, VERDICT_TOOL, {"verdict": verdict, "feedback": feedback})

    if ITEMS_TOOL in kinds:
        @server.tool(name=ITEMS_TOOL)
        def items(items: Items) -> str:
            """Submit the ordered, self-contained work items for the next node."""
            return _submit(path, ITEMS_TOOL, items)


def collect(path: Path | None, reply: str) -> Handoff:
    if path is None:
        return Handoff(text=reply.strip())
    with closing(_connect(path)) as db:
        rows = db.execute("SELECT kind, body FROM receipts").fetchall()
    submissions = {}
    for kind, body in rows:
        if body is None:
            raise NodeFailed(f"Missing required workflow submission: {kind}.")
        submissions[kind] = json.loads(body)
    review = submissions.get(VERDICT_TOOL, {})
    feedback = review.get("feedback", "")
    text = reply.strip()
    if feedback and feedback != text:
        text = "\n\n".join(part for part in (text, feedback) if part)
    return Handoff(text=text, verdict=review.get("verdict"),
                   items=tuple(submissions.get(ITEMS_TOOL, ())))
