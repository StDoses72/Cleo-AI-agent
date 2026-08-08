"""Evidence-aware tools used by Cleo's space-bound DreamAgent."""

from __future__ import annotations

import json
import sqlite3

from langchain.tools import tool

from cleo.config.settings import settings
from cleo.memory.compaction import load_validated_compact
from cleo.memory.paths import (
    project_directory,
    projects_directory,
    sessions_directory,
    validate_name,
    validate_space,
)
from cleo.memory.persona import render_persona_markdown, upsert_persona_trait
from cleo.memory.state import mark_consolidated
from cleo.memory.store import (
    count_source_memories,
    has_consolidation,
    record_consolidation,
    search_memories,
    upsert_memory,
)

PROJECT_MEMORY_FILENAMES = (
    "MEMORY.md",
    "decisions.md",
    "open_questions.md",
    "artifacts.md",
)
PROJECT_MEMORY_TEMPLATE = """# Project Memory: {project}

## Scope
- Space: {space}
- Last Session ID: {session_id}
- Source Hash: {source_hash}

## Executive Summary
{executive_summary}

## Facts
{facts}

## Decisions
{decisions}

## User Preferences
{preferences}

## Corrections
{corrections}

## Open Questions
{open_questions}

## Next Actions
{next_actions}

## Artifact References
{artifact_refs}

## Memory Notes
{memory_patch}

## Evidence-backed Atomic Memory
{atomic_memory}

## Excluded Noise
{excluded_noise}
"""


def _safe_project_dir(space: str, project: str):
    """校验 space/project 名称并返回项目记忆目录路径。

    被本文件的 `read_project_memory`、`write_memory_to_markdown` 和
    `_validated_compact` 调用。

    Args:
        space: 记忆空间名; 来自 tool 调用参数 (最终源自 DreamAgent
            prompt 中指定的 space)。
        project: 项目名; 来源同上。

    Returns:
        `memory/<space>/projects/<project>/` 对应的 Path;
        名称非法时由 validate_space/validate_name 抛 ValueError,
        由调用方捕获并转为 "Error: ..." 字符串返回给 LLM。
    """
    return project_directory(
        settings.MEMORY_DIR,
        validate_space(space),
        validate_name(project, "project"),
    )


def _validate_session_id(session_id: str) -> str:
    """校验 session_id 合法性 (防路径穿越) 并返回原名。

    被 `write_memory_to_markdown` 和 `_validated_compact` 调用。

    Args:
        session_id: 会话 ID; 来自 tool 调用参数。

    Returns:
        校验通过的 session_id str; 非法时抛 ValueError 由调用方转为
        "Error: ..." 返回给 LLM。
    """
    return validate_name(session_id, "session_id")


def _validated_compact(space: str, project: str, session_id: str) -> dict:
    """加载指定 space/project/session 的 validated compact 投影。

    被 `read_compact_memory`、`remember_durable_knowledge`、
    `write_memory_to_markdown`、`complete_memory_consolidation` 调用,
    是所有证据校验的统一入口。

    Args:
        space/project/session_id: 定位 compact 文件的三元组;
            来自各 tool 的调用参数 (DreamAgent prompt 指定)。

    Returns:
        compact payload dict (含 events 与 source.source_content_hash);
        调用方用它校验 source_hash 与 evidence event IDs。
    """
    _safe_project_dir(space, project)
    _validate_session_id(session_id)
    return load_validated_compact(
        memory_root=settings.MEMORY_DIR,
        space=space,
        project=project,
        session_id=session_id,
    )


def _format_markdown_items(value: str) -> str:
    """把自由文本规范化为 Markdown 列表片段, 空内容回退 "- None"。

    仅被 `write_memory_to_markdown` 调用, 用于渲染 MEMORY.md 各小节。

    Args:
        value: DreamAgent 通过 tool 参数传入的某一小节原始文本。

    Returns:
        格式化后的 Markdown 片段 str, 嵌入 PROJECT_MEMORY_TEMPLATE。
    """
    text = (value or "").strip()
    if not text:
        return "- None"
    lines = [line.rstrip() for line in text.splitlines() if line.strip()]
    if not lines:
        return "- None"
    if all(line.lstrip().startswith(("-", "*", "1.")) for line in lines):
        return "\n".join(lines)
    if len(lines) == 1:
        return lines[0]
    return "\n".join(f"- {line}" for line in lines)


def _valid_evidence_ids(payload: dict) -> set[str]:
    """从 compact payload 收集全部可引用的 evidence event ID。

    仅被 `remember_durable_knowledge` 调用, 用于校验 LLM 提供的
    evidence_event_ids 是否真实存在于 compact source 中。

    Args:
        payload: `_validated_compact` 返回的 compact dict。

    Returns:
        合法 event ID 集合 (含 event.id 与 event.source_event_ids);
        调用方据此拒绝未知 ID。
    """
    valid: set[str] = set()
    for event in payload.get("events") or []:
        if not isinstance(event, dict):
            continue
        if event.get("id"):
            valid.add(str(event["id"]))
        valid.update(str(item) for item in event.get("source_event_ids") or [])
    return valid


