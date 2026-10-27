import { t as tr } from "../../electron/i18n.mjs";
import { useEffect, useRef, useState } from "react";
import { Check, Download, RefreshCw, X } from "lucide-react";
import { Modal } from "./Modal";
import "./dependency-setup.css";

export interface SetupState {
  items: { id: string; title: string; ready: boolean; detail: string; action: string; optional: boolean }[];
  pendingIds?: string[];
  showOnStartup?: boolean;
  busy: boolean; checking: boolean; dismissed: boolean; restartRequired: boolean; message: string; logs: string;
}

/** Purpose: Explain prerequisites and collect an explicit installation selection.
 * Input: native setup bridge. Output: settings dialog; installers prepare the base runtime.
 */
export function DependencySetup() {
  const [state, setState] = useState<SetupState | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef(0);
  const native = window.cleoDesktop?.setup;
  useEffect(() => {
    if (!native) return;
    let alive = true;
    const inspect = async () => {
      const current = ++revision.current;
      setOpen(true);
      try {
        const next = await native("scan");
        if (!alive || current !== revision.current) return;
        setState(next);
      } catch (failure) { if (alive) { setError(String(failure)); setOpen(true); } }
    };
    const show = () => { void inspect(); };
    window.addEventListener("cleo:open-setup", show);
    return () => { alive = false; window.removeEventListener("cleo:open-setup", show); };
  }, [native]);
  useEffect(() => {
    if (!open || !native) return;
    let active = true;
    const timer = setInterval(() => {
      const current = revision.current;
      void native("status").then(next => { if (active && current === revision.current) setState(next); })
        .catch(failure => { if (active) setError(String(failure)); });
    }, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [open, native]);
  if (!native || !open) return null;
  const busy = pending || state?.busy || state?.checking;
  const close = async () => {
    try { await native("dismiss"); setOpen(false); } catch (failure) { setError(String(failure)); }
  };
  const operate = async (action: "scan" | "install", resume = false) => {
    if (pending) return;
    setPending(true); setError(""); ++revision.current;
    try {
      setState(await native(action, action === "install" ? { ids: resume ? state?.pendingIds : selected, consent: resume || consent } : {}));
      if (action === "install") { setSelected([]); setConsent(false); }
    } catch (failure) { setError((failure instanceof Error ? failure.message : String(failure)).replace(/^Error invoking remote method '[^']+': Error: /, "")); }
    finally { ++revision.current; setPending(false); }
  };
  return <Modal open className="setup-overlay" label={tr("dependencysetup.runtime_setup")} onClose={busy ? undefined : () => void close()}>
    <section className="setup-dialog">
      <header><div><h2>{tr("dependencysetup.prepare_your_environment")}</h2></div><button className="icon-button" aria-label={tr("dependencysetup.close_runtime_setup")} disabled={busy} onClick={() => void close()}><X size={18} /></button></header>
      {!state?.items.length && <p role="status">{tr("dependencysetup.checking_the_environment")}</p>}
      <div className="setup-items">{state?.items.map(item => <label className="setup-item" key={item.id}>
        {item.ready ? <Check size={18} className="setup-ready" /> : <input type="checkbox" aria-label={item.action} checked={selected.includes(item.id)} disabled={busy}
          onChange={event => { setSelected(ids => event.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id)); setConsent(false); }} />}
        <span><strong>{item.title}</strong><small>{item.detail}</small></span><em>{item.ready ? tr("dependencysetup.ready") : item.optional ? tr("dependencysetup.optional") : tr("dependencysetup.action_needed")}</em>
      </label>)}</div>
      {selected.length > 0 && <label className="setup-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />
        <span>{tr("dependencysetup.allow_the_selected_dependencies_to_be_downloaded_and_installed_in_cleo_s_managed_dire")}</span></label>}
      {state?.restartRequired && <p className="setup-notice">{tr("dependencysetup.if_windows_requires_a_restart_restart_the_computer_and_reopen_this_wizard_installatio")}</p>}
      {!error && (state?.message || busy) && <p role="status">{state?.message || tr("dependencysetup.checking")}</p>}
      {error && <p role="alert" className="setup-error">{error}</p>}
      {state?.logs && <details><summary>{tr("dependencysetup.view_installation_logs")}</summary><pre>{state.logs}</pre></details>}
      <footer>{Boolean(state?.pendingIds?.length) && <button disabled={busy} onClick={() => void operate("install", true)}>{tr("dependencysetup.continue_authorized_installation")}</button>}<button disabled={busy} onClick={() => void close()}>{tr("dependencysetup.not_now")}</button><button disabled={busy} onClick={() => void operate("scan")}><RefreshCw size={14} />{tr("dependencysetup.check_again")}</button>
        <button className="setup-install" disabled={busy || !selected.length || !consent} onClick={() => void operate("install")}><Download size={14} />{busy ? tr("dependencysetup.working") : tr("dependencysetup.install_selected_dependencies")}</button></footer>
    </section>
  </Modal>;
}
