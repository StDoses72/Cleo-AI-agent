import { useEffect, useRef, useState } from "react";
import { cleoClient } from "../../services/cleoClient";
import type { BackgroundMemoryState } from "../../types";

const toDraft = (state: BackgroundMemoryState) => ({ enabled: state.enabled,
  intervalMinutes: String(state.intervalMinutes), pendingThreshold: String(state.pendingThreshold) });

export function BackgroundMemorySettingsPanel({ active, busy, dreamEnabled }: {
  active: boolean; busy: boolean; dreamEnabled: boolean;
}) {
  const [state, setState] = useState<BackgroundMemoryState | null>(null);
  const [draft, setDraft] = useState({ enabled: false, intervalMinutes: "30", pendingThreshold: "5" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!active) return;
    let current = true;
    setLoading(true);
    setError("");
    setSaved(false);
    void cleoClient.getBackgroundMemoryState().then(result => {
      if (!current) return;
      setState(result);
      setDraft(toDraft(result));
    }).catch(error => {
      if (current) setError(error instanceof Error ? error.message : "无法读取后台整理设置");
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [active, reload]);

  const save = async () => {
    if (savingRef.current || loading || busy) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const result = await cleoClient.saveBackgroundMemorySettings({ enabled: draft.enabled,
        intervalMinutes: Number(draft.intervalMinutes), pendingThreshold: Number(draft.pendingThreshold) });
      setState(result);
      setDraft(toDraft(result));
      setSaved(true);
    } catch (error) { setError(error instanceof Error ? error.message : "无法保存后台整理设置"); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const disabled = loading || saving || busy || !state;
  const changed = state && JSON.stringify(draft) !== JSON.stringify(toDraft(state));
  const status = !dreamEnabled ? "记忆整理已暂停" : !state?.enabled ? "未开启"
    : state.running ? "正在后台整理" : state.status === "failed" ? "上次整理失败"
    : state.status === "cancelled" ? "已暂停，等待下次整理" : "等待下次整理";

  return <form className="ms-background-memory" aria-label="后台记忆整理设置" onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="settings-row">
      <div><strong>后台记忆整理</strong><p>定时或会话积压达到阈值时自动整理；有对话任务运行时让路。</p></div>
      <label className="switch"><input type="checkbox" aria-label="后台记忆整理" checked={draft.enabled}
        disabled={disabled} onChange={event => { setDraft({ ...draft, enabled: event.target.checked }); setSaved(false); }} /><span /></label>
    </div>
    <p className="ms-muted">默认关闭。沿用上方的记忆模型，开启后可能产生模型调用费用。</p>
    {!dreamEnabled && <p className="ms-muted">请先在上方启用记忆整理并保存，后台整理才会运行。</p>}
    <div className="ms-background-triggers">
      <label className="ms-field"><span>整理间隔（分钟）</span><input type="number" min="1" max="1440" step="1" required
        aria-label="整理间隔（分钟）" disabled={disabled} value={draft.intervalMinutes}
        onChange={event => { setDraft({ ...draft, intervalMinutes: event.target.value }); setSaved(false); }} /></label>
      <span className="ms-muted">或</span>
      <label className="ms-field"><span>待整理会话数</span><input type="number" min="1" max="1000" step="1" required
        aria-label="待整理会话数" disabled={disabled} value={draft.pendingThreshold}
        onChange={event => { setDraft({ ...draft, pendingThreshold: event.target.value }); setSaved(false); }} /></label>
    </div>
    {state && <div className="ms-meta" role="status"><span>{status}</span>{state.enabled && <span>待整理 {state.pendingCount} 个会话</span>}
      {state.lastRunAt && <span>上次开始 {new Date(state.lastRunAt).toLocaleString()}</span>}</div>}
    {loading && <p className="ms-muted" role="status">正在读取后台整理设置…</p>}
    {state?.lastError && <p className="ms-error" role="alert">上次后台整理：{state.lastError}</p>}
    {error && <p className="ms-error" role="alert">{error}</p>}
    <div className="ms-form-actions">
      <button type="button" className="ms-link" disabled={loading || saving || Boolean(changed)} onClick={() => setReload(value => value + 1)}>{error ? "重试读取" : "刷新状态"}</button>
      {changed && <><button type="button" className="ms-quiet" disabled={disabled} onClick={() => { setDraft(toDraft(state)); setError(""); setSaved(false); }}>取消更改</button>
        <button type="submit" className="ms-primary" disabled={disabled}>{saving ? "保存中…" : "保存后台设置"}</button></>}
      {saved && <span className="ms-meta" role="status">后台整理设置已保存</span>}
    </div>
  </form>;
}
