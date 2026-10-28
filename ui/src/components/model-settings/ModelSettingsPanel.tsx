import { t as tr } from "../../../electron/i18n.mjs";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, Layers, Moon, MoreHorizontal, Pause, SlidersHorizontal } from "lucide-react";
import { cleoClient } from "../../services/cleoClient";
import type { ApplyModelSettings, ModelProfileSummary, ModelSettings } from "../../types";
import { billingLabel, isAccount, modelLabel, profileLabel, profileModels, providerInfo } from "./catalog";
import { ConnectionDetails, type ConnectionStatus } from "./ConnectionDetails";
import { ConnectionWizard } from "./ConnectionWizard";
import { ModelPicker, type ModelChoice } from "./ModelPicker";
import "./model-settings.css";

export type ModelsPage = "current" | "add" | "dream";
const dreamChoice = (settings: ModelSettings) => ({ mode: settings.dreamEnabled === false ? "off" : settings.activeDreamAgent ? "fixed" : "follow", profileId: settings.activeDreamAgent, model: settings.activeDreamModel || settings.profiles.find(p => p.name === settings.activeDreamAgent)?.model || "" });

function Summary({ profile, model, children }: { profile?: ModelProfileSummary; model?: string; children?: ReactNode }) {
  return <div className="ms-summary"><span className="ms-mark large">{profile ? providerInfo(profile).mark : "·"}</span><div><strong>{model ? modelLabel(model) : tr("modelsettingspanel.select_a_model")}</strong><div className="ms-meta">{profile && <>{profileLabel(profile)}<span>· {billingLabel(profile)}</span></>}</div></div>{children}</div>;
}

