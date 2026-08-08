"""Small shared model for displaying model context-window usage."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class RateLimitWindowUsage:
    """One account-level Codex usage window reported by app-server."""

    used_percent: int
    window_minutes: int | None = None
    resets_at: int | None = None


@dataclass(slots=True)
class ContextWindowUsage:
    """模型 context window 使用量的共享数据模型(用于 UI 展示)。

    由 cleo/agents/cleo.py 与 productivity TUI 实例化; 经 update()
    增量更新后, 由 Rich/Textual presentation 读取并渲染用量指示。
    """

    used_tokens: int | None = None
    window_tokens: int | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cached_input_tokens: int | None = None
    rate_limit_windows: tuple[RateLimitWindowUsage, ...] = ()
    rate_limits_loaded: bool = False

    @property
    def ratio(self) -> float | None:
        """计算已用 token 占 context window 的比例(clamp 到 [0.0, 1.0])。

        数据来自 update() 写入的 used_tokens / window_tokens。
        返回:
            使用比例; 数据不足时返回 None。被
            cleo/cli/productivity_renderer.py:200 用于渲染进度条,
            以及 tests/agents/test_cleo.py 断言。
        """
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
        """增量更新各项 token 计数; 传 None 的字段保持不变, 负数归零。

        参数(均为 keyword-only):
            used_tokens: 当前已占用的 context token 数, 来自
                cleo/agents/cleo.py:169(LLM 响应 usage 元数据)。
            window_tokens: 模型 context window 总大小, 来源同上;
                0 会被归一为 None(表示未知)。
            input_tokens: 本轮输入 token 数, 来源同上。
            output_tokens: 本轮输出 token 数, 来源同上。
            cached_input_tokens: 命中缓存的输入 token 数, 来源同上。
            另见 cleo/cli/productivity_renderer.py:91 的渲染侧更新。
        无返回值; 更新结果由 ratio 属性及各 UI 渲染函数消费。
        """
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

    def update_rate_limits(
        self,
        windows: tuple[RateLimitWindowUsage, ...],
    ) -> None:
        """Replace account-level Codex limits while preserving context counters."""
        self.rate_limit_windows = windows
        self.rate_limits_loaded = True
