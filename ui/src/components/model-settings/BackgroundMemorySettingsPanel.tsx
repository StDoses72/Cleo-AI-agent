import { getLanguage } from "../../../electron/i18n.mjs";
import { t as tr } from "../../../electron/i18n.mjs";
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
      if (current) setError(error instanceof Error ? error.message : tr("backgroundmemorysettingspanel.could_not_load_background_consolidation_settings"));
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
    } catch (error) { setError(error instanceof Error ? error.message : tr("backgroundmemorysettingspanel.could_not_save_background_consolidation_settings")); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const disabled = loading || saving || busy || !state;
  const changed = state && JSON.stringify(draft) !== JSON.stringify(toDraft(state));
  const status = !dreamEnabled ? tr("backgroundmemorysettingspanel.memory_consolidation_is_paused") : !state?.enabled ? tr("backgroundmemorysettingspanel.disabled")
    : state.running ? tr("backgroundmemorysettingspanel.consolidating_in_the_background") : state.status === "failed" ? tr("backgroundmemorysettingspanel.the_last_consolidation_failed")
    : state.status === "cancelled" ? tr("backgroundmemorysettingspanel.paused_waiting_for_the_next_consolidation") : tr("backgroundmemorysettingspanel.waiting_for_the_next_consolidation");

  return <form className="ms-background-memory" aria-label={tr("backgroundmemorysettingspanel.background_memory_consolidation_settings")} onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="settings-row">
      <div><strong>{tr("backgroundmemorysettingspanel.background_memory_consolidation")}</strong><p>{tr("backgroundmemorysettingspanel.consolidate_on_a_schedule_or_when_the_session_backlog_reaches_the_threshold_yield_to_")}</p></div>
      <label className="switch"><input type="checkbox" aria-label={tr("backgroundmemorysettingspanel.background_memory_consolidation")} checked={draft.enabled}
        disabled={disabled} onChange={event => { setDraft({ ...draft, enabled: event.target.checked }); setSaved(false); }} /><span /></label>
    </div>
    <p className="ms-muted">{tr("backgroundmemorysettingspanel.off_by_default_uses_the_memory_model_selected_above_and_may_incur_model_usage_charges")}</p>
    {!dreamEnabled && <p className="ms-muted">{tr("backgroundmemorysettingspanel.enable_and_save_memory_consolidation_above_before_background_consolidation_can_run")}</p>}
    <div className="ms-background-triggers">
      <label className="ms-field"><span>{tr("backgroundmemorysettingspanel.interval_minutes")}</span><input type="number" min="1" max="1440" step="1" required
        aria-label={tr("backgroundmemorysettingspanel.interval_minutes")} disabled={disabled} value={draft.intervalMinutes}
        onChange={event => { setDraft({ ...draft, intervalMinutes: event.target.value }); setSaved(false); }} /></label>
      <span className="ms-muted">{tr("backgroundmemorysettingspanel.or")}</span>
      <label className="ms-field"><span>{tr("backgroundmemorysettingspanel.pending_session_threshold")}</span><input type="number" min="1" max="1000" step="1" required
        aria-label={tr("backgroundmemorysettingspanel.pending_session_threshold")} disabled={disabled} value={draft.pendingThreshold}
        onChange={event => { setDraft({ ...draft, pendingThreshold: event.target.value }); setSaved(false); }} /></label>
    </div>
    {state && <div className="ms-meta" role="status"><span>{status}</span>{state.enabled && <span>{tr("backgroundmemorysettingspanel.pending")}{state.pendingCount} {tr("backgroundmemorysettingspanel.sessions")}</span>}
      {state.lastRunAt && <span>{tr("backgroundmemorysettingspanel.last_started")}{new Date(state.lastRunAt).toLocaleString(getLanguage())}</span>}</div>}
    {loading && <p className="ms-muted" role="status">{tr("backgroundmemorysettingspanel.loading_background_consolidation_settings")}</p>}
    {state?.lastError && <p className="ms-error" role="alert">{tr("backgroundmemorysettingspanel.last_background_consolidation")}{state.lastError}</p>}
    {error && <p className="ms-error" role="alert">{error}</p>}
    <div className="ms-form-actions">
      <button type="button" className="ms-link" disabled={loading || saving || Boolean(changed)} onClick={() => setReload(value => value + 1)}>{error ? tr("backgroundmemorysettingspanel.retry_loading") : tr("backgroundmemorysettingspanel.refresh_status")}</button>
      {changed && <><button type="button" className="ms-quiet" disabled={disabled} onClick={() => { setDraft(toDraft(state)); setError(""); setSaved(false); }}>{tr("backgroundmemorysettingspanel.discard_changes")}</button>
        <button type="submit" className="ms-primary" disabled={disabled}>{saving ? tr("backgroundmemorysettingspanel.saving") : tr("backgroundmemorysettingspanel.save_background_settings")}</button></>}
      {saved && <span className="ms-meta" role="status">{tr("backgroundmemorysettingspanel.background_consolidation_settings_saved")}</span>}
    </div>
  </form>;
}
