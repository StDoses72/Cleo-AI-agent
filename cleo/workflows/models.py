"""A workflow as it is drawn and stored.

Field names are the desktop UI's (`ui/src/workflow-types.ts`): the file on disk, the protocol and
the canvas share one shape.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

START = "start"
END = "end"
MAX_ROUNDS = 5
MAX_ITEMS = 8

Identifier = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")


class Schema(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True, allow_inf_nan=False,
                              alias_generator=to_camel, populate_by_name=True)


class NodeFields(Schema):
    """What a node is, apart from where it sits: the part that can be kept and used again."""

    role: str = Field(default="", max_length=24)
    instructions: str = Field(default="", max_length=2000)
    # None runs on the harness and model of the conversation that starts the workflow.
    harness: str | None = Field(default=None, max_length=80)
    model: str | None = Field(default=None, max_length=120)
    effort: str | None = Field(default=None, max_length=20)
    speed: str | None = Field(default=None, max_length=20)
    access: Literal["read", "write"] = "read"
    workspace: Literal["shared", "worktree"] = "shared"
    delegation: Literal["default", "on", "off"] = "default"
    approval: Literal["auto", "ask"] = "auto"
    # One copy per item of the list the node before it returned, up to this many; None runs once.
    each: int | None = None


class Node(NodeFields):
    id: str = Identifier
    drafted: bool | None = None
    x: float = 0
    y: float = 0


class Loop(Schema):
    max_rounds: int
    on_exhausted: Literal["stop", "continue"] = "stop"


class Edge(Schema):
    id: str = Identifier
    # A node id, "start" for the task or "end" for the result.
    from_: str = Field(alias="from", min_length=1, max_length=80)
    to: str = Field(min_length=1, max_length=80)
    loop: Loop | None = None


class Point(Schema):
    x: float
    y: float


class Definition(Schema):
    id: str = Identifier
    name: str = Field(max_length=60)
    description: str = Field(default="", max_length=400)
    nodes: list[Node] = Field(max_length=40)
    edges: list[Edge] = Field(max_length=120)
    start: Point
    end: Point
    origin: Literal["user", "drafted"] = "user"
    updated_at: str | None = None


class Role(Schema):
    """A node definition the user kept for reuse. Placing it on a canvas copies it."""

    id: str = Identifier
    fields: NodeFields


class Harness(Schema):
    """What validation needs to know about a harness a node may be bound to."""

    id: str
    available: bool = True
    models: frozenset[str] = frozenset()
    # It can hold a node to reading.
    read_only: bool = True
    # It receives Cleo's tools, which is how a node returns a verdict or a list.
    tools: bool = True


class Issue(Schema):
    code: str
    node_id: str | None = None
    edge_id: str | None = None
    subject: str | None = None
