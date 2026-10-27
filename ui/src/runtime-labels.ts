import { t as tr } from "../electron/i18n.mjs";
import type { Project, ReasoningEffort, RuntimeProfile, ThreadSpace } from "./types";

/** Purpose: Whether a project is the general one of its space: it binds no user folder, so
 * drafts land there when nothing else is chosen. Chat's general project is not marked managed
 * by the backend, so the reserved name counts too. */
export function isGeneralProject(project: Pick<Project, "name" | "managed"> | null | undefined) {
  return Boolean(project && (project.managed || project.name.trim().toLowerCase() === "general"));
}

/** Purpose: The name shown for a project. A general project has no name in the interface
 * (folder-less work is simply a thread), so callers fall back to their own neutral label. */
export function projectLabel(project: Pick<Project, "name" | "managed"> | null | undefined) {
  if (!project || isGeneralProject(project)) return "";
  return project.name;
}

/** Purpose: The secondary line under a project name; a general project shows no path. */
export function projectPathLabel(project: Pick<Project, "name" | "path" | "managed"> | null | undefined) {
  if (!project || isGeneralProject(project)) return "";
  return project.path;
}

/** Purpose: The projects a space lists, general first so the folder-less default is always on top.
 * Input: every project and the space on screen. Output: a new, ordered array; the backend's
 * name order is kept for the rest. Projects without a space are legacy mock entries. */
export function projectsInSpace(projects: readonly Project[], space: ThreadSpace): Project[] {
  const own = projects.filter((project) => project.space
    ? project.space === space
    : space === "chat" ? isGeneralProject(project) : !isGeneralProject(project));
  return [...own.filter(isGeneralProject), ...own.filter((project) => !isGeneralProject(project))];
}

/** Purpose: The short harness name a thread card shows: coding harness for tasks, model for chats. */
export function harnessLabel(runtime: Pick<RuntimeProfile, "provider" | "model"> | undefined, space: ThreadSpace) {
  if (!runtime) return "";
  if (space === "chat") return runtime.model || runtime.provider || "";
  const provider = (runtime.provider || "").toLowerCase();
  if (provider.startsWith("codex")) return "Codex";
  if (provider.startsWith("claude")) return "Claude";
  if (provider.startsWith("acp:")) return runtime.provider.slice(4);
  return runtime.provider || "";
}

export const effortLabels: Record<ReasoningEffort, string> = {
  get none() { return tr("runtime.off"); }, get minimal() { return tr("runtime_labels.minimal"); }, get low() { return tr("runtime_labels.low"); }, get medium() { return tr("runtime_labels.medium"); }, get high() { return tr("runtime_labels.high"); },
  get xhigh() { return tr("runtime_labels.extra_high"); }, get max() { return tr("runtime_labels.maximum"); }, get ultra() { return tr("runtime_labels.ultra"); },
};

export function accessLabel(value: string) {
  return ({ "read-only": tr("runtime_labels.read_only"), "workspace-write": tr("runtime_labels.workspace_write"), "full-access": tr("runtime_labels.full_access"),
    "danger-full-access": tr("runtime_labels.full_access"), default: tr("runtime_labels.managed_by_provider") } as Record<string, string>)[value] ?? value;
}

export function approvalLabel(value: string) {
  return ({ user: tr("runtime_labels.manual_approval"), auto_review: tr("runtime_labels.automatic_review"), deny_all: tr("runtime_labels.deny_approval_requests"),
    default: tr("runtime_labels.default_policy"), "on-request": tr("runtime_labels.approval_on_request"), untrusted: tr("runtime_labels.approve_untrusted_operations"),
    never: tr("runtime_labels.never_request_approval"), acceptEdits: tr("runtime_labels.automatically_allow_file_edits"), bypassPermissions: tr("runtime_labels.bypass_standard_approval"),
    auto: tr("runtime_labels.automatic_review"), auto_allow: tr("runtime_labels.automatically_allow_requests"), dontAsk: tr("runtime_labels.deny_approval_requests"), plan: tr("runtime_labels.plan_mode") } as Record<string, string>)[value] ?? value;
}
