import { useState } from "react";
import type { BenchmarkRecord, RoutingCandidate } from "../../routing-types";

/** Purpose: Bind exact model variants to benchmark evidence. Input: candidate/cache. Output: edit. */
export function BenchmarkCalibration({ candidate, records, disabled, onChange }: {
  candidate: RoutingCandidate; records: BenchmarkRecord[]; disabled: boolean;
  onChange: (patch: Partial<RoutingCandidate>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(candidate.modelVersion ?? "");
  const [recordId, setRecordId] = useState(candidate.benchmarkRecordId ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [search, setSearch] = useState("");
  const compatible = records.filter(record => record.family === "model" && record.version
    && record.effort === candidate.effort && `${record.name} ${record.slug}`.toLowerCase().includes(search.toLowerCase()));
  const record = records.find(item => item.id === candidate.benchmarkRecordId)
    ?? (candidate.referenceRecords?.length === 1 ? candidate.referenceRecords[0] : undefined);
  return <div className="benchmark-calibration">
    <button type="button" className="ms-link" disabled={disabled || !records.length} onClick={() => setOpen(!open)}>{candidate.benchmarkRecordId ? "修改评测校准" : "校准模型版本"}</button>
    {record && <p>AA 综合 {record.scores.artificial_analysis_intelligence_index ?? "未知"} · 编码 {record.scores.artificial_analysis_coding_index ?? "未知"} · 输出 {record.output_tokens_per_second ?? "未知"} token/s<br />参考 API 价格：输入 ${record.input_usd_per_million ?? "未知"} / 输出 ${record.output_usd_per_million ?? "未知"} 每百万 token；订阅连接实际成本另计</p>}
    {candidate.referenceGrade === "family" && <p>家族参考 · 尚未精确校准版本与推理档位，不代表此 harness 的完整 agent 表现。</p>}
    {candidate.referenceRecords && candidate.referenceRecords.length > 1 && <p>找到多个可能的 AA 变体，保留未校准状态；请确认实际模型版本。</p>}
    {open && <div className="benchmark-calibration-fields">
      <label>实际模型版本<input aria-label={`${candidate.id} 实际模型版本`} value={version} disabled={disabled} onChange={event => { setVersion(event.target.value); setConfirmed(false); }} placeholder="填写实际版本，不能仅填写可变别名" /></label>
      <input aria-label={`${candidate.id} 搜索 benchmark`} value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索榜单模型" />
      <label>相同推理档位的评测<select aria-label={`${candidate.id} Benchmark 记录`} value={recordId} disabled={disabled} onChange={event => { setRecordId(event.target.value); setConfirmed(false); }}><option value="">未匹配</option>{compatible.map(item => <option key={item.id} value={item.id}>{item.name} · 指数 v{item.version}</option>)}</select></label>
      <label className="routing-show-all"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={disabled} />我已确认实际版本与该评测相符，推理档位一致</label>
      <div><button className="settings-action" disabled={disabled || !recordId || !version.trim() || !confirmed} onClick={() => { onChange({ modelVersion: version.trim(), benchmarkRecordId: recordId }); setOpen(false); }}>应用到草稿</button>
        <button className="settings-action" disabled={disabled} onClick={() => { onChange({ modelVersion: null, benchmarkRecordId: null }); setOpen(false); }}>清除匹配</button></div>
      <p>这是明确的版本绑定，不运行推理对照测试，也不自动学习分数阈值。保存路由后生效。</p>
    </div>}
  </div>;
}
