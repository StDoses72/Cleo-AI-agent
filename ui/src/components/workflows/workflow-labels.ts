import { getLanguage, relativeTime, t as tr } from "../../../electron/i18n.mjs";
import { effortLabels } from "../../runtime-labels";
import type { WorkflowDefinition, WorkflowExecutor, WorkflowRunStatus, WorkflowStep } from "../../workflow-types";
import type { WorkflowIssue } from "./workflow-model";

/** "Codex · gpt-5.6-sol · High"; a node without an executor follows the conversation that starts the run. */
export function executorLabel(executorId: string | null, executors: readonly WorkflowExecutor[]) {
  if (executorId === null) return tr("workflows.executor_inherit");
  const executor = executors.find((item) => item.id === executorId);
  if (!executor) return tr("workflows.executor_unknown");
  return [executor.harness, executor.model, executor.effort ? effortLabels[executor.effort] : ""].filter(Boolean).join(" · ");
}

/** One step as a few words, for a workflow's one-line outline. */
export function stepOutline(step: WorkflowStep) {
  if (step.kind === "agent") return step.role || tr("workflows.unnamed_role");
  if (step.kind === "parallel") {
    return step.fanOut === "each"
      ? tr("workflows.outline_each", { p0: step.branches[0]?.role || tr("workflows.unnamed_role") })
      : tr("workflows.outline_parallel", { p0: step.branches.length, p1: step.label || tr("workflows.parallel") });
  }
  return tr("workflows.outline_loop", {
    p0: step.body.map((node) => node.role || tr("workflows.unnamed_role")).join(" ⇄ "), p1: step.maxRounds,
  });
}

export function workflowOutline(definition: WorkflowDefinition) {
  return definition.steps.map(stepOutline);
}

export function issueText(issue: WorkflowIssue) {
  const subject = issue.subject || tr("workflows.unnamed_role");
  switch (issue.code) {
    case "name_missing": return tr("workflows.issue_name_missing");
    case "no_steps": return tr("workflows.issue_no_steps");
    case "role_missing": return tr("workflows.issue_role_missing", { p0: issue.position ?? 1 });
    case "instructions_missing": return tr("workflows.issue_instructions_missing", { p0: subject });
    case "executor_unknown": return tr("workflows.issue_executor_unknown", { p0: subject });
    case "executor_unavailable": return tr("workflows.issue_executor_unavailable", { p0: subject });
    case "branches_too_few": return tr("workflows.issue_branches_too_few", { p0: subject });
    case "each_needs_previous": return tr("workflows.issue_each_needs_previous", { p0: subject });
    case "each_needs_template": return tr("workflows.issue_each_needs_template", { p0: subject });
    case "loop_empty": return tr("workflows.issue_loop_empty", { p0: subject });
    case "judge_missing": return tr("workflows.issue_judge_missing", { p0: subject });
    case "rounds_out_of_range": return tr("workflows.issue_rounds_out_of_range", { p0: subject });
    case "items_out_of_range": return tr("workflows.issue_items_out_of_range", { p0: subject });
  }
}

export function runStatusLabel(status: WorkflowRunStatus) {
  return status === "running" ? tr("workflows.status_running")
    : status === "completed" ? tr("workflows.status_done")
    : status === "failed" ? tr("workflows.status_failed") : tr("workflows.status_cancelled");
}

/** "3 分钟前" for a moment in the past. */
export function ago(timestamp: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  const english = getLanguage() === "en";
  if (minutes < 1) return tr("memoryview.just_now");
  if (minutes < 60) return english ? relativeTime(minutes, "minute") : tr("memoryview.value_minutes_ago", { p0: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return english ? relativeTime(hours, "hour") : tr("memoryview.value_hours_ago", { p0: hours });
  return english ? relativeTime(Math.floor(hours / 24), "day") : tr("memoryview.value_days_ago", { p0: Math.floor(hours / 24) });
}

export function tokenCount(tokens: number) {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}
