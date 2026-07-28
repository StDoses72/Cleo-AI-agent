"""Merge Cleo-managed sessions with browse-only native harness history."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from cleo.harnesses.control import NativeSession


def merge_session_rows(
    managed: list[dict[str, Any]],
    native: tuple[NativeSession, ...] = (),
    *,
    provider: str = "codex",
) -> list[dict[str, Any]]:
    """把 Cleo 托管会话与 native harness 历史会话合并成统一的 hub 行列表。

    参数:
        managed: SessionStore.list_sessions() 返回的索引行, 实际调用见
            cleo/cli/productivity.py:437(store.list_sessions())。
        native: native harness 侧发现的会话, 来自
            cleo/cli/productivity.py 中 _load_productivity_catalog 返回的
            native_page.sessions(只浏览, 不由 Cleo 管理)。
        provider: harness 提供方标识(如 "codex"), 由调用方传入
            session.provider, 用于匹配 managed 行的归属。
    返回:
        按 updated_at 倒序排列的行列表; 托管行标记 origin 为
        "cleo"/"cleo+native", 纯 native 行标记为 "native"。结果被
        cleo/cli/productivity.py:435 传给 cli.render_session_hub 渲染,
        也被 tests/sessions/test_hub.py 验证。
    """
    linked = {
        str(row.get("native_session_id")): row
        for row in managed
        if row.get("provider") == provider and row.get("native_session_id")
    }
    rows: list[dict[str, Any]] = []
    for row in managed:
        merged = dict(row)
        merged["origin"] = (
            "cleo+native"
            if str(row.get("native_session_id") or "") in linked
            else "cleo"
        )
        rows.append(merged)

    for thread in native:
        managed_row = linked.get(thread.id)
        if managed_row is not None:
            for row in rows:
                if row.get("id") == managed_row.get("id"):
                    row["status"] = thread.status
                    row["updated_at"] = thread.updated_at
                    row["title"] = thread.name or thread.preview
                    row["source"] = thread.source
                    break
            continue
        rows.append(
            {
                "id": thread.id,
                "native_session_id": thread.id,
                "space": "productivity",
                "project": Path(thread.cwd).name or "external",
                "provider": provider,
                "status": thread.status,
                "cwd": thread.cwd,
                "created_at": thread.created_at,
                "updated_at": thread.updated_at,
                "origin": "native",
                "title": thread.name or thread.preview,
                "source": thread.source,
            }
        )
    return sorted(rows, key=lambda row: str(row.get("updated_at") or ""), reverse=True)
