"""Attribute actual usage to durable tasks, preserving native cumulative baselines."""

import json
from pathlib import Path

from cleo.runtime.task_costs import TaskPrices
from cleo.runtime.task_scopes import normalize_boundaries
from cleo.runtime.task_tracking import LEGACY_TASK, main_model
from cleo.runtime.task_usage import counter, event_usage


def _annotate(events, task_id, model, provider):
    """Purpose: Bind events to their recorded turn/task/model. Output: transient annotations."""
    result = []
    turn_message = None
    for event in events:
        data = event.get("data") or {}
        if event.get("type") == "task_boundary":
            task_id, model, provider = data["task_id"], data.get("model"), data.get("provider")
        if event.get("type") == "user_message":
            turn_message = len(result)
        message = (event.get("message") or {}).get("data") or {}
        metadata = message.get("response_metadata") or {}
        actual_model = metadata.get("model_name") or metadata.get("model") or model
        if not isinstance(actual_model, str):
            actual_model = None
        if turn_message is not None and (metadata.get("model_name") or metadata.get("model")):
            # API aliases may resolve to a dated model name. Attribute the input turn
            # to that reported model instead of creating an extra unknown alias call.
            result[turn_message]["_model"] = actual_model
            turn_message = None
        result.append({**event, "_task": task_id, "_model": actual_model,
                       "_provider": provider})
    return result


def _evaluation_part(evaluation, part="子任务评估与分配"):
    """Purpose: Account a real classifier/evaluator call, including unknown usage. Output: row."""
    usage = evaluation.get("usage") or {}
    total = counter(usage.get("total_tokens"))
    incoming, outgoing = counter(usage.get("input_tokens")), counter(usage.get("output_tokens"))
    if total is None and incoming is not None and outgoing is not None:
        total = incoming + outgoing
    complete = total is not None and incoming is not None and outgoing is not None
    return {"role": "evaluator", "part": part, "model": evaluation.get("model"),
            "provider": evaluation.get("provider") or evaluation.get("backend"),
            "total": total, "input": incoming, "output": outgoing,
            "cacheRead": counter(usage.get("cache_read_input_tokens")),
            "cacheWrite": counter(usage.get("cache_creation_input_tokens")),
            "reportedCostUsd": usage.get("reported_cost_usd"),
            "reportedCalls": int(total is not None), "missingCalls": int(not complete),
            "complete": complete}


def _sum(parts):
    """Purpose: Sum known consumption without treating missing telemetry as zero. Output: totals."""
    contributors = [part for part in parts if part["reportedCalls"] or part["missingCalls"]
                    or part["total"] is not None]
    result = {}
    for field in ("total", "input", "output", "cacheRead", "cacheWrite", "reportedCostUsd"):
        known = [part[field] for part in contributors if part.get(field) is not None]
        covered = bool(known) if field == "total" else bool(known) and len(known) == len(
            contributors)
        result[field] = sum(known) if covered else None
    return {**result, "reportedCalls": sum(part["reportedCalls"] for part in parts),
            "missingCalls": sum(part["missingCalls"] for part in parts),
            "complete": all(part["complete"] for part in parts)}


