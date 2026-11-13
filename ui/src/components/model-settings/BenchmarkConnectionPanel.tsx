import { useEffect, useState } from "react";
import type { BenchmarkConnectionUpdate, RoutingSettings } from "../../routing-types";
import { modelGroups } from "./routing-options";

/** Compact data health and coverage; credentials stay in an explicit expanded form. */
export function BenchmarkConnectionPanel({ value, disabled, onSave }: {
  value: RoutingSettings; disabled: boolean; onSave: (update: BenchmarkConnectionUpdate) => Promise<void>;
}) {
  const [key, setKey] = useState("");
  const [access, setAccess] = useState<"free" | "pro">("free");
  const [hours, setHours] = useState(24);
  const benchmark = value.benchmark;
  const groups = modelGroups(value.candidates).filter(group => group.enabled);
  const matched = groups.filter(group => group.variants.some(item => item.referenceGrade === "exact")).length;
  const family = groups.filter(group => !group.variants.some(item => item.referenceGrade === "exact")
    && group.variants.some(item => item.referenceGrade === "family")).length;
  useEffect(() => {
    setAccess(benchmark.access ?? "free");
    setHours((benchmark.cacheTtlSeconds ?? 86400) / 3600);
  }, [value.revision, benchmark.access, benchmark.cacheTtlSeconds]);
  const save = async (clearKey = false) => {
    try { await onSave({ revision: value.revision, access, cacheTtlSeconds: Math.round(hours * 3600),
      ...(clearKey ? { clearKey: true } : key.trim() ? { apiKey: key.trim() } : {}) }); }
    finally { setKey(""); }
  };
  return <div className="benchmark-connection">
    <div className="benchmark-health"><span className="routing-dot" data-ready={benchmark.keyConfigured} />
      <strong>{benchmark.keyConfigured ? "已配置连接" : "未配置连接"}</strong>
      <span>{benchmark.recordCount ? `${benchmark.stale ? "缓存已过期" : "缓存可用"} · ${benchmark.recordCount} 条` : "暂无数据"}</span>
      {benchmark.retrievedAt && <time dateTime={benchmark.retrievedAt}>{new Date(benchmark.retrievedAt).toLocaleString()}</time>}
    </div>
    <p className="benchmark-coverage">所选 {groups.length} 个模型 · 精确匹配 {matched} · 系列参考 {family} · 待匹配 {groups.length - matched - family}</p>
    {benchmark.error && !benchmark.error.startsWith("benchmark_cache_") && <p className="settings-error" role="status">{benchmark.error === "aa_http_401" ? "密钥无效，请更新连接" : benchmark.error === "aa_http_403" ? "当前密钥无此数据权限" : benchmark.error === "aa_http_429" ? "数据请求额度已用完，稍后重试" : "数据暂未更新"}</p>}
    <details className="routing-details"><summary>模型参考数据</summary>
      <div className="benchmark-models">{groups.map(group => {
        const exact = group.variants.find(item => item.referenceGrade === "exact");
        const variant = exact ?? group.variants.find(item => item.referenceGrade === "family");
        const record = variant?.referenceRecords?.length === 1 ? variant.referenceRecords[0] : undefined;
        return <div key={group.id} className="benchmark-model"><strong>{group.model}</strong><small>{group.connection}</small>
          <span>{exact ? "精确匹配" : variant ? "系列参考" : "未匹配"}</span>
          <small>{record ? `能力 ${record.scores.artificial_analysis_intelligence_index ?? "—"} · 输入 $${record.input_usd_per_million ?? "—"}/M · 输出 $${record.output_usd_per_million ?? "—"}/M · ${record.output_tokens_per_second ?? "—"} token/s` : "未匹配"}</small></div>;
      })}</div>
    </details>
    <details className="routing-details"><summary>数据连接设置</summary>
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <label>API Key<input type="password" autoComplete="off" aria-label="Artificial Analysis API Key" value={key} onChange={event => setKey(event.target.value)} placeholder={benchmark.keyConfigured ? "已保存，输入以更换" : "输入 API Key"} disabled={disabled} /></label>
        <div className="benchmark-connection-row"><label>数据权限<select aria-label="Benchmark API 访问级别" value={access} disabled={disabled} onChange={event => setAccess(event.target.value as "free" | "pro")}><option value="free">Free</option><option value="pro">Pro / Commercial</option></select></label>
          <label>缓存（小时）<input aria-label="Benchmark 缓存小时" type="number" min={1 / 60} max={720} step="any" required value={hours} disabled={disabled} onChange={event => setHours(Number(event.target.value))} /></label></div>
        <div className="benchmark-connection-row"><button type="submit" className="settings-action" disabled={disabled}>保存连接</button>
          {benchmark.keyConfigured && <button type="button" className="settings-action" disabled={disabled} onClick={() => void save(true)}>移除密钥</button>}</div>
      </form>
    </details>
    <p className="benchmark-source"><a href="https://artificialanalysis.ai/data-api/docs" target="_blank" rel="noreferrer">数据来源：Artificial Analysis</a></p>
  </div>;
}
