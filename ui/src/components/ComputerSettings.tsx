import { t as tr } from "../../electron/i18n.mjs";
import { useState, type FormEvent } from "react";
import { CircleAlert, FolderOpen } from "lucide-react";
import { useComputerState } from "./ComputerPanel";

/** Settings → Computer use: everything about connections and permissions, so the computer page
 * shows only what the agent is doing. Browsers connect through the Cleo extension; allowed
 * websites can be removed; the emergency-stop shortcut is set here. */
export function ComputerSettingsPage() {
  const { state, busy, act, error } = useComputerState();
  const [shortcut, setShortcut] = useState("");
  const setup = state?.userBrowserSetup;
  const connected = state?.userBrowser?.connected ? state.userBrowser.browser : null;
  const waiting = Boolean(setup?.prepared && !setup.disabled && !connected);
  const saveShortcut = (event: FormEvent) => {
    event.preventDefault();
    if (shortcut.trim()) void act("shortcut", { value: shortcut.trim() }).then(() => setShortcut(""));
  };
  if (!state) return <div className="settings-page">{error && <p className="settings-error" role="alert">{error}</p>}</div>;

  return <div className="settings-page computer-settings" data-testid="computer-settings">
    <h3 className="computer-settings-heading">{tr("computersettings.your_browser")}</h3>
    {(setup?.browsers ?? []).map(browser => {
      const live = connected?.kind === browser.kind;
      return <div className="settings-row" key={browser.kind} data-testid={`computer-browser-${browser.kind}`}>
        <div><strong>{browser.name}</strong>
          <p>{live ? tr("computersettings.connected_value", { p0: connected?.extension ?? "" })
            : !browser.installed ? tr("computersettings.not_installed")
              : waiting ? tr("computersettings.waiting_for_extension") : tr("computersettings.not_connected")}</p></div>
        <div className="settings-control settings-actions">
          {live ? <button type="button" disabled={busy} onClick={() => void act("userBrowser", { action: "disconnect" })}>{tr("computersettings.disconnect")}</button>
            : browser.installed ? <button type="button" disabled={busy} onClick={() => void act("userBrowser", { action: "connect", kind: browser.kind })}>
              {waiting ? tr("computersettings.open_again") : tr("computersettings.connect")}</button> : null}
        </div>
      </div>;
    })}
    <div className="settings-row"><div><strong>Firefox</strong><p>{tr("computersettings.not_supported")}</p></div></div>
    {waiting && <div className="computer-settings-steps" data-testid="computer-extension-steps">
      <ol>
        <li>{tr("computersettings.step_developer_mode")}</li>
        <li>{tr("computersettings.step_load_unpacked")}</li>
        <li>{tr("computersettings.step_choose_folder")}</li>
      </ol>
      <button type="button" className="settings-action" onClick={() => void act("userBrowser", { action: "reveal" })}><FolderOpen size={14} />{tr("computersettings.show_extension_folder")}</button>
    </div>}

    <h3 className="computer-settings-heading">{tr("computersettings.allowed_sites")}</h3>
    {(state.sites ?? []).length ? (state.sites ?? []).map(host => <div className="settings-row compact" key={host}>
      <div><strong>{host === "*" ? tr("computersettings.all_sites") : host}</strong></div>
      <div className="settings-control settings-actions"><button type="button" disabled={busy} onClick={() => void act("removeSite", { host })}>{tr("computersettings.remove")}</button></div>
    </div>) : <p className="computer-settings-empty">{tr("computersettings.no_sites")}</p>}

    <h3 className="computer-settings-heading">{tr("computerpanel.local_computer")}</h3>
    <div className="settings-row">
      <div><strong>{tr("computerpanel.emergency_stop_shortcut")}</strong><p>{state.shortcutError || state.stopShortcut}</p></div>
      <form className="settings-control computer-shortcut-form" onSubmit={saveShortcut}>
        <input aria-label={tr("computerpanel.emergency_stop_shortcut")} value={shortcut} placeholder={state.stopShortcut} onChange={event => setShortcut(event.target.value)} />
        <button type="submit" className="settings-action" disabled={busy || !shortcut.trim()}>{tr("computerpanel.save")}</button>
      </form>
    </div>
    {!state.hostSupported && <p className="computer-settings-empty">{tr("computerpanel.local_computer_mode_currently_supports_windows_only")}</p>}

    <h3 className="computer-settings-heading">{tr("computerpanel.built_in_browser")}</h3>
    <div className="settings-row"><div><strong>{tr("computersettings.downloads")}</strong><p>{state.browser.downloadsDir}</p></div></div>
    {error && <p className="settings-error" role="alert"><CircleAlert size={14} /> {error}</p>}
  </div>;
}
