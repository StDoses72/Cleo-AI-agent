import { t as tr } from "../../electron/i18n.mjs";
import { Clock3 } from "lucide-react";
import type { Usage } from "../types";

/** Latest reported footprint against the selected model's actual capacity. */
export function ContextUsage({ usage }: { usage?: Usage }) {
  const valid = usage?.used != null && usage.limit > 0 && usage.used <= usage.limit;
  const ratio = valid ? Math.round((usage.used! / usage.limit) * 100) : null;
  const over = usage?.used != null && usage.limit > 0 && usage.used > usage.limit;
  const hint = `输入 ${usage?.input?.toLocaleString() ?? "—"} · 输出 ${usage?.output?.toLocaleString() ?? "—"}${over ? " · 上报值超出容量" : ""}`;
  return <div title={hint}>
    <div className="section-kicker"><Clock3 size={14} /><span>{tr("inspector.context")}</span><small>{ratio === null ? "—" : `${ratio}%`}</small></div>
    {ratio !== null && <div className="usage-track"><span style={{ width: `${ratio}%` }} /></div>}
    <div className="usage-copy"><span>{valid ? `${(usage.used! / 1000).toFixed(1)}k / ${(usage.limit / 1000).toFixed(1)}k` : "—"}</span></div>
  </div>;
}
