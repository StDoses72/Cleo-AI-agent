"""Space-bound SQLite indexes for durable memory and compact session history."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import uuid
from collections.abc import Iterable
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from cleo.memory.compaction import load_validated_compact
from cleo.memory.paths import memory_database_path, validate_space

MEMORY_CATEGORIES = {
    "fact",
    "decision",
    "constraint",
    "correction",
    "preference",
    "action",
    "pattern",
    "artifact",
    "question",
}

_CJK_SEQUENCE = re.compile(r"[㐀-䶿一-鿿]+")
_WORD = re.compile(r"[a-z0-9_][a-z0-9_.-]*", re.IGNORECASE)


def _settings() -> Any:
    """函数调用期解析 memory store 使用的配置单例。

    模块级 `settings` 名称被测试 monkeypatch 替换时(见
    tests/memory/test_pipeline.py 对 cleo.memory.store 的注入)优先
    返回注入值; 否则惰性导入 cleo.config.settings 并返回其当前
    settings 单例, 避免 import 期二次绑定配置对象(import 本模块
    不再触发配置加载, 运行期替换 cleo.config.settings.settings
    亦生效)。
    """
    injected = globals().get("settings")
    if injected is not None:
        return injected
    from cleo.config.settings import settings

    return settings


def __getattr__(name: str) -> Any:
    """模块级惰性属性: 保留 `cleo.memory.store.settings` 这一测试注入点。

    monkeypatch.setattr(cleo.memory.store, "settings", fake) 前会先
    getattr 校验名称存在, 此处经 _settings() 返回当前配置单例即满足;
    setattr 后注入值写入模块 globals, 由 _settings() 优先命中。
    """
    if name == "settings":
        return _settings()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def _now_iso() -> str:
    """返回当前 UTC 时间的 ISO 8601 字符串, 供 created_at/updated_at 等字段使用。"""
    return datetime.now(UTC).isoformat()


def _database_path(space: str, path: Path | None) -> Path:
    """解析 space 级 SQLite 数据库路径, 优先使用调用方显式覆盖。

    参数:
        space: memory space; 来自各公开函数的会话上下文, 内部做校验。
        path: 可选路径覆盖; 来自 sessions/store.py 传入的
            memory_database_path 结果或测试注入, None 时回落
            settings.MEMORY_DIR。

    返回:
        memory.sqlite3 的 Path, 供 _connect 与 ensure_memory_database 使用。
    """
    validate_space(space)
    return path or memory_database_path(_settings().MEMORY_DIR, space)


def _connect(space: str, path: Path | None = None) -> sqlite3.Connection:
    """打开 space 级 SQLite 连接并启用 foreign_keys 与 WAL。

    参数:
        space: memory space; 来自各公开函数或 ensure_memory_database。
        path: 可选数据库路径覆盖; 同 _database_path 的来源。

    返回:
        已设置 row_factory 的 sqlite3.Connection; 调用方以 closing()
        管理生命周期并在 with conn: 块中提交事务。
    """
    database_path = _database_path(space, path)
    database_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(database_path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def ensure_memory_database(space: str, path: Path | None = None) -> Path:
    """确保 space 级 SQLite 库存在并建齐 memory/chunk/consolidation 各表与索引。

    参数:
        space: memory space; 来自 upsert_memory、search_memories 等公开
            函数的会话上下文。
        path: 可选数据库路径覆盖; 同 _database_path 的来源。

    返回:
        数据库文件 Path; 调用方大多不消费返回值, 仅依赖建表副作用
        (sessions/store.py 之外的测试会直接使用)。
    """
    database_path = _database_path(space, path)
    with closing(_connect(space, database_path)) as conn, conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS memory_entries (
                id TEXT PRIMARY KEY,
                space TEXT NOT NULL,
                project TEXT NOT NULL,
                category TEXT NOT NULL,
                subject TEXT NOT NULL,
                content TEXT NOT NULL,
                confidence REAL NOT NULL DEFAULT 1.0,
                importance INTEGER NOT NULL DEFAULT 3,
                status TEXT NOT NULL DEFAULT 'active',
                tags_json TEXT NOT NULL DEFAULT '[]',
                fingerprint TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_memory_entries_scope
                ON memory_entries(space, project, status, category, updated_at);

            CREATE TABLE IF NOT EXISTS memory_evidence (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                memory_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
                space TEXT NOT NULL,
                project TEXT NOT NULL,
                session_id TEXT NOT NULL,
                event_id TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                observed_at TEXT NOT NULL,
                UNIQUE(memory_id, space, project, session_id, event_id, source_hash)
            );
            CREATE INDEX IF NOT EXISTS idx_memory_evidence_source
                ON memory_evidence(space, project, session_id, source_hash);

            CREATE TABLE IF NOT EXISTS memory_consolidations (
                id TEXT PRIMARY KEY,
                space TEXT NOT NULL,
                project TEXT NOT NULL,
                session_id TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                summary_markdown TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(space, project, session_id, source_hash)
            );

            CREATE TABLE IF NOT EXISTS conversation_chunks (
                id TEXT PRIMARY KEY,
                space TEXT NOT NULL,
                project TEXT NOT NULL,
                session_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                event_ids_json TEXT NOT NULL,
                content TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                created_at TEXT,
                ended_at TEXT,
                updated_at TEXT NOT NULL,
                UNIQUE(space, project, session_id, chunk_index)
            );
            CREATE INDEX IF NOT EXISTS idx_conversation_chunks_scope
                ON conversation_chunks(space, project, updated_at);
            """
        )
    return database_path