def _validated_source(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
) -> dict:
    """Load a compact projection and verify the caller's source hash."""
    payload = _validated_compact(space, project, session_id)
    current_hash = str((payload.get("source") or {}).get("source_content_hash") or "")
    if source_hash != current_hash:
        raise ValueError("source_hash does not match the current compact projection")
    return payload


def _validated_evidence(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    evidence_event_ids: list[str],
) -> list[str]:
    """Return de-duplicated evidence IDs after validating them against the source."""
    payload = _validated_source(space, project, session_id, source_hash)
    requested_ids = list(dict.fromkeys(str(item) for item in evidence_event_ids))
    missing_ids = [item for item in requested_ids if item not in _valid_evidence_ids(payload)]
    if missing_ids:
        raise ValueError(f"unknown evidence event ids: {', '.join(missing_ids)}")
    return requested_ids


def _stored_result(record: dict) -> str:
    """Serialize the common result returned by evidence-backed storage tools."""
    return json.dumps(
        {
            "status": "stored",
            "id": record["id"],
            "category": record["category"],
            "evidence_count": record["evidence_count"],
        },
        ensure_ascii=False,
    )


def _atomic_memory_markdown(space: str, project: str) -> str:
    """按 category 渲染该项目的全部原子记忆为 Markdown 片段。

    仅被 `write_memory_to_markdown` 调用, 填充模板的
    "Evidence-backed Atomic Memory" 小节。

    Args:
        space/project: 记忆定位参数; 来自 `write_memory_to_markdown`
            的同名参数。

    Returns:
        分类后的 Markdown str (无记忆时为 "- None"), 嵌入 MEMORY.md。
    """
    memories = search_memories(space=space, project=project, limit=100)
    if not memories:
        return "- None"
    sections: list[str] = []
    by_category: dict[str, list[dict]] = {}
    for memory in memories:
        by_category.setdefault(memory["category"], []).append(memory)
    for category in sorted(by_category):
        sections.append(f"### {category.title()}")
        for memory in by_category[category]:
            evidence = memory["evidence"]
            sources = ", ".join(
                f"{item['session_id']}#{item['event_id']}" for item in evidence[:5]
            )
            if len(evidence) > 5:
                sources += f", +{len(evidence) - 5} more"
            sections.append(
                f"- **{memory['subject']}** - {memory['content']} "
                f"(evidence: {sources})"
            )
    return "\n".join(sections)


@tool
def read_compact_memory(space: str, project: str, session_id: str) -> str:
    """Read one validated, redacted compact session projection.

    中文说明: 读取经 hash 校验与脱敏的 compact 会话投影, 是
    DreamAgent 整理记忆的唯一合法输入源。注册于 dream.py 的
    DreamAgent.toolist, 由 langchain agent 按 prompt 步骤 1 调用。

    Args:
        space/project/session_id: 定位 compact 文件的三元组;
            由 LLM 按 invoke prompt 中给出的值传入。

    Returns:
        compact payload 的 JSON 格式化 str; 失败时为 "Error: ..."。
        由 langchain 框架作为 tool message 回传给 DreamAgent LLM。
    """
    try:
        payload = _validated_compact(space, project, session_id)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        return f"Error: {exc}"
    return json.dumps(payload, ensure_ascii=False, indent=2, default=str)


@tool
def list_all_session_ids(space: str, project: str) -> list[str]:
    """List session IDs within one explicit space and project.

    中文说明: 列出指定 space/project 下的全部 session ID。注册于
    dream.py 的 DreamAgent.toolist, 由 langchain agent 调用。

    Args:
        space/project: 记忆定位参数; 由 LLM 按 prompt 指定值传入。

    Returns:
        排序后的 session ID 列表 (非法或不存在时为 []); 由框架
        回传给 DreamAgent LLM 供其核对整理范围。
    """
    try:
        root = sessions_directory(settings.MEMORY_DIR, space, project)
    except ValueError:
        return []
    if not root.exists():
        return []
    return sorted(path.name for path in root.iterdir() if path.is_dir())


@tool
def list_all_project_names(space: str) -> list[str]:
    """List project names inside one memory space.

    中文说明: 列出指定 space 下的全部项目名。注册于 dream.py 的
    DreamAgent.toolist, 由 langchain agent 调用。

    Args:
        space: 记忆空间名; 由 LLM 按 prompt 指定值传入。

    Returns:
        排序后的项目名列表 (非法或不存在时为 []); 由框架回传给
        DreamAgent LLM。
    """
    try:
        root = projects_directory(settings.MEMORY_DIR, validate_space(space))
    except ValueError:
        return []
    if not root.exists():
        return []
    return sorted(path.name for path in root.iterdir() if path.is_dir())


