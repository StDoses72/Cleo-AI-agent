import type { TaskUsage } from "../types";

const usd = (value?: number | null) => value == null ? "—"
  : value > 0 && value < 0.0001 ? "<$0.0001" : `$${value.toFixed(4)}`;
const priceHint = (basis?: string | null) => basis === "reported_cost" ? "执行器上报费用"
  : "按输入、输出及可获得的缓存单价换算；订阅连接显示 API 等值费用";

/** Active goal only; missing telemetry and pricing provenance remain available on hover. */
export function TaskTokenUsage({ usage }: { usage?: TaskUsage }) {
  if (!usage || usage.scope !== "task") return <p className="muted">等待任务</p>;
  const title = usage.title || (usage.abstractSource === "evaluator" ? usage.abstract : null) || "当前任务";
  const coverage = usage.missingCalls ? `已记录用量，${usage.missingCalls} 条记录尚未完整上报` : "已记录任务用量";
  return <div className="task-usage-panel">
    <p className="task-abstract">{title}</p>
    <div className="task-usage-total"><strong title={coverage}>{usage.total?.toLocaleString() ?? "—"} token</strong>
      <span title={priceHint()}>{usd(usage.referenceUsd)}</span></div>
    {!!usage.models?.length && <div className="task-usage-table" role="table" aria-label="当前任务模型用量">
      <div className="task-usage-row task-usage-head" role="row"><span role="columnheader">模型 / 分工</span>
        <span role="columnheader">调用</span><span role="columnheader">Token</span><span role="columnheader">USD</span></div>
      {usage.models.map((item, index) => <div className="task-usage-row" role="row" key={`${item.model}:${index}`}>
        <div role="cell"><span className="task-usage-model">{item.model || "—"}</span>
          <small>{[...new Set(item.parts?.map(part => part.part) ?? [])].join("、") || item.provider || ""}</small></div>
        <span role="cell" title="已上报调用或轮次">{item.reportedCalls || (item.missingCalls ? "—" : item.reportedCalls ?? "—")}</span>
        <span role="cell" title={item.missingCalls ? "部分调用未上报用量" : undefined}>{item.total?.toLocaleString() ?? "—"}</span>
        <span role="cell" title={item.referenceUsd != null ? `${priceHint(item.priceBasis)}${item.priceMatch === "model_identifier_only" ? "；单价按相同模型标识对应，性能与推理档位尚未校准" : ""}${item.priceAsOf ? ` · ${item.priceAsOf}` : ""}` : "尚无可核实的费用"}>{usd(item.referenceUsd)}</span>
      </div>)}
    </div>}
  </div>;
}
