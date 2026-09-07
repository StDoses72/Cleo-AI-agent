import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronRight, Layers, Moon, MoreHorizontal, Pause, Plus, SlidersHorizontal } from "lucide-react";
import { cleoClient } from "../../services/cleoClient";
import type { ApplyModelSettings, ModelProfileSummary, ModelSettings } from "../../types";
import { billingLabel, modelLabel, profileLabel, profileModels, providerInfo } from "./catalog";
import { ConnectionDetails, type ConnectionStatus } from "./ConnectionDetails";
import { ConnectionWizard } from "./ConnectionWizard";
import { ModelPicker, type ModelChoice } from "./ModelPicker";
import "./model-settings.css";

export type ModelsPage = "current" | "add" | "dream";
const titles: Record<ModelsPage, string> = { current: "当前配置", add: "新增连接", dream: "DreamAgent" };
const dreamChoice = (settings: ModelSettings) => ({ mode: settings.dreamEnabled === false ? "off" : settings.activeDreamAgent ? "fixed" : "follow", profileId: settings.activeDreamAgent, model: settings.activeDreamModel || settings.profiles.find(p => p.name === settings.activeDreamAgent)?.model || "" });

function Summary({ profile, model, children }: { profile?: ModelProfileSummary; model?: string; children?: ReactNode }) {
  return <div className="ms-summary"><span className="ms-mark large">{profile ? providerInfo(profile).mark : "·"}</span><div><strong>{model ? modelLabel(model) : "选择一个模型"}</strong><div className="ms-meta">{profile && <>{profileLabel(profile)}<span>· {billingLabel(profile)}</span></>}</div></div>{children}</div>;
}