def scoped_usage(store, root, root_events):
    """Purpose: Read current and previous goal ledgers without inference or mutation.

    Input: Session store, root manifest and full root events. Output: active totals,
    per-model consumption and previous task summaries. Worker task IDs are captured when
    delegated, so a late worker/evaluator result cannot leak into the next task.
    """
    root_events, legacy = normalize_boundaries(root["id"], root_events)
    boundaries = [event for event in root_events if event.get("type") == "task_boundary"]
    active = boundaries[-1]["data"]["task_id"]
    tasks = {LEGACY_TASK: {"taskId": LEGACY_TASK, "taskNumber": 0,
                           "boundaryStatus": "legacy", "scope": "session_history"}}
    parts = {LEGACY_TASK: []}
    for event in boundaries:
        data = event["data"]
        task = tasks.setdefault(data["task_id"], {
            "taskId": data["task_id"], "taskNumber": data["number"],
            "scope": "task", "createdAt": event.get("created_at"),
            "coverage": data.get("coverage", "full_task"),
        })
        task["boundaryStatus"] = data["status"]
        if data.get("abstract"):
            task.update(abstract=data["abstract"], abstractSource=data.get("abstract_source"))
        task["boundaryReason"] = (data.get("evaluation") or {}).get("reason")
        parts.setdefault(data["task_id"], [])
        evaluation = data.get("evaluation") or {}
        if evaluation.get("called"):
            parts[data["task_id"]].append(_evaluation_part(evaluation, "任务边界判断"))
    records = {}
    for event in root_events:
        if event.get("type") == "task_title":
            data = event.get("data") or {}
            if data.get("task_id") in tasks:
                tasks[data["task_id"]]["title"] = data["title"]
    for path in (Path(store.memory_root) / ".routing/tasks").glob("task_*.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            records[record.get("task_id") or path.stem] = record
        except (OSError, ValueError, TypeError, KeyError):
            continue
    manifests = {root["id"]: root}
    for row in store.list_sessions():
        try:
            manifests[row["id"]] = store.load_manifest(row["id"])
        except (ValueError, OSError):
            continue
    included = {root["id"]: LEGACY_TASK}
    for _ in range(len(manifests)):
        children = {key: item.get("usage_task_id") or included[item["parent_session_id"]]
                    for key, item in manifests.items()
                    if key not in included and item.get("parent_session_id") in included}
        if not children:
            break
        if legacy:
            for key, binding in children.items():
                item = manifests[key]
                if (item["parent_session_id"] == root["id"]
                        or included[item["parent_session_id"]] == legacy.task_id):
                    # A retry/upgrade can be spawned after another goal starts. Its
                    # logical delegation start, rather than the new process time, owns usage.
                    record_id = item.get("routing_task_id")
                    record = records.get(record_id) or {}
                    started_at = record.get("created_at") if record_id else item.get("created_at")
                    children[key] = legacy.resolve(binding, started_at)
        included.update(children)
    for session_id, inherited_task in included.items():
        manifest = manifests[session_id]
        assessment = (records.get(manifest.get("routing_task_id")) or {}).get("assessment") or {}
        worker_part = assessment.get("part") or {
            "coding": "代码实现", "bug_fix": "问题修复", "terminal": "命令执行",
            "research": "资料研究", "analysis": "分析", "exploration": "探索",
        }.get(assessment.get("task_type"), "子任务（职责未记录）")
        events = _annotate(root_events if session_id == root["id"]
                           else store.read_events(session_id), inherited_task,
                           None if session_id == root["id"] else main_model(manifest),
                           manifest.get("provider"))
        groups = {(event["_task"], event["_model"], event["_provider"]) for event in events
                  if event.get("type") != "task_boundary"}
        for task_id, model, provider in sorted(groups, key=str):
            if task_id not in parts:
                continue
            group = (task_id, model, provider)
            usage = event_usage(events, include=lambda event, group=group: (
                event["_task"], event["_model"], event["_provider"]) == group)
            if usage["total"] is not None or usage["missingCalls"]:
                parts[task_id].append({**usage, "model": model, "provider": provider,
                                       "part": "主任务执行与调度" if session_id == root["id"]
                                       else worker_part,
                                       "role": "main" if session_id == root["id"] else "worker"})
    for record in records.values():
        try:
            evaluation = record.get("evaluator") or {}
            task_id = record.get("usage_task_id") or LEGACY_TASK
            parent = record.get("parent_session_id")
            if legacy and (parent == root["id"] or included.get(parent) == legacy.task_id):
                task_id = legacy.resolve(task_id, record.get("created_at"))
            if (record.get("parent_session_id") in included and task_id in parts
                    and evaluation.get("status") in {"completed", "failed", "cancelled"}
                    and evaluation.get("called", bool(evaluation.get("model")))):
                parts[task_id].append(_evaluation_part(evaluation))
        except (OSError, ValueError, TypeError):
            continue
    summaries = {}
    prices = TaskPrices(store.memory_root)
    for task_id, task_parts in parts.items():
        groups = {}
        for part in task_parts:
            groups.setdefault(part.get("model"), []).append(part)
        models = [{"provider": ", ".join(sorted({part["provider"] for part in group
                                               if part.get("provider")})),
                   "model": model, **_sum(group),
                   "parts": [{"part": label, **_sum([part for part in group
                                                      if part["part"] == label])}
                             for label in dict.fromkeys(part["part"] for part in group)]}
                  for model, group in groups.items()]
        for model in models:
            model.update(prices.reference(model))
        costs = [model["referenceUsd"] for model in models]
        summaries[task_id] = {**tasks[task_id], **_sum(task_parts), "breakdown": task_parts,
                             "models": models, "referenceUsd": sum(costs)
                             if costs and all(cost is not None for cost in costs) else None}
    return {**summaries[active], "history": [summary for key, summary in summaries.items()
                                            if key != active and (
                                                key != LEGACY_TASK or parts[LEGACY_TASK])][-20:]}
