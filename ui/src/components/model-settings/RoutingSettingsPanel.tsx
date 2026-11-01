import { useEffect, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { cleoClient } from "../../services/cleoClient";
import type { RoutingCandidate, RoutingSettings } from "../../routing-types";
import "./routing-settings.css";
import { RoutingStrategyControls } from "./RoutingStrategyControls";
import { BenchmarkConnectionPanel } from "./BenchmarkConnectionPanel";
import { BenchmarkCalibration } from "./BenchmarkCalibration";
import { SearchablePicker } from "./SearchablePicker";
import { modelGroups, selectModels } from "./routing-options";

const tiers = { economy: "经济", balanced: "均衡", strong: "强能力" };
const costs = { api: "API · 按用量", subscription: "订阅 · 消耗额度", unknown: "成本未知" };
const label = (item: RoutingCandidate) => `${item.provider} / ${item.model}${item.effort ? ` · ${item.effort}` : ""}`;
const supportLabel = (item: RoutingCandidate) => item.statusReason === "model_unsupported" ? "此账号与 harness 不支持 · 已排除"
  : item.statusReason === "effort_unsupported" ? "不支持此推理档位 · 已排除"
  : item.available === true ? (item.availabilitySource === "normal_execution" ? "正常执行已确认" : "连接元数据确认支持")
  : item.available === null ? "账号支持情况未知 · 未启用" : "连接当前不可用 · 未启用";

export function RoutingSettingsPanel({ active, client = cleoClient }: {
  active: boolean;
  client?: Pick<typeof cleoClient, "getRoutingSettings" | "saveRoutingSettings" | "refreshRoutingBenchmarks" | "saveBenchmarkConnection" | "submitRoutingFeedback">;
}) {
  const [value, setValue] = useState<RoutingSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const run = async (operation: () => Promise<RoutingSettings>, saved = false) => {
    setBusy(true); setError(""); setMessage("");
    try {
      setValue(await operation()); setDirty(false);
      if (saved) setMessage("已保存");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "暂时无法读取路由配置，请重试。");
    } finally { setBusy(false); }
  };
  useEffect(() => { if (active) void run(() => client.getRoutingSettings()); }, [active, client]);
  const edit = (patch: Partial<RoutingSettings>) => {
    setValue(current => current && ({ ...current, ...patch })); setDirty(true); setMessage("");
  };
  const changeCandidate = (id: string, patch: Partial<RoutingCandidate>) => {
    if (value) edit({ candidates: value.candidates.map(item => item.id === id ? { ...item, ...patch } : item) });
  };
  const save = () => value && run(() => client.saveRoutingSettings({
    revision: value.revision, enabled: value.enabled, preference: value.preference,
    fallbackCandidate: value.fallbackCandidate,
    defaultMode: value.defaultMode, evaluator: value.evaluator,
    permissionPreset: value.permissionPreset ?? "inherit",
    strategy: value.strategy, feedbackEnabled: value.feedbackEnabled,
    taskTrackingEnabled: value.taskTrackingEnabled,
    candidates: value.candidates.map(({ id, enabled, tier, modelVersion, benchmarkRecordId }) => ({ id, enabled, tier, modelVersion, benchmarkRecordId })),
  }), true);

  if (!value) return <div className="routing-panel" aria-busy={busy}>
    {error ? <><p className="settings-error" role="alert">{error}</p><button className="settings-action" onClick={() => void run(() => client.getRoutingSettings())}>重新加载路由</button></>
      : <p className="routing-note" role="status">正在读取执行目录…</p>}
  </div>;
  const enabled = value.candidates.filter(item => item.enabled && item.available === true);
  const groups = modelGroups(value.candidates);
  const fallbackGroup = groups.find(group => group.variants.some(item => item.id === value.fallbackCandidate));
  const fallback = value.candidates.find(item => item.id === value.fallbackCandidate);
  const benchmark = value.benchmark;
  return <div className="routing-panel routing-compact" aria-busy={busy}>
    <div className="routing-row"><div><h3>子任务路由</h3><p>评估 → 分配 → 交接 → 验收</p></div>
      <label className="switch"><input type="checkbox" aria-label="自动路由" checked={value.enabled} disabled={busy} onChange={event => edit({ enabled: event.target.checked })} /><span /></label>
    </div>
    <div className="routing-row routing-field"><label>默认模式</label><select aria-label="默认执行方式" value={value.defaultMode ?? "auto"} disabled={busy} onChange={event => edit({ defaultMode: event.target.value as RoutingSettings["defaultMode"] })}>
      <option value="manual">指定模型</option><option value="auto" disabled={!value.enabled}>子任务路由</option></select></div>
    <RoutingStrategyControls value={value} busy={busy} edit={edit} />
    <div className="routing-row routing-field"><label htmlFor="routing-permission-preset">执行权限</label>
      <select id="routing-permission-preset" aria-label="路由执行权限" value={value.permissionPreset ?? "inherit"}
        disabled={busy} title="统一用于主执行模型与子 agent；保存后下次运行生效。不支持对应权限的 harness 不参与执行。"
        onChange={event => edit({ permissionPreset: event.target.value as RoutingSettings["permissionPreset"] })}>
        <option value="inherit">沿用会话权限</option><option value="ask">请求批准</option>
        <option value="review">帮我审批</option><option value="full">完全访问</option>
      </select>
    </div>
    <div className="routing-row routing-field"><label>可用模型</label>
      <SearchablePicker label="路由模型" multiple disabled={busy} selected={groups.filter(group => group.enabled).map(group => group.id)}
        options={groups.map(group => ({ value: group.id, label: group.model, group: `${group.connection} · ${group.backend}`, disabled: !group.available,
          detail: group.available ? undefined : supportLabel(group.variants[0]) }))}
        onChange={selected => edit({ candidates: selectModels(value.candidates, selected) })} />
    </div>
    <div className="routing-row routing-field"><label>优先考虑</label><select aria-label="路由选择偏好" value={value.preference} disabled={busy} onChange={event => edit({ preference: event.target.value as RoutingSettings["preference"] })}>
      <option value="quality">质量</option><option value="cost">成本</option><option value="latency">速度</option></select></div>
    <div className="routing-row routing-field"><label>保守回退</label>
      <SearchablePicker label="保守回退模型" disabled={busy} selected={fallbackGroup ? [fallbackGroup.id] : []}
        options={groups.filter(group => group.enabled).map(group => ({ value: group.id, label: group.model, group: group.connection }))}
        onChange={([id]) => { const group = groups.find(item => item.id === id); const variants = group?.variants.filter(item => item.enabled && item.available === true) ?? [];
          edit({ fallbackCandidate: variants.find(item => item.effort === "high")?.id ?? variants[0]?.id ?? null }); }} />
    </div>
    {value.enabled && (!fallback || !fallback.enabled || fallback.available !== true) && <p role="alert" className="settings-error">请选择可用的回退模型</p>}
    <section className="routing-section" aria-label="Benchmark 数据">
      <div className="routing-section-heading"><h3>模型能力与价格</h3><button className="settings-action" disabled={busy || dirty || !benchmark.keyConfigured} onClick={() => void run(() => client.refreshRoutingBenchmarks())}><RefreshCw size={13} />更新数据</button></div>
      <BenchmarkConnectionPanel value={value} disabled={busy || dirty} onSave={update => run(() => client.saveBenchmarkConnection(update))} />
    </section>
    <details className="routing-details routing-section"><summary>高级设置</summary>
      <div className="routing-row"><label>分配方式<select aria-label="子任务分配方式" value={value.strategy ?? "rules"} disabled={busy} onChange={event => edit({ strategy: event.target.value as RoutingSettings["strategy"] })}>
        <option value="evaluator">评估器与排名</option><option value="rules">确定性规则</option></select></label>
        <button className="settings-action" disabled={busy || dirty} onClick={() => void run(() => client.getRoutingSettings(true))}><RefreshCw size={13} />刷新模型目录</button></div>
      <label className="routing-show-all"><input type="checkbox" checked={value.feedbackEnabled ?? true} disabled={busy} onChange={event => edit({ feedbackEnabled: event.target.checked })} />使用已确认的本地反馈</label>
      <label className="routing-show-all"><input type="checkbox" checked={value.taskTrackingEnabled ?? false} disabled={busy} onChange={event => edit({ taskTrackingEnabled: event.target.checked })} />按任务统计用量</label>
      <p>推理档位由评估器在已启用组合中选择。自动升级{value.automaticUpgrade ? "受限开启" : "已关闭"}。</p>
      <details className="routing-details"><summary>模型档位与评测校准</summary>
        <label className="routing-show-all"><input type="checkbox" checked={showAll} onChange={event => setShowAll(event.target.checked)} />显示全部组合</label>
        {(showAll ? value.candidates : enabled).map(item => <div className="routing-candidate" key={item.id}>
          <input type="checkbox" aria-label={`启用 ${label(item)}`} checked={item.enabled} disabled={busy || (item.available !== true && !item.enabled)} onChange={event => changeCandidate(item.id, { enabled: event.target.checked })} />
          <div><strong>{label(item)}</strong><small>{supportLabel(item)} · {costs[item.costType]}</small></div>
          <select aria-label={`${label(item)} 能力档位`} value={item.tier} disabled={busy} onChange={event => changeCandidate(item.id, { tier: event.target.value as RoutingCandidate["tier"] })}>
            {Object.entries(tiers).map(([key, text]) => <option key={key} value={key}>{text}</option>)}
          </select><BenchmarkCalibration key={`${item.id}:${item.benchmarkRecordId}`} candidate={item} records={benchmark.records ?? []} disabled={busy} onChange={patch => changeCandidate(item.id, patch)} />
        </div>)}
      </details>
    <section className="routing-section" aria-label="最近委派">
      <h3>最近委派</h3>
      {value.recentTasks.length ? value.recentTasks.map(task => <div className="routing-task" key={task.id}>
        <strong>{task.candidate || "未选择配置"}</strong><span>{task.status === "completed" ? "执行完成" : task.status} · {task.acceptance === "unknown" ? "验收未知" : task.acceptance === "passed" ? "验收通过" : "验收未通过"}</span>
        {!!task.reasons?.length && <details><summary>分配依据</summary><p>{task.reasons.join(" · ")}</p></details>}
        {task.candidate && task.status !== "running" && <div className="routing-row">
          <label>任务反馈<select aria-label={`${task.id} 反馈`} disabled={busy || dirty} value={`${task.feedback?.outcome ?? "unknown"}:${task.feedback?.attribution ?? "unknown"}`} onChange={event => {
            const [outcome, attribution] = event.target.value.split(":");
            void run(() => client.submitRoutingFeedback({ task_id: task.id, outcome: outcome as import("../../routing-types").RoutingFeedback["outcome"], attribution: attribution as import("../../routing-types").RoutingFeedback["attribution"], revision: task.feedback?.revision ?? 0 }));
          }}>
            <option value="unknown:unknown">未知 · 待归因</option><option value="passed:executor">结果通过</option>
            <option value="failed:executor">执行质量有问题</option><option value="failed:selection">模型选择不合适</option>
            <option value="failed:decomposition">拆分有问题</option><option value="failed:handoff">交接丢失信息</option>
            <option value="failed:environment">工具或环境问题</option><option value="requirements_changed:requirements">需求发生变化</option>
            <option value="retracted:unknown">撤回反馈</option>
          </select></label>
        </div>}
      </div>) : <p className="routing-note">还没有真实委派记录。正常执行后会记录选择及结果，无需额外运行评测。</p>}
    </section>
    </details>
    <div className="routing-footer">
      <div aria-live="polite">{error ? <span className="settings-error" role="alert">{error}</span> : message || (dirty ? "有未保存的修改" : "主会话模型保持不变")}</div>
      <button className="settings-primary" disabled={busy || !dirty} onClick={() => void save()}><Save size={14} />{busy ? "处理中…" : "保存路由配置"}</button>
    </div>
  </div>;
}