export function ModelSettingsPanel({ page, settings, busy, activeProfileId, onApply, onNavigate }: {
  page: ModelsPage; settings: ModelSettings | null; busy: boolean; onApply: ApplyModelSettings;
  activeProfileId?: string;
  onNavigate: (page: ModelsPage) => void;
}) {
  const [details, setDetails] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ target: "chat" | "dream"; connection?: string } | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({});
  const [reconnect, setReconnect] = useState<ModelProfileSummary | null>(null);
  const [draft, setDraft] = useState(settings ? dreamChoice(settings) : { mode: "follow", profileId: "", model: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => { if (settings) setDraft(dreamChoice(settings)); }, [settings?.activeDreamAgent, settings?.activeDreamModel, settings?.dreamEnabled]);
  useEffect(() => { setError(""); if (page !== "add") setReconnect(null); }, [page]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 3000); return () => clearTimeout(timer); }, [notice]);
  if (!settings) return <div className="model-settings ms-loading">正在读取模型配置…</div>;
  const chat = settings.profiles.find(p => p.name === settings.activeAgent);
  const detail = settings.profiles.find(p => p.name === details);
  const fixedDream = settings.profiles.find(p => p.name === draft.profileId);
  const displayedDream = draft.mode === "follow" ? chat : fixedDream;
  const savedDream = settings.profiles.find(p => p.name === settings.activeDreamAgent);
  const changed = JSON.stringify(draft) !== JSON.stringify(dreamChoice(settings));
  const changeModel = async (choice: ModelChoice) => {
    setError("");
    if (picker?.target === "dream") { setDraft({ mode: "fixed", ...choice }); setPicker(null); return; }
    try { await onApply(() => cleoClient.selectChatModel(choice.profileId, choice.model)); setPicker(null); setNotice("默认对话模型已更新"); }
    catch (error) { setError(error instanceof Error ? error.message : "切换失败。"); }
  };
  const saveDream = async () => {
    setError("");
    try {
      if (draft.mode === "fixed" && !draft.profileId) throw new Error("请选择记忆整理模型。");
      await onApply(() => cleoClient.saveDreamSettings(draft.mode === "follow" ? "mode:follow" : draft.mode === "off" ? "mode:disabled" : draft.profileId, draft.mode === "fixed" ? draft.model : undefined));
      setNotice("DreamAgent 设置已保存");
    } catch (error) { setError(error instanceof Error ? error.message : "保存失败。"); }
  };
  return <div className="model-settings" data-testid="model-settings">
    <div className="ms-breadcrumb">设置<ChevronRight />模型<ChevronRight /><strong>{titles[page]}</strong></div>
    <div className="ms-heading"><h2>{titles[page]}</h2>{page === "current" && <button className="ms-primary" onClick={() => { setReconnect(null); onNavigate("add"); }}><Plus />新增连接</button>}</div>
    {page === "current" && <>
      <div className="ms-section-label">默认对话模型</div>
      <Summary profile={chat} model={chat?.model}><button className="ms-secondary" disabled={busy} onClick={() => setPicker({ target: "chat" })}>切换模型<ChevronRight /></button></Summary>
      <div className="ms-section-heading"><h3>已添加连接<span>{settings.profiles.length}</span></h3></div>
      <div className="ms-connections">{settings.profiles.map(profile => {
        const status = statuses[profile.name];
        const role = settings.activeAgent === profile.name ? "对话默认" : settings.activeDreamAgent === profile.name ? "记忆整理" : activeProfileId === profile.name ? "当前对话" : "";
        return <div className="ms-connection-row" key={profile.name}>
          <span className="ms-mark">{providerInfo(profile).mark}</span><div className="ms-connection-body"><strong>{profileLabel(profile)}{role && <span className="ms-role">{role}</span>}</strong><div className="ms-meta">{billingLabel(profile)}<span>· {profileModels(profile).length} 个模型</span></div></div>
          <span className={`ms-connection-status ${status?.state || ""}`}>{status?.state === "connected" ? "已验证" : status?.state === "error" ? "需要检查" : status?.state === "checking" ? "验证中…" : "已配置"}</span>
          <button className="ms-quiet" disabled={busy} onClick={() => role === "对话默认" || status?.state === "error" ? setDetails(profile.name) : setPicker({ target: "chat", connection: profile.name })}>{role === "对话默认" ? "管理" : status?.state === "error" ? "检查连接" : "设为默认"}</button><button className="ms-icon" aria-label={`管理 ${profileLabel(profile)}`} onClick={() => setDetails(profile.name)}><MoreHorizontal /></button>
        </div>;
      })}</div>
      <div className="ms-dream-link"><Moon /><div><strong>DreamAgent</strong><div className="ms-meta">{settings.dreamEnabled === false ? "自动整理已暂停" : settings.activeDreamAgent ? `${profileLabel(savedDream!)} · ${modelLabel(settings.activeDreamModel || savedDream!.model)}` : `跟随对话 · ${modelLabel(chat?.model || "default")}`}</div></div><button className="ms-quiet" onClick={() => onNavigate("dream")}>设置记忆整理<ChevronRight /></button></div>
    </>}
    {page === "add" && <ConnectionWizard key={reconnect?.name || "new"} existing={reconnect} settings={settings} busy={busy} onApply={onApply} onDone={() => { setReconnect(null); onNavigate("current"); }} />}
    {page === "dream" && <>
      <div className="ms-section-label">模型使用方式</div>
      <div className="ms-dream-options" role="radiogroup" aria-label="DreamAgent 模型使用方式">{([
        ["follow", "跟随对话", "使用来源会话的模型", Layers],
        ["fixed", "独立模型", "单独指定记忆整理使用的模型", SlidersHorizontal],
        ["off", "关闭自动整理", "保留会话记录，暂停自动整理", Pause],
      ] as const).map(([mode, label, description, Icon]) => <button key={mode} role="radio" aria-checked={draft.mode === mode} className={draft.mode === mode ? "selected" : ""} disabled={busy} onClick={() => setDraft({ ...draft, mode })}><i className="ms-radio" /><span><strong>{label}{mode === "follow" && <em>默认</em>}</strong><small>{description}</small></span><Icon /></button>)}</div>
      <div className="ms-dream-preview">{draft.mode === "off" ? <div className="ms-paused"><Pause />自动记忆整理已暂停</div> : <><div className="ms-section-label">{draft.mode === "follow" ? "当前对话默认模型" : "记忆整理模型"}</div><Summary profile={displayedDream} model={draft.mode === "follow" ? chat?.model : draft.model}>{draft.mode === "fixed" && <button className="ms-secondary" onClick={() => setPicker({ target: "dream" })}>选择模型</button>}</Summary></>}</div>
      <div className="ms-save-footer"><span>{changed ? "有未保存的更改" : "所有更改已保存"}</span><button className="ms-quiet" disabled={!changed || busy} onClick={() => setDraft(dreamChoice(settings))}>取消更改</button><button className="ms-primary" disabled={!changed || busy} onClick={() => void saveDream()}>{busy ? "保存中…" : "保存设置"}</button></div>
    </>}
    {error && !picker && <p className="ms-error" role="alert">{error}</p>}
    {notice && <div className="ms-notice" role="status"><Check />{notice}</div>}
    {picker && <ModelPicker title={picker.target === "chat" ? "选择对话默认模型" : "选择记忆整理模型"} profiles={settings.profiles.filter(p => !picker.connection || p.name === picker.connection)} selected={picker.target === "chat" ? { profileId: picker.connection || settings.activeAgent, model: settings.profiles.find(p => p.name === (picker.connection || settings.activeAgent))!.model } : draft.profileId ? draft : null} busy={busy} error={error} onSelect={choice => void changeModel(choice)} onClose={() => { setPicker(null); setError(""); }} />}
    {detail && <ConnectionDetails key={detail.name} profile={detail} settings={settings} busy={busy} activeProfileId={activeProfileId} status={statuses[detail.name]} onStatus={status => setStatuses(current => ({ ...current, [detail.name]: status }))} onApply={onApply} onClose={() => setDetails(null)} onReconnect={() => { setReconnect(detail); setDetails(null); onNavigate("add"); }} />}
  </div>;
}
