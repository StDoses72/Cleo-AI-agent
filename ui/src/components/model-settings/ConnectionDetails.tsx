import { useEffect, useRef, useState } from "react";
import { Info, X } from "lucide-react";
import { cleoClient } from "../../services/cleoClient";
import type { ApplyModelSettings, ModelProfileSummary, ModelSettings } from "../../types";
import { billingLabel, isAccount, modelLabel, profileLabel, profileModels, providerInfo } from "./catalog";
import { ModelDialog } from "./ModelDialog";

export type ConnectionStatus = { state: "connected" | "error" | "checking"; message?: string };

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
  const used = settings.activeAgent === profile.name || settings.activeDreamAgent === profile.name || activeProfileId === profile.name;
  useEffect(() => {
    alive.current = true;
    const dismiss = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) setPopover("hidden"); };
    document.addEventListener("pointerdown", dismiss);
    return () => { alive.current = false; document.removeEventListener("pointerdown", dismiss); };
  }, []);
  const run = async (operation: () => Promise<ModelSettings>) => {
    setError("");
    try { await onApply(operation); if (alive.current) onClose(); }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : "保存失败。"); }
  };
  const check = async () => {
    onStatus({ state: "checking" });
    try {
      const result = await cleoClient.checkModelConnection({ profileId: profile.name });
      onStatus({ state: result.status === "connected" ? "connected" : "error", message: result.message });
    } catch (error) { onStatus({ state: "error", message: error instanceof Error ? error.message : "验证失败。" }); }
  };
  return <ModelDialog title="连接详情" onClose={() => { if (!busy) onClose(); }} onEscape={() => {
    if (popover !== "hidden") setPopover("hidden"); else if (!busy) onClose();
  }}>
    <div className="ms-detail-body">
      <label className="ms-field"><span>连接名称</span><input value={name} onChange={e => setName(e.target.value)} disabled={busy} /></label>
      <dl className="ms-detail-info">
        <div><dt>服务商</dt><dd>{providerInfo(profile).name}</dd></div>
        <div><dt>连接状态</dt><dd>{status?.state === "connected" ? "已验证" : status?.state === "checking" ? "验证中…" : status?.state === "error" ? "需要检查" : "已配置"}</dd></div>
        <div><dt>{isAccount(profile) ? "用量来源" : "API Key"}</dt><dd>{isAccount(profile) ? billingLabel(profile) : profile.hasApiKey ? "•••• •••• 已保存" : "未配置"}</dd></div>
        <div><dt>可用模型</dt><dd>{profileModels(profile).length} 个</dd></div>
      </dl>
      <div className="ms-detail-models">{profileModels(profile).map(id => <span key={id}>{modelLabel(id)}</span>)}</div>
      {status?.state === "error" && <p className="ms-error" role="alert">{status.message || "连接尚未通过验证。"}</p>}
      {error && <p className="ms-error" role="alert">{error}</p>}
      <button className="ms-link" disabled={busy} onClick={onReconnect}>{isAccount(profile) ? "重新登录" : "更新密钥与模型"}</button>
    </div>
    <footer className="ms-dialog-footer">
      <div className="ms-remove-action" ref={anchor} onPointerEnter={() => setPopover(value => value === "pinned" ? value : "hint")} onPointerLeave={() => setPopover(value => value === "hint" ? "hidden" : value)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setPopover("hidden"); }}>
        <button className="ms-danger" data-unavailable={used} aria-expanded={popover !== "hidden"} aria-controls="model-remove-popover" disabled={busy} onFocus={() => setPopover(value => value === "pinned" ? value : "hint")} onClick={() => setPopover("pinned")}>移除连接</button>
        {popover !== "hidden" && <div className="ms-remove-popover" id="model-remove-popover" role={popover === "hint" ? "tooltip" : "region"} aria-label="移除连接提示">
          {used ? <><strong><Info />暂时无法移除{popover === "pinned" && <button className="ms-icon" aria-label="关闭移除提示" onClick={() => setPopover("hidden")}><X /></button>}</strong><p>这个连接正在被使用。<br />切换所用模型后，才可移除。</p></> : popover === "pinned" ? <><strong>移除这个连接？</strong><p>已有的对话记录会继续保留。</p><div><button className="ms-quiet" onClick={() => setPopover("hidden")}>取消</button><button className="ms-remove-confirm" disabled={busy} onClick={() => { if (!used) void run(() => cleoClient.removeModelConnection(profile.name)); }}>确认移除</button></div></> : <p>移除连接后，已有的对话记录会继续保留。</p>}
        </div>}
      </div>
      <div className="ms-footer-actions"><button className="ms-secondary" disabled={busy || status?.state === "checking"} onClick={() => void check()}>验证连接</button><button className="ms-primary" disabled={busy || !name.trim()} onClick={() => void run(() => cleoClient.renameModelConnection(profile.name, name.trim()))}>{busy ? "保存中…" : "保存更改"}</button></div>
    </footer>
  </ModelDialog>;
}
