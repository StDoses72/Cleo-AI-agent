"""Local semantic gate for deciding whether DreamAgent should consolidate a source."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from functools import lru_cache
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from cleo.config.settings import MemoryGateSettings

GateDecision = Literal["run", "skip", "uncertain"]
DEFAULT_MEMORY_GATE_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"


@dataclass(frozen=True)
class MemoryGateResult:
    """Inspectable result from the local pre-consolidation gate."""

    decision: GateDecision
    reason: str
    model: str | None
    positive_score: float | None = None
    negative_score: float | None = None
    margin: float | None = None
    message_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _content_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("text", "content", "value"):
            if key in value:
                text = _content_text(value[key])
                if text:
                    return text
        return ""
    if isinstance(value, (list, tuple)):
        return "\n".join(filter(None, (_content_text(item) for item in value)))
    return ""


def user_messages_from_compact(
    payload: dict[str, Any],
    *,
    max_messages: int,
    max_characters_per_message: int,
) -> list[str]:
    """Extract bounded human text from a validated compact projection."""
    messages: list[str] = []
    for event in payload.get("events") or []:
        if not isinstance(event, dict) or event.get("type") != "human":
            continue
        text = " ".join(_content_text(event.get("content")).split())
        if text:
            messages.append(text[:max_characters_per_message])
    return messages[-max_messages:]


@lru_cache(maxsize=4)
def _load_model(model_name: str, local_files_only: bool):
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(model_name, local_files_only=local_files_only)


def prefetch_memory_gate_model(model_name: str = DEFAULT_MEMORY_GATE_MODEL) -> dict[str, Any]:
    """Download a Sentence Transformer and verify it can produce embeddings."""
    model = _load_model(model_name, False)
    embeddings = model.encode(
        ["Cleo memory gate installation warm-up."],
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    if len(embeddings) != 1:
        raise RuntimeError("memory gate model warm-up returned an unexpected result")
    dimension = len(embeddings[0])
    if dimension <= 0:
        raise RuntimeError("memory gate model returned an empty embedding")
    return {"model": model_name, "embedding_dimension": dimension}


def _dot(left: Any, right: Any) -> float:
    return float(sum(float(a) * float(b) for a, b in zip(left, right, strict=True)))


def evaluate_memory_gate(
    payload: dict[str, Any],
    config: MemoryGateSettings,
) -> MemoryGateResult:
    """Compare user turns with positive and negative memory-value prototypes.

    Only a strong negative result skips DreamAgent. Model or scoring failures are
    fail-open and return ``uncertain`` so durable information is not silently lost.
    """
    if not config.enabled:
        return MemoryGateResult(
            decision="uncertain",
            reason="memory gate is disabled",
            model=None,
        )

    messages = user_messages_from_compact(
        payload,
        max_messages=config.max_messages,
        max_characters_per_message=config.max_characters_per_message,
    )
    if not messages:
        return MemoryGateResult(
            decision="skip",
            reason="validated compact source contains no non-empty user text",
            model=config.model,
        )

    prototypes = [*config.positive_prototypes, *config.negative_prototypes]
    try:
        model = _load_model(config.model, config.local_files_only)
        embeddings = model.encode(
            [*messages, *prototypes],
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        message_vectors = embeddings[: len(messages)]
        positive_start = len(messages)
        negative_start = positive_start + len(config.positive_prototypes)
        positive_vectors = embeddings[positive_start:negative_start]
        negative_vectors = embeddings[negative_start:]
        scores: list[tuple[float, float, float]] = []
        for vector in message_vectors:
            positive = max(_dot(vector, prototype) for prototype in positive_vectors)
            negative = max(_dot(vector, prototype) for prototype in negative_vectors)
            scores.append((positive, negative, positive - negative))
    except Exception as exc:  # Model availability must not suppress durable memory.
        return MemoryGateResult(
            decision="uncertain",
            reason=f"memory gate unavailable: {type(exc).__name__}: {exc}",
            model=config.model,
            message_count=len(messages),
        )

    strongest_positive = max(scores, key=lambda item: item[2])
    strongest_negative = min(scores, key=lambda item: item[2])
    if (
        strongest_positive[0] >= config.minimum_similarity
        and strongest_positive[2] >= config.run_margin
    ):
        decision: GateDecision = "run"
        reason = "at least one user turn strongly matches durable-memory prototypes"
        selected = strongest_positive
    elif all(
        negative >= config.minimum_similarity and -margin >= config.skip_margin
        for _, negative, margin in scores
    ):
        decision = "skip"
        reason = "all user turns strongly match transient-conversation prototypes"
        selected = strongest_negative
    else:
        decision = "uncertain"
        reason = "prototype comparison is inconclusive; fail open to DreamAgent"
        selected = max(scores, key=lambda item: max(item[0], item[1]))

    return MemoryGateResult(
        decision=decision,
        reason=reason,
        model=config.model,
        positive_score=round(selected[0], 6),
        negative_score=round(selected[1], 6),
        margin=round(selected[2], 6),
        message_count=len(messages),
    )
