import { useEffect, useState } from "react";
import { version } from "../package.json";
import { Cpu, GitBranch, Layers, RefreshCw } from "lucide-react";
import { RoutingSettingsPanel } from "./components/model-settings/RoutingSettingsPanel";
import { localConfigClient } from "./services/localConfigClient";
import { LocalTaskUsagePreview } from "./components/LocalTaskUsagePreview";
import type { ModelSettings } from "./types";
import "./local-config-preview.css";

/** Purpose: Review real local connections and edit routing without starting inference. Output: preview UI. */
export function LocalConfigPreview() {
  const [page, setPage] = useState<"connections" | "routing" | "usage">("usage");
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** Purpose: Reload credential-free connection summaries. Output: current config or explicit error. */
  const reload = async () => {
    setBusy(true); setError("");
    try { setSettings(await localConfigClient.getModelSettings()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取失败"); }
    finally { setBusy(false); }
  };
  useEffect(() => { void reload(); }, []);
  const primary = settings?.profiles.find(profile => profile.name === settings.activeAgent);
  return <div className="local-config-preview">
    <header><strong>Cleo <span>v{version} · 本地配置</span></strong><span className="local-config-live">● 真实配置 · 推理执行已停用</span></header>
    <div className="local-config-layout">
      <nav aria-label="本地配置页面">
        <button aria-current={page === "usage" ? "page" : undefined} onClick={() => setPage("usage")}><Cpu size={17} />任务用量</button>
        <button aria-current={page === "connections" ? "page" : undefined} onClick={() => setPage("connections")}><Layers size={17} />已添加连接</button>
        <button aria-current={page === "routing" ? "page" : undefined} onClick={() => setPage("routing")}><GitBranch size={17} />子任务路由</button>
        <p>与本机 Cleo 共用配置文件。保存路由会更新实际配置；已运行的任务保持原设置。</p>
      </nav>
      <main>
        <div className="local-config-heading"><div><p>本机 Cleo</p><h1>{page === "usage" ? "当前任务用量" : page === "routing" ? "子任务路由" : "已添加连接"}</h1></div>
          {page !== "usage" && <button className="settings-action" disabled={busy} onClick={() => void reload()}><RefreshCw size={14} />重新读取连接</button>}</div>
        {page !== "usage" && <div className="local-config-primary">当前对话默认：<strong>{primary ? `${primary.provider} / ${primary.model}` : "正在读取…"}</strong><span>路由设置不会切换主模型</span></div>}
        {error && <p role="alert" className="settings-error">{error}</p>}
        {page === "usage" && <LocalTaskUsagePreview />}
        <div hidden={page !== "routing"}><RoutingSettingsPanel active={page === "routing"} client={localConfigClient} /></div>
        {page === "connections" && <section className="local-config-connections">
          <p>以下是本机已保存的连接和模型。配置记录不等同于本次在线验证；执行目录的可用状态见子任务路由。</p>
          {settings?.profiles.map(profile => <article key={profile.name}>
            <div><h2>{profile.displayName || profile.provider}</h2><span>{profile.backend === "api" ? "API 连接" : `${profile.provider} harness`}{profile.name === settings.activeAgent ? " · 对话默认" : ""}</span></div>
            <p>{profile.model}</p><div className="local-config-models">{Array.from(new Set([profile.model, ...profile.models || []])).map(model => <span key={model}>{model}</span>)}</div>
            <small>已配置{profile.backend === "api" ? (profile.hasApiKey ? " · 密钥已保存" : " · 未保存密钥") : " · 使用本地客户端授权"}</small>
          </article>)}
          <p>此处展示连接；可编辑的能力档位、成本偏好、候选开关和保守回退位于“子任务路由”。</p>
        </section>}
      </main>
    </div>
  </div>;
}