@tool
def read_project_memory(space: str, project: str) -> str:
    """Read inspectable long-term memory for one space-bound project.

    中文说明: 读取项目现有长期记忆 (MEMORY.md/decisions.md 等),
    供 DreamAgent 在整理时保留既有 durable context。注册于 dream.py
    的 DreamAgent.toolist (invoke prompt 步骤 2)。

    Args:
        space/project: 记忆定位参数; 由 LLM 按 prompt 指定值传入。

    Returns:
        各记忆文件拼接的 Markdown str (无内容时为空串, 非法时为
        "Error: ..."); 由框架回传给 DreamAgent LLM。
    """
    try:
        directory = _safe_project_dir(space, project)
    except ValueError as exc:
        return f"Error: {exc}"
    if not directory.exists():
        return ""
    sections = []
    for filename in PROJECT_MEMORY_FILENAMES:
        path = directory / filename
        if path.is_file():
            content = path.read_text(encoding="utf-8-sig").strip()
            if content:
                sections.append(f"# {filename}\n\n{content}")
    return "\n\n---\n\n".join(sections)


@tool
def read_global_persona() -> str:
    """Read Cleo's global descriptive persona projection.

    The persona is shared across projects and spaces, but it contains only
    interaction style and relationship tendencies. It is not a policy source.
    """
    try:
        return render_persona_markdown(
            memory_root=settings.MEMORY_DIR,
            persona_path=settings.PERSONA_PATH,
        )
    except (OSError, sqlite3.Error) as exc:
        return f"Error: {exc}"


@tool
def remember_global_persona_trait(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    category: str,
    trait: str,
    evidence_event_ids: list[str],
    confidence: float = 1.0,
    importance: int = 3,
    tags: list[str] | None = None,
) -> str:
    """Store one project-independent persona tendency with validated evidence.

    Valid categories are communication, expression, relationship, adaptation,
    and boundary. Never use this for project facts, permissions, policies,
    secrets, tool behavior, or a one-off conversational mood.
    """
    try:
        requested_ids = _validated_evidence(
            space,
            project,
            session_id,
            source_hash,
            evidence_event_ids,
        )
        persona = upsert_persona_trait(
            memory_root=settings.MEMORY_DIR,
            category=category,
            trait=trait,
            space=space,
            project=project,
            session_id=session_id,
            source_hash=source_hash,
            evidence_event_ids=requested_ids,
            confidence=confidence,
            importance=importance,
            tags=tags,
        )
        render_persona_markdown(
            memory_root=settings.MEMORY_DIR,
            persona_path=settings.PERSONA_PATH,
        )
    except (OSError, json.JSONDecodeError, sqlite3.Error, ValueError) as exc:
        return f"Error: {exc}"
    return _stored_result(persona)


@tool
def remember_durable_knowledge(
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
) -> str:
    """Store one durable memory with validated event evidence.

    中文说明: 写入一条原子记忆, 强制校验 source_hash 与
    evidence_event_ids 均来自当前 compact source (防幻觉证据)。
    注册于 dream.py 的 DreamAgent.toolist (invoke prompt 步骤 3)。

    Args:
        space/project/session_id: 记忆定位三元组; 由 LLM 按 prompt
            指定值传入。
        source_hash: 当前 compact source 的内容 hash; 由 LLM 从
            invoke prompt / read_compact_memory 结果取得。
        category: 记忆分类 (fact/decision/preference 等); LLM 生成。
        subject: 记忆主体简述; LLM 生成。
        content: 记忆正文; LLM 生成。
        evidence_event_ids: 支撑该记忆的 event ID 列表; 必须出现在
            compact source 中, 否则报错。
        confidence: 置信度 0-1, 默认 1.0; LLM 评估给出。
        importance: 重要度, 默认 3; LLM 评估给出。
        tags: 可选标签列表; LLM 生成。

    Returns:
        JSON str (status/id/category/evidence_count), 失败时为
        "Error: ..."; 由框架回传给 DreamAgent LLM 确认写入结果。
    """
    try:
        requested_ids = _validated_evidence(
            space,
            project,
            session_id,
            source_hash,
            evidence_event_ids,
        )
        memory = upsert_memory(
            space=space,
            project=project,
            session_id=session_id,
            source_hash=source_hash,
            category=category,
            subject=subject,
            content=content,
            evidence_event_ids=requested_ids,
            confidence=confidence,
            importance=importance,
            tags=tags,
        )
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        return f"Error: {exc}"
    return _stored_result(memory)


