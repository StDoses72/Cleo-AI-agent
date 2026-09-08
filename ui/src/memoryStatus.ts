import type { MemoryOverview } from "./types";

export function dreamStatusLabel(agent: MemoryOverview["dream_agent"]): string {
  if (agent.running_count || agent.status === "running") return "正在整理";
  if (agent.failed_count || agent.status === "attention") return "整理失败，可继续重试";
  if (agent.pending_count) return "有来源等待确认";
  return agent.last_processed_at ? "最近来源已处理" : "尚未整理";
}
