import { t as tr } from "../../../electron/i18n.mjs";
import { useEffect, useRef, useState } from "react";
import { Info, X } from "lucide-react";
import { cleoClient } from "../../services/cleoClient";
import type { ApplyModelSettings, ModelProfileSummary, ModelSettings } from "../../types";
import { billingLabel, isAccount, modelLabel, profileLabel, profileModels, providerInfo } from "./catalog";
import { ModelDialog } from "./ModelDialog";
import { ConnectionScope } from "./ConnectionScope";

export type ConnectionStatus = { state: "connected" | "manual" | "error" | "checking"; message?: string };

export function ConnectionDetails({ profile, settings, busy, activeProfileId, status, onStatus, onApply, onReconnect, onClose }: {
  profile: ModelProfileSummary; settings: ModelSettings; busy: boolean; status?: ConnectionStatus;
  onStatus: (status: ConnectionStatus) => void; onApply: ApplyModelSettings;
  onReconnect: () => void; onClose: () => void;
  activeProfileId?: string;
}) {
  const [name, setName] = useState(profileLabel(profile));
  const [error, setError] = useState("");
  const [popover, setPopover] = useState<"hidden" | "hint" | "pinned">("hidden");
  const anchor = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const generation = useRef(0);
  const used = settings.activeAgent === profile.name || settings.activeDreamAgent === profile.name || activeProfileId === profile.name;
  useEffect(() => {
    alive.current = true;
    const dismiss = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) setPopover("hidden"); };
    document.addEventListener("pointerdown", dismiss);
    void check();
    const refresh = () => { if (!document.hidden) void check(); };
    window.addEventListener("focus", refresh);
    return () => { generation.current++; alive.current = false; document.removeEventListener("pointerdown", dismiss); window.removeEventListener("focus", refresh); };
  }, []);
  const run = async (operation: () => Promise<ModelSettings>) => {
    setError("");
    try { await onApply(operation); if (alive.current) onClose(); }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : tr("connectiondetails.save_failed")); }
  };
  const check = async () => {
    const request = ++generation.current;
    onStatus({ state: "checking" });
    try {
      const result = await cleoClient.checkModelConnection({ profileId: profile.name });
      if (alive.current && request === generation.current) onStatus({ state: result.status, message: result.message });
    } catch (error) { if (alive.current && request === generation.current) onStatus({ state: "error", message: error instanceof Error ? error.message : tr("connectiondetails.verification_failed") }); }
  };
  return <ModelDialog title={tr("connectiondetails.connection_details")} onClose={() => { if (!busy) onClose(); }} onEscape={() => {
    if (popover !== "hidden") setPopover("hidden"); else if (!busy) onClose();
  }}>
    <div className="ms-detail-body">
      <label className="ms-field"><span>{tr("connectiondetails.connection_name")}</span><input value={name} onChange={e => setName(e.target.value)} disabled={busy} /></label>
      <dl className="ms-detail-info">
        <div><dt>{tr("connectiondetails.provider")}</dt><dd>{providerInfo(profile).name}</dd></div>
        <div><dt>{tr("connectiondetails.connection_status")}</dt><dd>{status?.state === "connected" ? (isAccount(profile) ? tr("connectiondetails.client_checks_passed") : tr("connectiondetails.verified")) : status?.state === "checking" ? tr("connectiondetails.verifying") : status?.state === "error" ? tr("connectiondetails.needs_checking") : status?.state === "manual" ? tr("connectiondetails.not_verified") : tr("connectiondetails.configured")}</dd></div>
        <div><dt>{isAccount(profile) ? tr("connectiondetails.usage_source") : "API Key"}</dt><dd>{isAccount(profile) ? billingLabel(profile) : profile.hasApiKey ? tr("connectiondetails.saved") : tr("connectiondetails.not_configured")}</dd></div>
        <div><dt>{tr("connectiondetails.configured_models")}</dt><dd>{profileModels(profile).length} {tr("memoryview.items")}</dd></div>
      </dl>
      <div className="ms-detail-models">{profileModels(profile).map(id => <span key={id}>{modelLabel(id)}</span>)}</div>
      {isAccount(profile) && <ConnectionScope />}
      {status?.state === "manual" && <p className="ms-muted" role="status">{status.message}</p>}
      {status?.state === "error" && <p className="ms-error" role="alert">{status.message || tr("connectiondetails.this_connection_has_not_passed_verification")}</p>}
      {error && <p className="ms-error" role="alert">{error}</p>}
      <button className="ms-link" disabled={busy} onClick={onReconnect}>{isAccount(profile) ? tr("connectiondetails.sign_in_again") : tr("connectiondetails.update_key_and_models")}</button>
    </div>
    <footer className="ms-dialog-footer">
      <div className="ms-remove-action" ref={anchor} onPointerEnter={() => setPopover(value => value === "pinned" ? value : "hint")} onPointerLeave={() => setPopover(value => value === "hint" ? "hidden" : value)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setPopover("hidden"); }}>
        <button className="ms-danger" data-unavailable={used} aria-expanded={popover !== "hidden"} aria-controls="model-remove-popover" disabled={busy} onFocus={() => setPopover(value => value === "pinned" ? value : "hint")} onClick={() => setPopover("pinned")}>{tr("connectiondetails.remove_connection")}</button>
        {popover !== "hidden" && <div className="ms-remove-popover" id="model-remove-popover" role={popover === "hint" ? "tooltip" : "region"} aria-label={tr("connectiondetails.connection_removal_notice")}>
          {used ? <><strong><Info />{tr("connectiondetails.cannot_remove_yet")}{popover === "pinned" && <button className="ms-icon" aria-label={tr("connectiondetails.close_removal_notice")} onClick={() => setPopover("hidden")}><X /></button>}</strong><p>{tr("connectiondetails.this_connection_is_in_use")}<br />{tr("connectiondetails.switch_to_another_model_before_removing_it")}</p></> : popover === "pinned" ? <><strong>{tr("connectiondetails.remove_this_connection")}</strong><p>{tr("connectiondetails.existing_conversations_will_be_preserved")}</p><div><button className="ms-quiet" onClick={() => setPopover("hidden")}>{tr("computerpanel.cancel")}</button><button className="ms-remove-confirm" disabled={busy} onClick={() => { if (!used) void run(() => cleoClient.removeModelConnection(profile.name)); }}>{tr("connectiondetails.confirm_removal")}</button></div></> : <p>{tr("connectiondetails.removing_this_connection_preserves_existing_conversations")}</p>}
        </div>}
      </div>
      <div className="ms-footer-actions">{status?.state === "error" && <button className="ms-secondary" disabled={busy} onClick={() => void check()}>{tr("connectiondetails.retry_check")}</button>}<button className="ms-primary" disabled={busy || !name.trim() || name.trim() === profileLabel(profile)} onClick={() => void run(() => cleoClient.renameModelConnection(profile.name, name.trim()))}>{busy ? tr("backgroundmemorysettingspanel.saving") : tr("connectiondetails.save_changes")}</button></div>
    </footer>
  </ModelDialog>;
}
