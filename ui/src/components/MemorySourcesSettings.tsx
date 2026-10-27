import { useEffect, useRef, useState } from "react";
import { t as tr, type MessageKey } from "../../electron/i18n.mjs";
import { cleoClient } from "../services/cleoClient";
import type { MemorySourceSettings, MemorySourcesState } from "../types";

const yesNo = (value: boolean) => tr(value ? "memorysources.yes" : "memorysources.no");
const statusKeys: Record<string, MessageKey> = {
  unknown: "memorysources.state_unknown", configured_enabled: "memorysources.state_configured_enabled",
  disabled: "memorysources.state_disabled", available: "memorysources.state_available",
  unavailable: "memorysources.state_unavailable", unsupported: "memorysources.state_unsupported",
  read_error: "memorysources.state_read_error", partial: "memorysources.state_partial",
  different_native_target: "memorysources.state_different_native_target",
  verified: "memorysources.state_verified", conflict: "memorysources.state_conflict",
  retry: "memorysources.state_retry", retained: "memorysources.state_retained",
};
const statusLabel = (value: string) => tr(statusKeys[value] ?? statusKeys.unknown);

export function MemorySourcesSettings({ active }: { active: boolean }) {
  const [state, setState] = useState<MemorySourcesState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [root, setRoot] = useState("");
  const [id, setId] = useState("");
  const [project, setProject] = useState("");
  const [kind, setKind] = useState<"markdown" | "codex" | "claude">("markdown");
  useEffect(() => {
    if (!active) return;
    let current = true;
    void cleoClient.getMemorySources().then(result => { if (current) setState(result); })
      .catch(error => { if (current) setError(String(error)); });
    return () => { current = false; };
  }, [active]);
  const save = async (settings: MemorySourceSettings) => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try { setState(await cleoClient.saveMemorySources(settings)); }
    catch (error) { setError(String(error)); }
    finally { saving.current = false; setBusy(false); }
  };
  return <section className="memory-sources-settings" aria-label={tr("memorysources.title")}>
    <h3>{tr("memorysources.title")}</h3>
    <p>{tr("memorysources.description")}</p>
    {error && <p role="alert">{error}</p>}
    {state && <>
      {state.sources.map(source => <div className="settings-row" key={source.id}>
        <div><strong>{source.id}</strong><p>{source.root}</p>
          <p>{tr("memorysources.installed")}: {yesNo(source.installed)} · {tr("memorysources.configured")}: {yesNo(source.configured)} · {tr("memorysources.readable")}: {yesNo(source.readable_memory)}</p>
          <p>{tr("memorysources.native_generation")}: {statusLabel(source.native_auto_update?.generation ?? "unknown")} · {statusLabel(source.status)}</p>
          {source.native_migration && <div>
            <p>{tr("memorysources.migration")}: {statusLabel(source.native_migration.status)} · {Object.entries(source.native_migration.status_counts).map(([status, count]) => `${statusLabel(status)}: ${count}`).join(" · ")}</p>
            <p>{tr("memorysources.migration_retained")}</p><code>{source.native_migration.report_path}</code>
          </div>}
          {source.error && <p role="alert">{source.error}</p>}</div>
        <label className="switch"><input type="checkbox" aria-label={`${tr("memorysources.read_source")} ${source.id}`}
          disabled={busy || source.status === "unsupported"} checked={source.enabled} onChange={event => void save({ ...state.settings,
            disabled_sources: event.target.checked ? state.settings.disabled_sources.filter(id => id !== source.id)
              : [...state.settings.disabled_sources, source.id] })} /><span /></label>
      </div>)}
      <div className="settings-row"><div><strong>{tr("memorysources.sync")}</strong><p>{tr("memorysources.sync_help")}</p></div>
        <label className="switch"><input type="checkbox" aria-label={tr("memorysources.sync")} disabled={busy}
          checked={state.settings.sync_enabled} onChange={event => void save({ ...state.settings, sync_enabled: event.target.checked })} /><span /></label>
      </div>
      <form className="memory-source-form" onSubmit={event => { event.preventDefault(); void save({ ...state.settings,
        sources: [...state.settings.sources, { id, root, kind, project_path: project || null }] }); }}>
        <label className="ms-field">{tr("memorysources.source_id")}<input required pattern="[a-z][a-z0-9_-]{0,63}" value={id} onChange={event => setId(event.target.value)} /></label>
        <label className="ms-field">{tr("memorysources.directory")}<input required value={root} onChange={event => setRoot(event.target.value)} /></label>
        <label className="ms-field">{tr("memorysources.project")}<input value={project} onChange={event => setProject(event.target.value)} /></label>
        <label className="ms-field">{tr("memorysources.format")}<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="markdown">Markdown</option><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
        <button disabled={busy} type="submit">{tr("memorysources.add")}</button>
      </form>
    </>}
  </section>;
}
