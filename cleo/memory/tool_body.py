"""Bounded tool excerpts shared by history and preference projections."""

import re

TOOL_BODY_VERSION = 1

_OUTCOME = re.compile(
    r"error|fail|cancel|interrupt|recover|resum|success|passed|completed|"
    r"exit.?code|constraint|must\b|失败|错误|取消|中断|恢复|通过|完成|约束", re.IGNORECASE,
)


def bounded_tool_text(text: str, limit: int = 2400) -> str:
    """Keep head, tail and bounded outcome lines; omitted text stays in raw events.

    This is an excerpt, never a semantic summary or proof of the latest state.
    Callers retain event IDs so omitted middle text can be read on demand.
    """
    if len(text) <= limit:
        return text
    head_size = limit // 4
    tail_size = limit // 3
    selected = []
    remaining = limit - head_size - tail_size
    # Prefer later outcomes, without losing their original relative order.
    for line in reversed(text[head_size:-tail_size].splitlines()):
        if _OUTCOME.search(line) and line not in selected:
            piece = line[:min(400, remaining)]
            selected.append(piece)
            remaining -= len(piece)
            if remaining <= 0:
                break
    marker = f"\n<tool excerpt; omitted content; original {len(text)} chars; see source events>\n"
    middle = "\n".join(reversed(selected))
    return text[:head_size] + marker + middle + marker + text[-tail_size:]