def _normalize_text(value: str) -> str:
    """把文本 casefold 并折叠空白, 供 fingerprint 与 lexical 匹配使用。

    参数:
        value: 原始文本; 来自 _memory_fingerprint 的各字段与
            _lexical_score 的 query/subject/content/tags。

    返回:
        规范化后的字符串, 供调用方比较或分词。
    """
    return " ".join(value.casefold().split())


def _memory_fingerprint(
    space: str,
    project: str,
    category: str,
    subject: str,
    content: str,
) -> str:
    """对记忆五元组计算 SHA-256 fingerprint, 作为幂等 upsert 的去重键。

    参数:
        space: memory space; 来自 upsert_memory 校验后的入参。
        project: 项目名; 同来源。
        category: 记忆类别; 同来源 (已 casefold)。
        subject: 记忆主题; 同来源。
        content: 记忆正文; 同来源。

    返回:
        hex digest; 被 upsert_memory 用作 memory_entries.fingerprint 唯一键
        并派生确定性 memory_id。
    """
    canonical = "\n".join(
        _normalize_text(value)
        for value in (space, project, category, subject, content)
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def _clean_tags(tags: Iterable[str] | None) -> list[str]:
    """清洗标签列表: strip、去空、去重、排序。

    参数:
        tags: 原始标签; 来自 upsert_memory/search_memories 的调用方
            (dream_agent_tools 的 DreamAgent 入参或 memory_tools 的
            交互 agent 工具入参)。

    返回:
        排序后的去重标签列表, 供 tags_json 存储与 tag_filter 过滤使用。
    """
    return sorted({str(tag).strip() for tag in (tags or []) if str(tag).strip()})


def _row_to_memory(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    """把 memory_entries 行连同其 evidence 组装为对外返回的 memory dict。

    参数:
        conn: 打开的数据库连接; 来自 upsert_memory/search_memories 的
            with 块内连接。
        row: memory_entries 查询行; 同来源的 SELECT 结果。

    返回:
        含 evidence 列表与 evidence_count 的 memory dict; 被
        remember_durable_knowledge 工具与 search_long_term_memory 工具
        序列化后返回给 agent。
    """
    evidence = conn.execute(
        """
        SELECT space, project, session_id, event_id, source_hash, observed_at
        FROM memory_evidence WHERE memory_id = ?
        ORDER BY observed_at, id
        """,
        (row["id"],),
    ).fetchall()
    return {
        "id": row["id"],
        "space": row["space"],
        "project": row["project"],
        "category": row["category"],
        "subject": row["subject"],
        "content": row["content"],
        "confidence": row["confidence"],
        "importance": row["importance"],
        "status": row["status"],
        "tags": json.loads(row["tags_json"] or "[]"),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "evidence": [dict(item) for item in evidence],
        "evidence_count": len(evidence),
    }


def upsert_memory(
    *,
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    category: str,
    subject: str,
    content: str,
    evidence_event_ids: list[str],
    confidence: float = 1.0,
    importance: int = 3,
    tags: list[str] | None = None,
    path: Path | None = None,
) -> dict[str, Any]:
    """Upsert one scoped atomic memory with immutable event evidence.

    以 fingerprint 幂等写入一条 durable memory: 已存在时合并 tags 并提升
    confidence/importance, 同时追加不可变 evidence 行。

    参数:
        space: memory space; 来自 dream_agent_tools.py
            remember_durable_knowledge 的工具入参 (DreamAgent 按 prompt
            中的会话上下文传入)。
        project: 项目名; 同来源。
        session_id: 会话 ID; 同来源。
        source_hash: 当前 compact 投影的 source_content_hash; 同来源, 已在
            工具内与 load_validated_compact 比对。
        category: 记忆类别, 必须属于 MEMORY_CATEGORIES; 由 DreamAgent 选择。
        subject: 记忆主题; 由 DreamAgent 生成。
        content: 记忆正文; 由 DreamAgent 生成。
        evidence_event_ids: 证据事件 ID 列表; 已在 remember_durable_knowledge
            中与 _valid_evidence_ids 校验, 至少一个。
        confidence: 置信度 0-1; DreamAgent 入参, 默认 1.0。
        importance: 重要度 1-5; DreamAgent 入参, 默认 3。
        tags: 可选标签; DreamAgent 入参。
        path: 可选数据库路径覆盖, 供测试注入。

    返回:
        含 evidence 的 memory dict; 被 remember_durable_knowledge 取 id /
        category / evidence_count 组 JSON 返回给 DreamAgent。
    """
    space = validate_space(space)
    category = category.strip().casefold()
    subject = subject.strip()
    content = content.strip()
    if category not in MEMORY_CATEGORIES:
        raise ValueError(f"unsupported memory category: {category}")
    if not project.strip() or not session_id.strip() or not source_hash.strip():
        raise ValueError("project, session_id, and source_hash are required")
    if not subject or not content:
        raise ValueError("memory subject and content are required")
    evidence_ids = list(dict.fromkeys(str(item).strip() for item in evidence_event_ids))
    evidence_ids = [item for item in evidence_ids if item]
    if not evidence_ids:
        raise ValueError("at least one evidence event id is required")
    if not 0 <= confidence <= 1:
        raise ValueError("confidence must be between 0 and 1")
    if not 1 <= importance <= 5:
        raise ValueError("importance must be between 1 and 5")

    ensure_memory_database(space, path)
    fingerprint = _memory_fingerprint(space, project, category, subject, content)
    memory_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"cleo-memory:{fingerprint}"))
    now = _now_iso()
    clean_tags = _clean_tags(tags)
    with closing(_connect(space, path)) as conn, conn:
        row = conn.execute(
            "SELECT * FROM memory_entries WHERE fingerprint = ?",
            (fingerprint,),
        ).fetchone()
        if row is None:
            conn.execute(
                """
                INSERT INTO memory_entries(
                    id, space, project, category, subject, content, confidence,
                    importance, status, tags_json, fingerprint, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
                """,
                (
                    memory_id,
                    space,
                    project,
                    category,
                    subject,
                    content,
                    confidence,
                    importance,
                    json.dumps(clean_tags, ensure_ascii=False),
                    fingerprint,
                    now,
                    now,
                ),
            )
        else:
            memory_id = row["id"]
            merged_tags = _clean_tags([*json.loads(row["tags_json"] or "[]"), *clean_tags])
            conn.execute(
                """
                UPDATE memory_entries
                SET confidence = MAX(confidence, ?), importance = MAX(importance, ?),
                    tags_json = ?, status = 'active', updated_at = ?
                WHERE id = ?
                """,
                (
                    confidence,
                    importance,
                    json.dumps(merged_tags, ensure_ascii=False),
                    now,
                    memory_id,
                ),
            )

        for event_id in evidence_ids:
            conn.execute(
                """
                INSERT OR IGNORE INTO memory_evidence(
                    memory_id, space, project, session_id, event_id,
                    source_hash, observed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (memory_id, space, project, session_id, event_id, source_hash, now),
            )
        row = conn.execute(
            "SELECT * FROM memory_entries WHERE id = ?",
            (memory_id,),
        ).fetchone()
        return _row_to_memory(conn, row)


def _search_tokens(value: str) -> set[str]:
    """把文本切分为检索 token 集合: 拉丁词 + CJK 单字/二元组 (bigram)。

    参数:
        value: 待分词文本; 来自 _lexical_score 的 query 与候选文本。

    返回:
        token 集合, 供 _lexical_score 计算 coverage 重叠。
    """
    normalized = _normalize_text(value)
    tokens = set(_WORD.findall(normalized))
    for sequence in _CJK_SEQUENCE.findall(normalized):
        if len(sequence) == 1:
            tokens.add(sequence)
        else:
            tokens.update(sequence[index : index + 2] for index in range(len(sequence) - 1))
    return tokens


def _lexical_score(query: str, subject: str, content: str, tags: list[str]) -> float:
    """计算 query 与候选文本的本地词法相关度得分 (无向量, 纯 token 重叠)。

    参数:
        query: 检索词; 来自 search_memories/search_conversation_history 的
            工具入参。
        subject: 候选记忆主题; 来自 memory_entries.subject (chunk 检索时
            传空串)。
        content: 候选正文; 来自 memory_entries.content 或
            conversation_chunks.content。
        tags: 候选标签; 来自 tags_json 解析结果 (chunk 检索时传空列表)。

    返回:
        加权得分 (coverage*3 + subject_coverage*1.5 + phrase_bonus), 0 表示
        不相关; 调用方按得分排序并过滤。
    """
    normalized_query = _normalize_text(query)
    if not normalized_query:
        return 0.0
    subject_text = _normalize_text(subject)
    combined = _normalize_text(" ".join([subject, content, *tags]))
    query_tokens = _search_tokens(normalized_query)
    if not query_tokens:
        return 0.0
    combined_tokens = _search_tokens(combined)
    subject_tokens = _search_tokens(subject_text)
    shared = query_tokens & combined_tokens
    if not shared and normalized_query not in combined:
        return 0.0
    coverage = len(shared) / len(query_tokens)
    subject_coverage = len(query_tokens & subject_tokens) / len(query_tokens)
    phrase_bonus = 1.0 if normalized_query in combined else 0.0
    return coverage * 3.0 + subject_coverage * 1.5 + phrase_bonus


def search_memories(
    *,
    space: str,
    project: str,
    query: str = "",
    categories: list[str] | None = None,
    tags: list[str] | None = None,
    limit: int = 10,
    path: Path | None = None,
) -> list[dict[str, Any]]:
    """按 space+project 范围检索 active durable memory, 支持类别/标签过滤与词法打分。

    参数:
        space: memory space; 来自 memory_tools.py search_long_term_memory
            或 dream_agent_tools.py _atomic_memory_markdown 的绑定上下文。
        project: 项目名; 同来源。
        query: 检索词; 来自 agent 工具入参, 空串时按 importance/更新时间
            列出全部。
        categories: 可选类别过滤; agent 工具入参。
        tags: 可选标签过滤 (子集匹配); agent 工具入参。
        limit: 返回上限 (1-100); agent 工具入参。
        path: 可选数据库路径覆盖, 供测试注入。

    返回:
        按得分降序的 memory dict 列表 (含 score 字段); 被
        search_long_term_memory 序列化给交互 agent, 被
        _atomic_memory_markdown 渲染进 MEMORY.md。
    """
    space = validate_space(space)
    ensure_memory_database(space, path)
    limit = max(1, min(int(limit), 100))
    category_filter = {item.strip().casefold() for item in (categories or []) if item.strip()}
    tag_filter = {item.casefold() for item in _clean_tags(tags)}
    with closing(_connect(space, path)) as conn, conn:
        rows = conn.execute(
            """
            SELECT * FROM memory_entries
            WHERE space = ? AND project = ? AND status = 'active'
            ORDER BY importance DESC, updated_at DESC
            """,
            (space, project),
        ).fetchall()
        scored: list[tuple[float, dict[str, Any]]] = []
        for row in rows:
            if category_filter and row["category"] not in category_filter:
                continue
            row_tags = json.loads(row["tags_json"] or "[]")
            if tag_filter and not tag_filter.issubset({item.casefold() for item in row_tags}):
                continue
            score = _lexical_score(query, row["subject"], row["content"], row_tags)
            if query.strip() and score <= 0:
                continue
            item = _row_to_memory(conn, row)
            item["score"] = round(score, 4)
            scored.append((score + row["importance"] * 0.01, item))
        scored.sort(key=lambda pair: (pair[0], pair[1]["updated_at"]), reverse=True)
        return [item for _, item in scored[:limit]]


def record_consolidation(
    *,
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    summary_markdown: str,
    path: Path | None = None,
) -> None:
    """记录一次 consolidation 产出的 MEMORY.md 快照 (按 source_hash 幂等覆盖)。

    参数:
        space: memory space; 来自 dream_agent_tools.py
            write_memory_to_markdown 的工具入参。
        project: 项目名; 同来源。
        session_id: 会话 ID; 同来源。
        source_hash: 当前 compact 投影的 source_content_hash; 同来源, 已在
            工具内校验。
        summary_markdown: 渲染完成的 MEMORY.md 全文; 同来源的
            PROJECT_MEMORY_TEMPLATE 渲染结果。
        path: 可选数据库路径覆盖, 供测试注入。

    返回:
        无返回值; 写入 memory_consolidations 表, 供 has_consolidation 在
        complete_memory_consolidation 中校验执行顺序。
    """
    space = validate_space(space)
    ensure_memory_database(space, path)
    identity = f"cleo-consolidation:{space}:{project}:{session_id}:{source_hash}"
    consolidation_id = str(uuid.uuid5(uuid.NAMESPACE_URL, identity))
    with closing(_connect(space, path)) as conn, conn:
        conn.execute(
            """
            INSERT INTO memory_consolidations(
                id, space, project, session_id, source_hash,
                summary_markdown, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(space, project, session_id, source_hash) DO UPDATE SET
                summary_markdown = excluded.summary_markdown,
                created_at = excluded.created_at
            """,
            (
                consolidation_id,
                space,
                project,
                session_id,
                source_hash,
                summary_markdown,
                _now_iso(),
            ),
        )


def has_consolidation(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    *,
    path: Path | None = None,
) -> bool:
    """判断指定 source_hash 是否已有 consolidation 记录 (MEMORY.md 已写入)。

    参数:
        space: memory space; 来自 dream_agent_tools.py
            complete_memory_consolidation 的工具入参。
        project: 项目名; 同来源。
        session_id: 会话 ID; 同来源。
        source_hash: 当前 compact 投影的 source_content_hash; 同来源。
        path: 可选数据库路径覆盖, 供测试注入。

    返回:
        True 表示 record_consolidation 已成功; 被
        complete_memory_consolidation 用来强制
        write_memory_to_markdown 先于完成提交执行。
    """
    ensure_memory_database(space, path)
    with closing(_connect(space, path)) as conn, conn:
        row = conn.execute(
            """
            SELECT 1 FROM memory_consolidations
            WHERE space = ? AND project = ? AND session_id = ? AND source_hash = ?
            """,
            (space, project, session_id, source_hash),
        ).fetchone()
        return row is not None


def count_source_memories(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    *,
    path: Path | None = None,
) -> int:
    """统计指定 source_hash 下 evidence 支撑的去重记忆条数。

    参数:
        space: memory space; 来自 dream_agent_tools.py
            complete_memory_consolidation 的工具入参。
        project: 项目名; 同来源。
        session_id: 会话 ID; 同来源。
        source_hash: 当前 compact 投影的 source_content_hash; 同来源。
        path: 可选数据库路径覆盖, 供测试注入。

    返回:
        COUNT(DISTINCT memory_id); 被 complete_memory_consolidation 与
        DreamAgent 汇报的 durable_memory_count 对账, 不一致则拒绝提交。
    """
    ensure_memory_database(space, path)
    with closing(_connect(space, path)) as conn, conn:
        row = conn.execute(
            """
            SELECT COUNT(DISTINCT memory_id) AS memory_count
            FROM memory_evidence
            WHERE space = ? AND project = ? AND session_id = ? AND source_hash = ?
            """,
            (space, project, session_id, source_hash),
        ).fetchone()
        return int(row["memory_count"])


def _event_text(event: dict[str, Any]) -> str:
    """把一条 compact 事件渲染为单行可读文本, 供会话 chunk 拼接。

    参数:
        event: compact 事件 dict; 来自 _conversation_chunks 遍历的
            payload["events"]。

    返回:
        "User:/Assistant:/Tool ..." 等前缀格式的文本行, 供
        _conversation_chunks 组装 chunk content。
    """
    event_type = event.get("type")
    content = event.get("content")
    if event_type == "human":
        return f"User: {content}"
    if event_type == "ai":
        return f"Assistant: {content}"
    if event_type == "tool_event":
        result = event.get("result")
        if result is None and event.get("result_omitted"):
            result = f"<omitted:{event.get('original_result_characters', 0)} chars>"
        return (
            f"Tool {event.get('name', 'unknown')} ({event.get('status', 'unknown')}): "
            f"args={json.dumps(event.get('args', {}), ensure_ascii=False, default=str)}; "
            f"result={json.dumps(result, ensure_ascii=False, default=str)}"
        )
    return f"{event_type}: {content}"


def _conversation_chunks(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """按 human 消息切分 compact 事件流为会话 chunk 列表。

    参数:
        payload: 校验过的 compact payload; 来自 replace_conversation_chunks
            (最终源于 sessions/store.py refresh_compact 的
            write_compact_events 输出)。

    返回:
        chunk dict 列表 (index/event_ids/content/created_at/ended_at);
        被 replace_conversation_chunks 写入 conversation_chunks 表。
    """
    chunks: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for event in payload.get("events") or []:
        if not isinstance(event, dict):
            continue
        if event.get("type") == "human" and current:
            chunks.append(current)
            current = []
        current.append(event)
    if current:
        chunks.append(current)

    results: list[dict[str, Any]] = []
    for index, events in enumerate(chunks):
        event_ids: list[str] = []
        for event in events:
            event_ids.extend(str(item) for item in event.get("source_event_ids") or [])
            if event.get("id"):
                event_ids.append(str(event["id"]))
        results.append(
            {
                "index": index,
                "event_ids": list(dict.fromkeys(event_ids)),
                "content": "\n".join(_event_text(event) for event in events),
                "created_at": events[0].get("created_at"),
                "ended_at": events[-1].get("created_at"),
            }
        )
    return results


def replace_conversation_chunks(
    payload: dict[str, Any],
    *,
    path: Path | None = None,
) -> int:
    """全量替换某会话在 conversation_chunks 表中的检索 chunk。

    参数:
        payload: compact payload; 来自 sessions/store.py refresh_compact
            中 write_compact_events 的输出, 需含 space/project/session_id
            与 source.source_content_hash。
        path: 可选数据库路径覆盖; 来自 refresh_compact 传入的
            memory_database_path 结果或测试注入。

    返回:
        写入的 chunk 数量; refresh_compact 不消费返回值, 仅依赖写表
        副作用供 search_conversation_history 检索。
    """
    space = validate_space(str(payload.get("space") or ""))
    project = str(payload.get("project") or "")
    session_id = str(payload.get("session_id") or "")
    source_hash = str((payload.get("source") or {}).get("source_content_hash") or "")
    if not project or not session_id or not source_hash:
        raise ValueError("compact payload is missing project, session id, or source hash")
    chunks = _conversation_chunks(payload)
    ensure_memory_database(space, path)
    now = _now_iso()
    with closing(_connect(space, path)) as conn, conn:
        conn.execute(
            """
            DELETE FROM conversation_chunks
            WHERE space = ? AND project = ? AND session_id = ?
            """,
            (space, project, session_id),
        )
        for chunk in chunks:
            first_id = chunk["event_ids"][0] if chunk["event_ids"] else "empty"
            identity = (
                f"cleo-chunk:{space}:{project}:{session_id}:"
                f"{chunk['index']}:{first_id}"
            )
            chunk_id = str(uuid.uuid5(uuid.NAMESPACE_URL, identity))
            conn.execute(
                """
                INSERT INTO conversation_chunks(
                    id, space, project, session_id, chunk_index, event_ids_json,
                    content, source_hash, created_at, ended_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    chunk_id,
                    space,
                    project,
                    session_id,
                    chunk["index"],
                    json.dumps(chunk["event_ids"], ensure_ascii=False),
                    chunk["content"],
                    source_hash,
                    chunk["created_at"],
                    chunk["ended_at"],
                    now,
                ),
            )
    return len(chunks)


def delete_conversation_chunks(
    *,
    space: str,
    project: str,
    session_id: str,
    path: Path | None = None,
) -> None:
    """删除某会话的全部会话 chunk (会话跨项目迁移后清理旧项目下的索引)。

    参数:
        space: memory space; 来自 sessions/store.py move_session 的
            manifest["space"]。
        project: 源项目名; 同来源的 source_project。
        session_id: 会话 ID; 同来源。
        path: 可选数据库路径覆盖; move_session 传入 memory_database_path
            结果。

    返回:
        无返回值; 数据库不存在时为 no-op, 否则删除匹配行。
    """
    database_path = _database_path(validate_space(space), path)
    if not database_path.exists():
        return
    with closing(_connect(space, database_path)) as conn, conn:
        conn.execute(
            """
            DELETE FROM conversation_chunks
            WHERE space = ? AND project = ? AND session_id = ?
            """,
            (space, project, session_id),
        )


def search_conversation_history(
    *,
    space: str,
    project: str,
    query: str,
    session_ids: list[str] | None = None,
    top_k: int = 5,
    path: Path | None = None,
    memory_root: Path | None = None,
) -> list[dict[str, Any]]:
    """Lexically retrieve scoped history and reject stale compact projections.

    在 space+project 范围内做本地词法检索, 并通过 load_validated_compact
    校验每个会话的 source_hash, 丢弃与当前事件源不一致的 stale chunk。

    参数:
        space: memory space; 来自 memory_tools.py
            search_project_conversation_history 的绑定上下文。
        project: 项目名; 同来源。
        query: 检索词; agent 工具入参。
        session_ids: 可选会话过滤; agent 工具入参。
        top_k: 返回上限 (1-20); agent 工具入参, 默认 5。
        path: 可选数据库路径覆盖, 供测试注入。
        memory_root: 可选 memory 根目录覆盖; 默认 settings.MEMORY_DIR,
            供测试注入。

    返回:
        按 score 降序的 chunk dict 列表 (含 event_ids 与 retrieval 标记);
        被 search_project_conversation_history 序列化后返回给交互 agent。
    """
    space = validate_space(space)
    ensure_memory_database(space, path)
    top_k = max(1, min(int(top_k), 20))
    root = memory_root or _settings().MEMORY_DIR
    selected_sessions = {str(item) for item in (session_ids or []) if str(item)}
    with closing(_connect(space, path)) as conn, conn:
        rows = conn.execute(
            """
            SELECT * FROM conversation_chunks
            WHERE space = ? AND project = ?
            ORDER BY updated_at DESC LIMIT 1000
            """,
            (space, project),
        ).fetchall()

    current_hashes: dict[str, str | None] = {}
    results: list[dict[str, Any]] = []
    for row in rows:
        session_id = row["session_id"]
        if selected_sessions and session_id not in selected_sessions:
            continue
        if session_id not in current_hashes:
            try:
                payload = load_validated_compact(
                    memory_root=root,
                    space=space,
                    project=project,
                    session_id=session_id,
                )
                current_hashes[session_id] = (payload.get("source") or {}).get(
                    "source_content_hash"
                )
            except (OSError, json.JSONDecodeError, ValueError):
                current_hashes[session_id] = None
        if current_hashes[session_id] != row["source_hash"]:
            continue
        score = _lexical_score(query, "", row["content"], [])
        if score <= 0:
            continue
        results.append(
            {
                "space": space,
                "project": project,
                "session_id": session_id,
                "chunk_index": row["chunk_index"],
                "event_ids": json.loads(row["event_ids_json"]),
                "content": row["content"],
                "score": round(score, 4),
                "retrieval": "local_lexical_v2",
                "source_hash": row["source_hash"],
                "created_at": row["created_at"],
                "ended_at": row["ended_at"],
            }
        )
    results.sort(key=lambda item: item["score"], reverse=True)
    return results[:top_k]
