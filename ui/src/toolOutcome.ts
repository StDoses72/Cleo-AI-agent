import type { TimelineItem } from "./types";

type ToolItem = Extract<TimelineItem, { type: "tool" }>;

/** Purpose: One rule for "this tool call failed", used by the timeline and the details panel alike:
 * the harness says so, or a command exited with a non-zero code. */
export function toolFailed(tool: ToolItem) {
  return tool.status === "error" || (typeof tool.exitCode === "number" && tool.exitCode !== 0);
}
