from __future__ import annotations

from typing import Any

from cleo.config.settings import MemoryGateSettings
from cleo.memory import gate


class _FakeModel:
    def encode(self, texts: list[str], **_kwargs: Any) -> list[list[float]]:
        vectors = {
            "durable prototype": [1.0, 0.0],
            "transient prototype": [0.0, 1.0],
            "remember this preference": [1.0, 0.0],
            "thanks": [0.0, 1.0],
            "maybe": [0.7, 0.7],
            "Cleo memory gate installation warm-up.": [1.0, 0.0],
        }
        return [vectors[text] for text in texts]


def _config() -> MemoryGateSettings:
    return MemoryGateSettings(
        model="fake-model",
        minimum_similarity=0.4,
        run_margin=0.2,
        skip_margin=0.2,
        positive_prototypes=["durable prototype"],
        negative_prototypes=["transient prototype"],
    )


def _payload(*messages: object) -> dict[str, Any]:
    return {"events": [{"type": "human", "content": message} for message in messages]}


def test_gate_runs_for_durable_content(monkeypatch) -> None:
    monkeypatch.setattr(gate, "_load_model", lambda *_args: _FakeModel())

    result = gate.evaluate_memory_gate(_payload("remember this preference"), _config())

    assert result.decision == "run"
    assert result.margin == 1.0


def test_gate_skips_only_when_every_user_turn_is_strongly_transient(monkeypatch) -> None:
    monkeypatch.setattr(gate, "_load_model", lambda *_args: _FakeModel())

    skipped = gate.evaluate_memory_gate(_payload("thanks"), _config())
    mixed = gate.evaluate_memory_gate(
        _payload("thanks", {"type": "text", "text": "remember this preference"}),
        _config(),
    )

    assert skipped.decision == "skip"
    assert mixed.decision == "run"


def test_gate_fails_open_for_ambiguous_content_or_model_errors(monkeypatch) -> None:
    monkeypatch.setattr(gate, "_load_model", lambda *_args: _FakeModel())
    ambiguous = gate.evaluate_memory_gate(_payload("maybe"), _config())
    monkeypatch.setattr(
        gate,
        "_load_model",
        lambda *_args: (_ for _ in ()).throw(RuntimeError("offline")),
    )
    unavailable = gate.evaluate_memory_gate(_payload("thanks"), _config())

    assert ambiguous.decision == "uncertain"
    assert unavailable.decision == "uncertain"
    assert "offline" in unavailable.reason


def test_gate_skips_a_source_without_user_text() -> None:
    result = gate.evaluate_memory_gate({"events": []}, _config())

    assert result.decision == "skip"


def test_prefetch_downloads_and_warms_up_the_model(monkeypatch) -> None:
    monkeypatch.setattr(gate, "_load_model", lambda *_args: _FakeModel())

    result = gate.prefetch_memory_gate_model("fake-model")

    assert result == {"model": "fake-model", "embedding_dimension": 2}
