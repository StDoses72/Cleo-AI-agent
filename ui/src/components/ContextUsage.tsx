import { Clock3 } from "lucide-react";
import type { Usage } from "../types";

/** Latest reported footprint against the selected model's actual capacity. */
export function ContextUsage({ usage }: { usage?: Usage }) {
  const valid = usage?.used != null && usage.limit > 0 && usage.used <= usage.limit;
  const ratio = valid ? Math.round((usage.used! / usage.limit) * 100) : null;
  const hint = `最近输入 ${usage?.input?.toLocaleString() ?? "—"} · 输出 ${usage?.output?.toLocaleString() ?? "—"}。容量随模型与 harness 更新；${usage?.used != null && usage.limit > 0 && usage.used > usage.limit ? "上报值超出容量，等待更新。" : "显示最近一次调用占用，压缩后可能下降。"}`;
  return <div title={hint}>
    <div className="section-kicker"><Clock3 size={14} /><span>上下文</span><small>{ratio === null ? "—" : `${ratio}%`}</small></div>
    {ratio !== null && <div className="usage-track"><span style={{ width: `${ratio}%` }} /></div>}
    <div className="usage-copy"><span>{valid ? `${(usage.used! / 1000).toFixed(1)}k / ${(usage.limit / 1000).toFixed(1)}k` : "—"}</span></div>
  </div>;
}