export function ModelSettingsPanel({ page, settings, busy, activeProfileId, onApply, onNavigate, loadError, onRetry, active = true }: {
  page: ModelsPage; settings: ModelSettings | null; busy: boolean; onApply: ApplyModelSettings;
  activeProfileId?: string;
  loadError?: string | null;
  onRetry?: () => void;
  active?: boolean;
  onNavigate: (page: ModelsPage) => void;
}) {
  const [details, setDetails] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ target: "chat" | "dream"; connection?: string } | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({});
  const [reconnect, setReconnect] = useState<ModelProfileSummary | null>(null);
  const [wizardOpen, setWizardOpen] = useState(page === "add");
  const [draft, setDraft] = useState(settings ? dreamChoice(settings) : { mode: "follow", profileId: "", model: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const changingModel = useRef(false);
  useEffect(() => { if (settings) setDraft(dreamChoice(settings)); }, [settings?.activeDreamAgent, settings?.activeDreamModel, settings?.dreamEnabled]);
  useEffect(() => { setError(""); if (page === "add") setWizardOpen(true); }, [page]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 3000); return () => clearTimeout(timer); }, [notice]);
  if (!settings) return <div className="model-settings ms-loading" role={loadError ? "alert" : "status"}>
    {loadError || tr("modelsettingspanel.loading_model_configuration")}{loadError && <button className="ms-link" onClick={onRetry} disabled={busy}>{tr("app.retry")}</button>}
  </div>;
  const chat = settings.profiles.find(p => p.name === settings.activeAgent);
  const detail = settings.profiles.find(p => p.name === details);
  const fixedDream = settings.profiles.find(p => p.name === draft.profileId);
  const savedDream = settings.profiles.find(p => p.name === settings.activeDreamAgent);
  const changed = JSON.stringify(draft) !== JSON.stringify(dreamChoice(settings));
  const changeModel = async (choice: ModelChoice) => {
    if (changingModel.current || busy) return;
    setError("");
    if (picker?.target === "dream") { setDraft({ mode: "fixed", ...choice }); setPicker(null); return; }
    changingModel.current = true;
    try { await onApply(() => cleoClient.selectChatModel(choice.profileId, choice.model)); setPicker(null); setNotice(tr("modelsettingspanel.default_model_for_new_chats_updated")); }
    catch (error) { setError(error instanceof Error ? error.message : tr("modelsettingspanel.switch_failed")); }
    finally { changingModel.current = false; }
  };
  const saveDream = async () => {
    setError("");
    try {
      if (draft.mode === "fixed" && !draft.profileId) throw new Error(tr("modelsettingspanel.select_a_memory_consolidation_model"));
      await onApply(() => cleoClient.saveDreamSettings(draft.mode === "follow" ? "mode:follow" : draft.mode === "off" ? "mode:disabled" : draft.profileId, draft.mode === "fixed" ? draft.model : undefined));
      setNotice(tr("modelsettingspanel.memory_consolidation_settings_saved"));
    } catch (error) { setError(error instanceof Error ? error.message : tr("connectiondetails.save_failed")); }
  };
  return <div className="model-settings" data-testid="model-settings">
    {loadError && <p className="ms-error" role="alert">{loadError}
      <button className="ms-link" onClick={onRetry} disabled={busy}>{tr("app.retry")}</button></p>}
    {page === "current" && <>
      <div className="ms-section-label">{tr("modelsettingspanel.default_model_for_new_chats")}</div>
      <Summary profile={chat} model={chat?.model}><button className="ms-secondary" disabled={busy} onClick={() => setPicker({ target: "chat" })}>{tr("modelsettingspanel.switch_model")}<ChevronRight /></button></Summary>
      <div className="ms-section-heading"><h3>{tr("modelsettingspanel.added_connections")}<span>{settings.profiles.length}</span></h3></div>
      <div className="ms-connections">{settings.profiles.map(profile => {
        const status = statuses[profile.name];
        const role = settings.activeAgent === profile.name ? tr("modelsettingspanel.chat_default") : settings.activeDreamAgent === profile.name ? tr("modelsettingspanel.memory_consolidation") : activeProfileId === profile.name ? tr("modelsettingspanel.current_conversation") : "";
        return <div className="ms-connection-row" key={profile.name}>
          <span className="ms-mark">{providerInfo(profile).mark}</span><div className="ms-connection-body"><strong>{profileLabel(profile)}{role && <span className="ms-role">{role}</span>}</strong><div className="ms-meta">{billingLabel(profile)}<span>· {profileModels(profile).length} {tr("modelsettingspanel.models")}</span></div></div>
          <span className={`ms-connection-status ${status?.state || ""}`}>{status?.state === "connected" ? (isAccount(profile) ? tr("connectiondetails.client_checks_passed") : tr("connectiondetails.verified")) : status?.state === "error" ? tr("connectiondetails.needs_checking") : status?.state === "checking" ? tr("connectiondetails.verifying") : tr("connectiondetails.configured")}</span>
          {role !== "对话默认" && status?.state !== "error" && <button className="ms-quiet" disabled={busy} onClick={() => setPicker({ target: "chat", connection: profile.name })}>{tr("modelsettingspanel.set_as_default")}</button>}
          <button className="ms-icon" aria-label={tr("modelsettingspanel.manage_value", { p0: profileLabel(profile) })} title={tr("modelsettingspanel.manage_connections")} onClick={() => setDetails(profile.name)}><MoreHorizontal /></button>
        </div>;
      })}</div>
      <div className="ms-dream-link"><Moon /><div><strong>{tr("modelsettingspanel.dream_agent")}</strong><div className="ms-meta">{settings.dreamEnabled === false ? tr("modelsettingspanel.automatic_consolidation_paused") : settings.activeDreamAgent ? `${profileLabel(savedDream!)} · ${modelLabel(settings.activeDreamModel || savedDream!.model)}` : tr("modelsettingspanel.follow_chat_model_value", { p0: modelLabel(chat?.model || "default") })}</div></div><button className="ms-quiet" onClick={() => onNavigate("dream")}>{tr("modelsettingspanel.configure_memory_consolidation")}<ChevronRight /></button></div>
    </>}
    {wizardOpen && <div hidden={page !== "add"}><ConnectionWizard key={reconnect?.name || "new"} active={active && page === "add"} existing={reconnect} settings={settings} busy={busy} onApply={onApply} onDone={() => { setNotice(reconnect ? tr("modelsettingspanel.connection_updated") : tr("modelsettingspanel.connection_added")); setReconnect(null); setWizardOpen(false); onNavigate("current"); }} /></div>}
    {page === "dream" && <>
      <div className="ms-section-label">{tr("modelsettingspanel.model_selection_mode")}</div>
      <div className="ms-dream-options" role="radiogroup" aria-label={tr("modelsettingspanel.memory_model_selection_mode")}>{([
        ["follow", tr("modelsettingspanel.follow_chat_model"), tr("modelsettingspanel.use_the_source_conversation_s_model"), Layers],
        ["fixed", tr("modelsettingspanel.separate_model"), tr("modelsettingspanel.choose_a_dedicated_model_for_memory_consolidation"), SlidersHorizontal],
        ["off", tr("modelsettingspanel.disable_automatic_consolidation"), tr("modelsettingspanel.keep_conversation_records_and_pause_automatic_consolidation"), Pause],
      ] as const).map(([mode, label, description, Icon]) => <button key={mode} role="radio" aria-checked={draft.mode === mode} className={draft.mode === mode ? "selected" : ""} disabled={busy} onClick={() => setDraft({ ...draft, mode })}><i className="ms-radio" /><span><strong>{label}{mode === "follow" && <em>{tr("modelsettingspanel.default")}</em>}</strong><small>{description}</small></span><Icon /></button>)}</div>
      {draft.mode === "fixed" && <div className="ms-dream-preview"><div className="ms-section-label">{tr("modelsettingspanel.memory_consolidation_model")}</div><Summary profile={fixedDream} model={draft.model}><button className="ms-secondary" disabled={busy} onClick={() => setPicker({ target: "dream" })}>{tr("connectionwizard.choose_model")}</button></Summary></div>}
      {changed && <div className="ms-save-footer"><span>{tr("modelsettingspanel.unsaved_changes")}</span><button className="ms-quiet" disabled={busy} onClick={() => setDraft(dreamChoice(settings))}>{tr("backgroundmemorysettingspanel.discard_changes")}</button><button className="ms-primary" disabled={busy} onClick={() => void saveDream()}>{busy ? tr("dependencysetup.working") : tr("modelsettingspanel.save_settings")}</button></div>}
    </>}
    {error && !picker && <p className="ms-error" role="alert">{error}</p>}
    {notice && <div className="ms-notice" role="status"><Check />{notice}</div>}
    {active && picker && <ModelPicker title={picker.target === "chat" ? tr("modelsettingspanel.choose_the_default_chat_model") : tr("modelsettingspanel.choose_memory_consolidation_model")} profiles={settings.profiles.filter(p => !picker.connection || p.name === picker.connection)} selected={picker.target === "chat" ? { profileId: picker.connection || settings.activeAgent, model: settings.profiles.find(p => p.name === (picker.connection || settings.activeAgent))!.model } : draft.profileId ? draft : null} busy={busy} error={error} onSelect={choice => void changeModel(choice)} onClose={() => { setPicker(null); setError(""); }} />}
    {active && detail && <ConnectionDetails key={detail.name} profile={detail} settings={settings} busy={busy} activeProfileId={activeProfileId} status={statuses[detail.name]} onStatus={status => setStatuses(current => ({ ...current, [detail.name]: status }))} onApply={onApply} onClose={() => setDetails(null)} onReconnect={() => { setReconnect(detail); setDetails(null); onNavigate("add"); }} />}
  </div>;
}
