import type { ModelSettings, TaskUsage } from "../types";
import type { BenchmarkConnectionUpdate, RoutingSettings, RoutingSettingsUpdate } from "../routing-types";

/** Purpose: Call the same-origin settings bridge. Input: method/params. Output: real local data. */
async function request<T>(method: string, params = {}): Promise<T> {
  const session = await fetch("/__cleo_config/session", { cache: "no-store" });
  if (!session.ok) throw new Error("无法连接本地配置服务，请使用本地配置预览启动方式。");
  const { token } = await session.json();
  const response = await fetch("/__cleo_config/rpc", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Cleo-Preview": token },
    body: JSON.stringify({ method, params }), cache: "no-store",
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(body.error || "本地配置请求失败。");
  return body.result as T;
}

export interface TaskUsagePreview {
  sessionId: string | null;
  sessions: { id: string; label: string }[];
  usage: TaskUsage | null;
}

export const localConfigClient = {
  getTaskUsagePreview: (sessionId?: string) => request<TaskUsagePreview>("get_task_usage_preview", { session_id: sessionId }),
  getModelSettings: () => request<ModelSettings>("get_model_settings"),
  getRoutingSettings: (refresh = false) => request<RoutingSettings>("get_routing_settings", { refresh }),
  saveRoutingSettings: (update: RoutingSettingsUpdate) => request<RoutingSettings>("save_routing_settings", { update }),
  submitRoutingFeedback: (update: import("../routing-types").RoutingFeedback) => request<RoutingSettings>("submit_routing_feedback", { update }),
  refreshRoutingBenchmarks: () => request<RoutingSettings>("refresh_routing_benchmarks"),
  saveBenchmarkConnection: (update: BenchmarkConnectionUpdate) => request<RoutingSettings>("save_benchmark_connection", { update }),
};
