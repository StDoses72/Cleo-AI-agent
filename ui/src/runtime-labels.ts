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
  none: "关闭", minimal: "最低", low: "低", medium: "中", high: "高",
  xhigh: "很高", max: "最高", ultra: "极高",
};

export function accessLabel(value: string) {
  return ({ "read-only": "只读", "workspace-write": "工作区可写", "full-access": "完全访问",
    "danger-full-access": "完全访问", default: "由服务管理" } as Record<string, string>)[value] ?? value;
}

export function approvalLabel(value: string) {
  return ({ user: "手动审批", auto_review: "自动审查", deny_all: "拒绝审批请求",
    default: "默认策略", "on-request": "按需审批", untrusted: "审批未信任的操作",
    never: "不发起审批", acceptEdits: "自动允许文件编辑", bypassPermissions: "跳过常规审批",
    auto: "自动审查", auto_allow: "自动允许请求", dontAsk: "拒绝审批请求", plan: "规划模式" } as Record<string, string>)[value] ?? value;
}
