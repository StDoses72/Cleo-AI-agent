import { t as tr } from "../electron/i18n.mjs";
import type { MemoryOverview } from "./types";

export function dreamStatusLabel(agent: MemoryOverview["dream_agent"]): string {
  if (agent.running_count || agent.status === "running") return tr("memoryview.consolidating");
  if (agent.failed_count || agent.status === "attention") return tr("memoryview.consolidation_failed");
  if (agent.pending_count) return tr("memorystatus.sources_awaiting_confirmation");
  return agent.last_processed_at ? tr("memorystatus.recent_sources_processed") : tr("memorystatus.not_consolidated_yet");
}
