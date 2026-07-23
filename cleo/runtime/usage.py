"""Small shared model for displaying model context-window usage."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class ContextWindowUsage:
    used_tokens: int | None = None
    window_tokens: int | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cached_input_tokens: int | None = None

    @property
    def ratio(self) -> float | None:
        if self.used_tokens is None or not self.window_tokens:
            return None
        return max(0.0, min(self.used_tokens / self.window_tokens, 1.0))

    def update(
        self,
        *,
        used_tokens: int | None = None,
        window_tokens: int | None = None,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        cached_input_tokens: int | None = None,
    ) -> None:
        if used_tokens is not None:
            self.used_tokens = max(0, used_tokens)
        if window_tokens is not None:
            self.window_tokens = max(0, window_tokens) or None
        if input_tokens is not None:
            self.input_tokens = max(0, input_tokens)
        if output_tokens is not None:
            self.output_tokens = max(0, output_tokens)
        if cached_input_tokens is not None:
            self.cached_input_tokens = max(0, cached_input_tokens)
