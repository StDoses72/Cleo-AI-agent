"""Full-text, evidence-linked projections for bounded DreamAgent requests.

The historical compact/index format stays unchanged. Only protocol duplication
and known usage notifications are removed here; tool text is never excerpted.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

from cleo.memory.compaction import _redact_text

PROJECTION_VERSION = 1
BLOCK_BUDGET = 20_000
MAX_BLOCK_BYTES = 64_000
_NOISE = {"thread/tokenUsage/updated", "account/rateLimits/updated"}
_SECRET_KEY = re.compile(
    r"(?i)^(?:.*[_-])?(api[_-]?key|authorization|password|secret|token|access[_-]?token|"
    r"refresh[_-]?token)$"
)


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


@lru_cache(maxsize=1)
def _encoding():
    import tiktoken

    return tiktoken.get_encoding("o200k_base")


def token_count(text: str) -> int:
    """Proxy token count; retain a separate byte ceiling for other tokenizers."""
    return len(_encoding().encode(text, disallowed_special=()))


def redact(value: Any) -> Any:
    """Redact credentials and inline media without dropping content/patch fields."""
    if isinstance(value, dict):
        if str(value.get("type", "")).casefold() in {"image", "image_url", "input_image"}:
            return {"type": "image_reference", "content_omitted": True}
        return {
            str(key): (
                "<redacted>" if _SECRET_KEY.fullmatch(str(key)) else
                "<inline-media-omitted>" if key == "base64" and isinstance(child, str) else
                redact(child)
            ) for key, child in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact(child) for child in value]
    if isinstance(value, str):
        if value.startswith("data:") and ";base64," in value[:100]:
            return "<inline-media-omitted>"
        return _redact_text(value)
    return value


@dataclass
class Record:
    seq: int
    end_seq: int
    kind: str
    body: dict
    event_ids: list[str]
    operation: tuple = ()
    method: str = ""
    created_at: str | None = None
    ended_at: str | None = None
    # Raw equality is checked before redaction, which can make distinct secrets equal.
    equality_hash: str = ""
    output_hash: str = ""
    _parts: list[str] = field(default_factory=list, repr=False)

    @property
    def ref(self) -> str:
        return f"E{self.seq}"


@dataclass
class Block:
    text: str
    evidence: dict[str, list[str]]

    @property
    def digest(self) -> str:
        return hashlib.sha256(canonical([self.text, self.evidence]).encode()).hexdigest()


def project_events(events: list[dict]) -> list[Record]:
    """Keep chronological records; merge only adjacent deltas with reliable IDs."""
    records: list[Record] = []
    previous_seq = 0
    for event in events:
        seq = int(event["seq"])
        if seq <= previous_seq:
            raise ValueError("session event sequence is not strictly increasing")
        previous_seq = seq
        data = event.get("data") or {}
        payload = data.get("payload") or {}
        item = payload.get("item") or {}
        method = str(data.get("provider_event_type") or "")
        if method in _NOISE:
            continue
        key = (
            data.get("provider"), payload.get("threadId"), payload.get("turnId"),
            payload.get("itemId") or item.get("id"),
        )
        operation = key if all(key) else ()
        delta = payload.get("delta")
        is_delta = (
            operation and method == "item/commandExecution/outputDelta"
            and isinstance(delta, str) and event.get("content") in (None, delta)
        )
        if (
            is_delta and records and records[-1]._parts
            and records[-1].operation == operation and records[-1].end_seq == seq - 1
        ):
            record = records[-1]
            record._parts.append(delta)
            record.end_seq = seq
            record.ended_at = event.get("created_at")
            record.event_ids.append(str(event["id"]))
            continue
        # Keep unknown event fields as well as LangChain serialized messages.
        body = {
            k: v for k, v in event.items()
            if k not in {
                "id", "seq", "type", "session_id", "space", "project", "schema_version",
                "created_at", "data", "content",
            }
        }
        if is_delta:
            body["output"] = delta
        elif payload:
            body.update({k: v for k, v in payload.items() if k not in {
                "threadId", "turnId", "itemId", "startedAtMs", "completedAtMs",
            }})
            if isinstance(body.get("item"), dict):
                body["item"] = {k: v for k, v in body["item"].items() if k != "id"}
            extras = {k: v for k, v in data.items() if k not in {
                "payload", "provider", "provider_event_type", "schema_version",
            }}
            if extras:
                body["metadata"] = extras
        elif data:
            body["data"] = data
        content = event.get("content")
        if not is_delta and content is not None and not any(
            content == value
            for value in (payload.get("delta"), payload.get("diff"), item.get("text"))
        ):
            body["content"] = content
        record = Record(
            seq, seq, str(event.get("type") or "unknown"), body, [str(event["id"])],
            operation=operation, method=method, created_at=event.get("created_at"),
            ended_at=event.get("created_at"),
        )
        if is_delta:
            record._parts = [delta]
        records.append(record)
    for record in records:
        if record._parts:
            record.body["output"] = "".join(record._parts)
            record._parts.clear()
        record.equality_hash = hashlib.sha256(canonical(record.body).encode()).hexdigest()
        output = record.body.get("output", (record.body.get("item") or {}).get("aggregatedOutput"))
        if isinstance(output, str):
            record.output_hash = hashlib.sha256(output.encode()).hexdigest()
        record.body = redact(record.body)
    return records


def build_blocks(records: list[Record], *, budget: int = BLOCK_BUDGET) -> list[Block]:
    """Pack complete records, reusing bodies only within the current block.

    An oversized record is split into reconstructable JSON text fragments at
    Unicode character boundaries. No text is truncated to fit the budget.
    """
    if budget < 256:
        raise ValueError("Dream block budget must be at least 256 tokens")
    blocks: list[Block] = []
    lines: list[str] = []
    evidence: dict[str, list[str]] = {}
    bodies: dict[str, str] = {}
    outputs: dict[tuple, tuple[str, str]] = {}

    def fits(text: str) -> bool:
        return len(text.encode()) <= MAX_BLOCK_BYTES and token_count(text) <= budget

    def flush() -> None:
        if lines:
            blocks.append(Block("\n".join(lines), dict(evidence)))
        lines.clear()
        evidence.clear()
        bodies.clear()
        outputs.clear()

    def render(record: Record, *, reuse: bool) -> str:
        body = record.body
        if reuse and record.equality_hash in bodies and len(canonical(body)) > 160:
            body = {"same_body_as": bodies[record.equality_hash]}
        elif reuse and record.operation and record.operation in outputs:
            output_hash, ref = outputs[record.operation]
            item = body.get("item") or {}
            if record.output_hash == output_hash and "aggregatedOutput" in item:
                body = {**body, "item": {k: v for k, v in item.items() if k != "aggregatedOutput"},
                        "same_output_as": ref}
        return canonical({
            "record": record.ref, "seq": record.seq, "end_seq": record.end_seq,
            "type": record.kind, "time": record.created_at, "end_time": record.ended_at,
            "operation": record.operation[-1] if record.operation else None,
            "method": record.method, "body": body,
        })

    for record in records:
        text = render(record, reuse=True)
        if lines and not fits("\n".join([*lines, text])):
            flush()
            text = render(record, reuse=False)
        if not fits(text):
            start = 0
            while start < len(text):
                low, high = start + 1, len(text)
                ref = f"{record.ref}:{start}"

                def fragment(end: int, *, record_ref=record.ref, ref=ref, start=start, text=text):
                    return canonical({"record": record_ref, "ref": ref,
                                      "range": [start, end], "fragment": text[start:end]})

                while low < high:
                    middle = (low + high + 1) // 2
                    if fits(fragment(middle)):
                        low = middle
                    else:
                        high = middle - 1
                blocks.append(Block(fragment(low), {ref: record.event_ids}))
                start = low
            continue
        lines.append(text)
        evidence[record.ref] = record.event_ids
        bodies[record.equality_hash] = record.ref
        if record.operation and "output" in record.body:
            outputs[record.operation] = (record.output_hash, record.ref)
    flush()
    return blocks
