import { SearchablePicker } from "./SearchablePicker";
import type { RoutingSettings } from "../../routing-types";

/** One model picker for default, API and harness evaluator connections. */
export function RoutingStrategyControls({ value, busy, edit }: {
  value: RoutingSettings; busy: boolean; edit: (patch: Partial<RoutingSettings>) => void;
}) {
  const evaluator = value.evaluator ?? { mode: "default", profile_id: null, model: null, timeout_seconds: 60 };
  const options = [{ value: "default", label: "跟随新对话默认模型", group: value.evaluatorDefault?.model },
    ...(evaluator.mode === "main" ? [{ value: "main", label: "当前任务主模型", group: "现有设置" }] : []),
    ...(value.evaluatorConnections ?? []).flatMap(connection => connection.models.map(model => ({
      value: JSON.stringify([connection.id, model]), label: model,
      group: `${connection.label} · ${connection.backend === "api" ? "API" : connection.backend}`,
    })))];
  return <div className="routing-row routing-field"><label>评估器</label>
    <SearchablePicker label="评估器模型" options={options} disabled={busy}
      selected={[evaluator.mode === "independent" ? JSON.stringify([evaluator.profile_id, evaluator.model]) : evaluator.mode]}
      onChange={([selected]) => {
        if (selected === "default" || selected === "main") edit({ evaluator: { ...evaluator, mode: selected, profile_id: null, model: null } });
        else { const [profile_id, model] = JSON.parse(selected); edit({ evaluator: { ...evaluator, mode: "independent", profile_id, model } }); }
      }} />
  </div>;
}
