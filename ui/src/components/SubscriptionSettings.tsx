import { useEffect, useRef, useState } from "react";
import { cleoClient } from "../services/cleoClient";
import type { ModelProfileInput, ModelSettings, SubscriptionLogin, SubscriptionRuntime } from "../types";

export function SubscriptionSettings({ profile, onChange }: {
  profile: ModelProfileInput;
  onChange: (patch: Partial<ModelProfileInput>) => void;
}) {
  const [catalog, setCatalog] = useState<SubscriptionRuntime[]>([]);
  const [login, setLogin] = useState<SubscriptionLogin | null>(null);
  const loginRef = useRef<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const backend = profile.backend || "api";
  const runtime = catalog.find((item) => item.backend === backend);
  useEffect(() => {
    void cleoClient.getSubscriptionCatalog().then(setCatalog).catch(() => setStatus("无法读取登录服务列表"));
  }, []);
  useEffect(() => {
    setModels([]);
    setStatus("");
    setLogin(null);
    return () => {
      if (loginRef.current) void cleoClient.cancelSubscriptionLogin(loginRef.current).catch(() => {});
      loginRef.current = null;
    };
  }, [backend, profile.executable]);
  useEffect(() => {
    if (!login || login.status !== "pending") return;
    let stopped = false;
    const timer = setTimeout(async () => {
      try {
        const current = await cleoClient.readSubscriptionLogin(login.id);
        if (!stopped) {
          setLogin(current);
          if (current.status !== "pending") loginRef.current = null;
        }
      } catch {
        if (!stopped) { setStatus("登录连接已结束，请重试"); setLogin(null); }
      }
    }, 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [login]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setStatus("");
    try { await action(); } catch (error) { setStatus(error instanceof Error ? error.message : "连接失败"); }
    finally { setBusy(false); }
  };
  return <>
    <label className="wide"><span>连接方式</span><select aria-label="连接方式" value={backend} disabled={busy || login?.status === "pending"}
      onChange={(event) => onChange({ backend: event.target.value, provider: event.target.value === "api" ? "openai" : event.target.value, model: event.target.value === "api" ? "" : "default", apiKey: "", baseUrl: "" })}>
      <option value="api">API Key</option>
      {catalog.map((item) => <option key={item.backend} value={item.backend}>{item.label}</option>)}
    </select></label>
    {runtime && <>
      <label className="wide"><span>官方 CLI 路径（可选）</span><input value={profile.executable || ""} onChange={(event) => onChange({ executable: event.target.value })} placeholder="自动从 PATH 查找" /></label>
      <div className="wide subscription-connection">
        <p>使用自己的官方账号登录。Chat 和 DreamAgent 共用该连接额度；计费及可用模型由服务商决定。</p>
        {backend === "claude_code" && <p>运行本机原版 Claude Code。登录由 Anthropic 完成；非交互调用的额度规则可能与网页聊天不同。</p>}
        <p>先<a href={runtime.docs} target="_blank" rel="noreferrer">安装官方 CLI</a>，或在终端运行 <code>{runtime.login}</code>。</p>
        <div className="subscription-actions">
          <button type="button" disabled={busy || login?.status === "pending"} onClick={() => void run(async () => {
            const attempt = await cleoClient.startSubscriptionLogin(profile);
            loginRef.current = attempt.id; setLogin(attempt);
          })}>登录官方账号</button>
          <button type="button" disabled={busy || login?.status === "pending"} onClick={() => void run(async () => {
            const result = await cleoClient.checkSubscription(profile);
            setModels(result.models); setStatus("连接验证成功；未发送聊天请求。可以保存此 Profile。");
          })}>验证连接 / 读取模型</button>
          {login?.status === "pending" && <button type="button" onClick={() => void run(async () => {
            setLogin(await cleoClient.cancelSubscriptionLogin(login.id)); loginRef.current = null;
          })}>取消登录</button>}
        </div>
        {login?.url?.startsWith("https://") && <p><a href={login.url} target="_blank" rel="noreferrer">打开官方登录页面</a></p>}
        {login && <p role="status">{login.status === "completed" ? "登录完成，请验证连接。" : login.status === "pending" ? "等待官方登录完成…" : "登录已结束"}</p>}
        {login?.output && <pre>{login.output}</pre>}
        {status && <p role="status">{status}</p>}
      </div>
      {!!models.length && <label className="wide"><span>账号可用模型</span><select value={profile.model} onChange={(event) => onChange({ model: event.target.value })}>
        <option value="default">使用官方默认模型</option>
        {models.map((model) => <option key={model} value={model}>{model}</option>)}
      </select></label>}
    </>}
  </>;
}

export function DreamSettings({ settings }: { settings: ModelSettings | null }) {
  const [selection, setSelection] = useState("mode:follow");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setSelection(settings?.dreamEnabled === false ? "mode:disabled" : settings?.activeDreamAgent || "mode:follow");
  }, [settings]);
  return <div className="subscription-connection">
    <label>DreamAgent 记忆整理<select aria-label="DreamAgent 记忆整理" disabled={busy} value={selection} onChange={async (event) => {
      const value = event.target.value;
      setBusy(true);
      try { await cleoClient.saveDreamSettings(value); setSelection(value); setStatus("已保存"); }
      catch (error) { setStatus(error instanceof Error ? error.message : "保存失败"); }
      finally { setBusy(false); }
    }}>
      <option value="mode:follow">跟随当前会话的 Chat 模型（默认）</option>
      <option value="mode:disabled">关闭自动整理</option>
      {settings?.profiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name} · {profile.model}</option>)}
    </select></label>
    <p>整理在独立任务中运行。额度不足或登录过期时保留待整理来源，不自动切换付费 API。</p>
    {status && <p role="status">{status}</p>}
  </div>;
}
