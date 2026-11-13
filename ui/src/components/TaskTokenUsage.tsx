import { t as tr } from "../../electron/i18n.mjs";
import type { TaskUsage } from "../types";

const usd = (value?: number | null) => value == null ? "—"
  : value > 0 && value < 0.0001 ? "<$0.0001" : `$${value.toFixed(4)}`;

/** Active goal only. A total that is missing reported calls says how many, on hover. */
export function TaskTokenUsage({ usage }: { usage?: TaskUsage }) {
  if (!usage || usage.scope !== "task") return <p className="muted">{tr("taskusage.waiting_for_a_task")}</p>;
  const title = usage.title || (usage.abstractSource === "evaluator" ? usage.abstract : null) || tr("computerpanel.current_task");
  return <div className="task-usage-panel">
    <p className="task-abstract">{title}</p>
    <div className="task-usage-total"><strong title={usage.missingCalls ? tr("taskusage.calls_unreported", { p0: usage.missingCalls }) : undefined}>{usage.total?.toLocaleString() ?? "—"} token</strong>
      <span>{usd(usage.referenceUsd)}</span></div>
    {!!usage.models?.length && <div className="task-usage-table" role="table" aria-label={tr("taskusage.model_usage_of_this_task")}>
      <div className="task-usage-row task-usage-head" role="row"><span role="columnheader">{tr("taskusage.model_and_role")}</span>
        <span role="columnheader">{tr("taskusage.calls")}</span><span role="columnheader">Token</span><span role="columnheader">USD</span></div>
      {usage.models.map((item, index) => <div className="task-usage-row" role="row" key={`${item.model}:${index}`}>
        <div role="cell"><span className="task-usage-model">{item.model || "—"}</span>
          <small>{[...new Set(item.parts?.map(part => part.part) ?? [])].join("、") || item.provider || ""}</small></div>
        <span role="cell">{item.reportedCalls || (item.missingCalls ? "—" : item.reportedCalls ?? "—")}</span>
        <span role="cell">{item.total?.toLocaleString() ?? "—"}</span>
        <span role="cell">{usd(item.referenceUsd)}</span>
      </div>)}
    </div>}
  </div>;
}
