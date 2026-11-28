import { getLanguage, relativeTime, t as tr } from "../../../electron/i18n.mjs";
import { effortLabels } from "../../runtime-labels";
import type { WorkflowDefinition, WorkflowHarness, WorkflowNodeFields, WorkflowPermission, WorkflowRunStatus } from "../../workflow-types";
import { layers, loopEdges, type ConnectRefusal, type WorkflowIssue } from "./workflow-model";

/** The one word a node shows for where it runs: its harness, or that it follows the conversation. */
export function harnessName(node: Pick<WorkflowNodeFields, "harness">, harnesses: readonly WorkflowHarness[]) {
  if (node.harness === null) return tr("workflows.runtime_inherit_short");
  return harnesses.find((item) => item.id === node.harness)?.label ?? node.harness;
}

/** "Claude · Claude Opus 5 · High · Fast"; a node without a harness follows the conversation that starts the run. */
export function runtimeLabel(node: Pick<WorkflowNodeFields, "harness" | "model" | "effort" | "speed">, harnesses: readonly WorkflowHarness[]) {
  if (node.harness === null) return tr("workflows.runtime_inherit");
  const harness = harnesses.find((item) => item.id === node.harness);
  const model = harness?.models.find((item) => item.id === node.model);
  if (!harness) return tr("workflows.runtime_unknown");
  // Where the harness's models have not been read, the node's own model id still says what runs.
  if (!model) return [harness.label, node.model ?? ""].filter(Boolean).join(" · ");
  return [harness.label, model.label, node.effort ? effortLabels[node.effort] : "",
    node.speed ? model.serviceTiers?.find((tier) => tier.id === node.speed)?.label ?? "" : ""].filter(Boolean).join(" · ");
}

/** Purpose: A workflow in one line: a few words per step in running order, nodes that run side
 * by side joined with ∥, and a loop marked on the node that judges it. */
export function workflowOutline(definition: WorkflowDefinition) {
  const judged = new Map(loopEdges(definition).map((edge) => [edge.from, edge.loop!.maxRounds]));
  return layers(definition).map((column) => {
    const names = column.map((node) => {
      const name = node.role || tr("workflows.unnamed_role");
      const text = node.each !== null ? tr("workflows.outline_each", { p0: name }) : name;
      return judged.has(node.id) ? tr("workflows.outline_loop", { p0: text, p1: judged.get(node.id)! }) : text;
    });
    return names.join(" ∥ ");
  });
}

export function issueText(issue: WorkflowIssue) {
  const subject = issue.subject || tr("workflows.unnamed_role");
  switch (issue.code) {
    case "name_missing": return tr("workflows.issue_name_missing");
    case "no_nodes": return tr("workflows.issue_no_nodes");
    case "start_unconnected": return tr("workflows.issue_start_unconnected");
    case "end_unconnected": return tr("workflows.issue_end_unconnected");
    case "role_missing": return tr("workflows.issue_role_missing");
    case "instructions_missing": return tr("workflows.issue_instructions_missing", { p0: subject });
    case "runtime_unknown": return tr("workflows.issue_runtime_unknown", { p0: subject });
    case "runtime_unavailable": return tr("workflows.issue_runtime_unavailable", { p0: subject });
    case "node_no_input": return tr("workflows.issue_node_no_input", { p0: subject });
    case "node_no_output": return tr("workflows.issue_node_no_output", { p0: subject });
    case "cycle": return tr("workflows.issue_cycle");
    case "loop_target": return tr("workflows.issue_loop_target", { p0: subject });
    case "loop_rounds": return tr("workflows.issue_loop_rounds", { p0: subject });
    case "loop_leak": return tr("workflows.issue_loop_leak", { p0: subject });
    case "loop_overlap": return tr("workflows.issue_loop_overlap", { p0: subject });
    case "tools_missing": return tr("workflows.issue_tools_missing", { p0: subject });
    case "each_predecessor": return tr("workflows.issue_each_predecessor", { p0: subject });
    case "each_range": return tr("workflows.issue_each_range", { p0: subject });
  }
}

/** The presets a node can be given where its harness is not known yet: every one a session has. */
export const PERMISSIONS: WorkflowPermission[] = ["ask", "review", "full"];

/** A permission preset under the name the composer gives it. */
export function permissionLabel(permission: WorkflowPermission) {
  return permission === "ask" ? tr("permissions.ask") : permission === "review" ? tr("permissions.review") : tr("runtime_labels.full_access");
}

/** Why an edge the user tried to draw was not made. */
export function refusalText(refusal: ConnectRefusal) {
  return refusal === "exists" ? tr("workflows.refused_exists")
    : refusal === "second_loop" ? tr("workflows.refused_second_loop")
    : refusal === "same" ? tr("workflows.refused_same") : tr("workflows.refused_direction");
}

export function runStatusLabel(status: WorkflowRunStatus) {
  return status === "running" ? tr("workflows.status_running")
    : status === "paused" ? tr("workflows.status_paused")
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