@tool
def write_memory_to_markdown(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    executive_summary: str = "",
    facts: str = "",
    decisions: str = "",
    preferences: str = "",
    corrections: str = "",
    open_questions: str = "",
    next_actions: str = "",
    artifact_refs: str = "",
    memory_patch: str = "",
    excluded_noise: str = "",
) -> str:
    """Atomically render project memory for a validated session source.

    中文说明: 校验 source_hash 后, 用 PROJECT_MEMORY_TEMPLATE 渲染并
    原子写入 MEMORY.md (tmp + replace), 同时 record_consolidation。
    注册于 dream.py 的 DreamAgent.toolist (invoke prompt 步骤 7)。

    Args:
        space/project/session_id: 记忆定位三元组; 由 LLM 按 prompt
            指定值传入。
        source_hash: 当前 compact source 的内容 hash; 必须匹配,
            否则拒绝写入。
        executive_summary/facts/decisions/preferences/corrections/
        open_questions/next_actions/artifact_refs/memory_patch/
        excluded_noise: MEMORY.md 各小节文本, 均由 LLM 整理生成,
            默认空串。

    Returns:
        "Project memory written to <path>" 或 "Error: ..." str;
        由框架回传给 DreamAgent LLM, 成功是其调用
        complete_memory_consolidation 的前置条件。
    """
    try:
        directory = _safe_project_dir(space, project)
        safe_session_id = _validate_session_id(session_id)
        _validated_source(space, project, safe_session_id, source_hash)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        return f"Error: {exc}"

    directory.mkdir(parents=True, exist_ok=True)
    memory_path = directory / "MEMORY.md"
    content = PROJECT_MEMORY_TEMPLATE.format(
        space=space,
        project=project,
        session_id=safe_session_id,
        source_hash=source_hash,
        executive_summary=(executive_summary or "No durable summary provided.").strip(),
        facts=_format_markdown_items(facts),
        decisions=_format_markdown_items(decisions),
        preferences=_format_markdown_items(preferences),
        corrections=_format_markdown_items(corrections),
        open_questions=_format_markdown_items(open_questions),
        next_actions=_format_markdown_items(next_actions),
        artifact_refs=_format_markdown_items(artifact_refs),
        memory_patch=(memory_patch or "No additional notes.").strip(),
        atomic_memory=_atomic_memory_markdown(space, project),
        excluded_noise=_format_markdown_items(excluded_noise),
    ).rstrip() + "\n"

    temp_path = memory_path.with_suffix(".md.tmp")
    temp_path.write_text(content, encoding="utf-8")
    temp_path.replace(memory_path)
    record_consolidation(
        space=space,
        project=project,
        session_id=safe_session_id,
        source_hash=source_hash,
        summary_markdown=content,
    )
    return f"Project memory written to {memory_path}"


@tool
def complete_memory_consolidation(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    durable_memory_count: int,
    no_durable_memory_reason: str = "",
) -> str:
    """Commit consolidation after Markdown and atomic evidence are consistent.

    中文说明: 整理协议的最后一步: 校验 source_hash、确认
    write_memory_to_markdown 已成功、核对原子记忆数量一致后, 调用
    mark_consolidated 落盘完成状态。注册于 dream.py 的
    DreamAgent.toolist (invoke prompt 步骤 8); DreamAgent.invoke 随后
    通过 get_session_source 验证 consolidated_hash。

    Args:
        space/project/session_id: 记忆定位三元组; 由 LLM 按 prompt
            指定值传入。
        source_hash: 当前 compact source 的内容 hash; 必须匹配。
        durable_memory_count: LLM 自报的本次原子记忆数量; 与
            count_source_memories 的实际数量不一致时报错。
        no_durable_memory_reason: 数量为 0 时的 no-op 理由; LLM 给出。

    Returns:
        JSON str (status="complete", source_version, ...), 失败时为
        "Error: ..."; 由框架回传给 DreamAgent LLM。
    """
    try:
        _validated_source(space, project, session_id, source_hash)
        if not has_consolidation(space, project, session_id, source_hash):
            raise ValueError("write_memory_to_markdown must succeed before completion")
        actual_count = count_source_memories(space, project, session_id, source_hash)
        if durable_memory_count != actual_count:
            raise ValueError(
                "durable_memory_count does not match the evidence-backed source count "
                f"({actual_count})"
            )
        entry = mark_consolidated(
            space,
            project,
            session_id,
            source_hash,
            durable_memory_count=durable_memory_count,
            no_durable_memory_reason=no_durable_memory_reason,
        )
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        return f"Error: {exc}"
    return json.dumps(
        {
            "status": "complete",
            "space": space,
            "project": project,
            "session_id": session_id,
            "source_version": entry["source_version"],
            "durable_memory_count": durable_memory_count,
        },
        ensure_ascii=False,
    )
