import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ExternalLink, Eye, Info, KeyRound, UserRound } from "lucide-react";
import { cleoClient } from "../../services/cleoClient";
import type { ApplyModelSettings, ModelConnectionInput, ModelConnectionProbe, ModelProfileInput, ModelProfileSummary, ModelSettings, SubscriptionLogin, SubscriptionRuntime } from "../../types";
import { accounts, apiProviders, isAccount, modelLabel, profileLabel, profileModels } from "./catalog";

const message = (error: unknown) => error instanceof Error ? error.message : "连接失败，请重试。";

export function ConnectionWizard({ existing, settings, busy, onApply, onDone }: {
  existing: ModelProfileSummary | null; settings: ModelSettings; busy: boolean;
  onApply: ApplyModelSettings; onDone: () => void;
}) {
  const initialApi = existing ? apiProviders.find(p => p.baseUrl === existing.baseUrl && p.provider === existing.provider)
    || apiProviders.find(p => p.provider === existing.provider) : undefined;
  const [type, setType] = useState<"api" | "account">(existing && isAccount(existing) ? "account" : "api");
  const [providerId, setProviderId] = useState<string | null>(existing ? isAccount(existing) ? existing.backend! : initialApi?.id || "custom" : null);
  const [name, setName] = useState(existing ? profileLabel(existing) : "");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl || "");
  const [executable, setExecutable] = useState(existing?.executable || "");
  const [step, setStep] = useState<"connect" | "models" | "done">("connect");
  const [probe, setProbe] = useState<ModelConnectionProbe | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [modelQuery, setModelQuery] = useState("");
  const [manualModel, setManualModel] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [catalog, setCatalog] = useState<SubscriptionRuntime[]>([]);
  const [login, setLogin] = useState<SubscriptionLogin | null>(null);
  const operation = useRef(0);
  const loginRef = useRef<string | null>(null);
  const mounted = useRef(true);
  const account = providerId ? accounts[providerId] : undefined;
  const api = apiProviders.find(p => p.id === providerId);
  const provider = type === "api" ? api : account;
  const runtime = catalog.find(p => p.backend === providerId);
  const input: ModelConnectionInput = { displayName: name.trim(), backend: type === "api" ? "api" : providerId || "", provider: existing?.provider || (type === "api" ? api?.provider || "openai" : providerId || ""), apiKey: type === "api" ? key.trim() : "", baseUrl: type === "api" ? baseUrl.trim() : "", executable: type === "account" ? executable.trim() : "", models: chosen };
  const protectedModels = existing ? [...new Set([existing.model, ...(settings.activeDreamAgent === existing.name && settings.activeDreamModel ? [settings.activeDreamModel] : [])])] : [];
  const locked = busy || working || login?.status === "pending";

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void cleoClient.getSubscriptionCatalog().then(value => { if (!cancelled) setCatalog(value); }).catch(error => { if (!cancelled) setError(message(error)); });
    return () => {
      cancelled = true; mounted.current = false; operation.current++;
      if (loginRef.current) void cleoClient.cancelSubscriptionLogin(loginRef.current).catch(() => {});
      loginRef.current = null;
    };
  }, []);

  const readModels = async () => {
    const request = ++operation.current;
    setWorking(true); setError("");
    try {
      const result = await cleoClient.checkModelConnection(input);
      if (!mounted.current || request !== operation.current) return;
      setProbe(result);
      setChosen(existing ? profileModels(existing) : result.models.length ? [result.models[0]] : type === "account" ? ["default"] : []);
      setStep("models");
    } catch (error) { if (mounted.current && request === operation.current) setError(message(error)); }
    finally { if (mounted.current && request === operation.current) setWorking(false); }
  };

  useEffect(() => {
    if (!login || login.status !== "pending") return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const next = await cleoClient.readSubscriptionLogin(login.id);
        if (cancelled || !mounted.current) return;
        setLogin(next);
        if (next.status !== "pending") loginRef.current = null;
        if (next.status === "completed") void readModels();
      } catch (error) {
        if (!cancelled && mounted.current) {
          setError(message(error)); setLogin(null);
          void cleoClient.cancelSubscriptionLogin(login.id).catch(() => {});
          loginRef.current = null;
        }
      }
    }, 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [login]);

  const chooseProvider = (id: string, nextType = type) => {
    operation.current++; setType(nextType); setProviderId(id); setStep("connect"); setProbe(null); setChosen([]); setLogin(null); setError(""); setKey(""); setManualModel(""); setModelQuery(""); setExecutable("");
    const item = nextType === "api" ? apiProviders.find(p => p.id === id)! : accounts[id];
    setName(`${item.name} · ${nextType === "api" ? "API" : "个人账号"}`);
    setBaseUrl(nextType === "api" ? apiProviders.find(p => p.id === id)!.baseUrl : "");
  };
  const switchType = (value: "api" | "account") => {
    operation.current++; setType(value); setProviderId(null); setKey(""); setLogin(null); setStep("connect"); setProbe(null); setError("");
  };
  const startLogin = async () => {
    const request = ++operation.current; setWorking(true); setError("");
    const loginInput: ModelProfileInput = { name: "", provider: input.provider, model: "default", backend: input.backend, executable: input.executable, apiKey: "", baseUrl: "", maxTokens: 100000, activateAgent: false, activateDreamAgent: false };
    try {
      const attempt = await cleoClient.startSubscriptionLogin(loginInput);
      if (!mounted.current || request !== operation.current) {
        await cleoClient.cancelSubscriptionLogin(attempt.id); return;
      }
      loginRef.current = attempt.status === "pending" ? attempt.id : null;
      setLogin(attempt);
      if (attempt.status === "completed") await readModels();
    } catch (error) { if (mounted.current && request === operation.current) setError(message(error)); }
    finally { if (mounted.current) setWorking(false); }
  };
  const cancelLogin = async () => {
    if (!login) return;
    operation.current++; setWorking(true);
    try { await cleoClient.cancelSubscriptionLogin(login.id); loginRef.current = null; setLogin(null); }
    catch (error) { setError(message(error)); }
    finally { setWorking(false); }
  };
  const save = async () => {
    if (!name.trim()) { setError("请填写连接名称。"); return; }
    if (!chosen.length) { setError("请至少选择或填写一个模型。"); return; }
    setError("");
    try {
      if (existing) await onApply(() => cleoClient.saveModelProfile({
        name: existing.name, displayName: name.trim(), provider: input.provider, backend: input.backend,
        model: existing.model, models: [...new Set([...chosen, ...protectedModels])],
        apiKey: input.apiKey, baseUrl: input.baseUrl, executable: input.executable,
        maxTokens: existing.maxTokens, activateAgent: false, activateDreamAgent: false,
      }));
      else await onApply(() => cleoClient.createModelConnection(input));
      if (mounted.current) { setKey(""); setStep("done"); }
    } catch (error) { if (mounted.current) setError(message(error)); }
  };
  const visibleModels = [...new Set([...(probe?.models || []), ...chosen])].filter(id => `${id} ${modelLabel(id)}`.toLowerCase().includes(modelQuery.toLowerCase()));

  return <>
    <div className="ms-tabs" role="tablist" aria-label="连接方式">
      {([['api', 'API 密钥', KeyRound], ['account', '账号登录', UserRound]] as const).map(([value, label, Icon]) => <button key={value} role="tab" aria-selected={type === value} className={type === value ? "active" : ""} disabled={locked || !!existing} onClick={() => switchType(value)}><Icon />{label}</button>)}
    </div>
    <div className="ms-connect-layout">
      <div className="ms-providers">
        <div className="ms-list-label">选择服务商</div>
        {(type === "api" ? apiProviders : catalog.map(item => ({ id: item.backend, ...accounts[item.backend], name: accounts[item.backend]?.name || item.label, mark: accounts[item.backend]?.mark || "·" }))).map(item =>
          <button key={item.id} className={`ms-provider-option ${providerId === item.id ? "active" : ""}`} aria-pressed={providerId === item.id} disabled={locked || !!existing} onClick={() => chooseProvider(item.id)}><span className="ms-mark">{item.mark}</span><strong>{item.name}</strong></button>)}
        {type === "account" && !catalog.length && <p className="ms-muted">{error || "正在读取登录方式…"}</p>}
      </div>
      <div className="ms-connect-pane">
        {!provider ? <div className="ms-empty-selection">{type === "api" ? <KeyRound /> : <UserRound />}<strong>选择一个服务商</strong></div> : <>
          {step !== "done" && <div className="ms-connect-heading"><span className="ms-mark">{provider.mark}</span><h3>连接 {provider.name}</h3></div>}
          <div className="ms-steps">{[type === "api" ? "验证密钥" : "账号授权", "选择模型", "完成"].map((label, i) => <span key={label} className={i === ({ connect: 0, models: 1, done: 2 })[step] ? "active" : ""}><b>{i + 1}</b>{label}</span>)}</div>
          {step === "connect" && type === "api" && <form onSubmit={e => { e.preventDefault(); void readModels(); }}>
            <label className="ms-field"><span>连接名称</span><input value={name} onChange={e => setName(e.target.value)} required disabled={locked} /></label>
            <label className="ms-field"><span>API Key</span><div className="ms-input-wrap"><input type={showKey ? "text" : "password"} autoComplete="new-password" value={key} onChange={e => { setKey(e.target.value); setError(""); }} required disabled={locked} /><button type="button" className="ms-icon" aria-label="显示或隐藏密钥" onClick={() => setShowKey(!showKey)}><Eye /></button></div></label>
            <details className="ms-advanced" open={providerId === "custom" || undefined}><summary>高级设置</summary><label className="ms-field"><span>Base URL</span><input type="url" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} required={providerId === "custom"} disabled={locked} /></label></details>
            <button className="ms-primary ms-full" disabled={locked}>{working ? "正在验证连接…" : <>验证并继续<ArrowRight /></>}</button>
          </form>}
          {step === "connect" && type === "account" && account && <>
            <div className="ms-billing"><Info /><div><strong>{account.billing}</strong><p>{account.note}</p></div></div>
            {login?.status === "pending" ? <div className="ms-waiting"><div className="ms-spinner" /><h3>等待账号授权</h3>{login.url?.startsWith("https://") && <a className="ms-secondary" href={login.url} target="_blank" rel="noreferrer">打开官方登录页面<ExternalLink /></a>}<button className="ms-quiet" disabled={working} onClick={() => void cancelLogin()}>取消登录</button></div> : <>
              <button className="ms-primary ms-full" disabled={locked} onClick={() => void startLogin()}><ExternalLink />{working ? "正在连接…" : account.login}</button>
              <button className="ms-quiet ms-full" disabled={locked} onClick={() => void readModels()}>已登录，验证连接</button>
            </>}
            {login?.output && <pre className="ms-login-output">{login.output}</pre>}
            <details className="ms-advanced"><summary>高级设置</summary><label className="ms-field"><span>官方客户端路径（可选）</span><input value={executable} onChange={e => setExecutable(e.target.value)} placeholder="自动查找本机已安装的客户端" disabled={locked} /></label>{runtime && <a className="ms-link" href={runtime.docs} target="_blank" rel="noreferrer">安装官方客户端<ExternalLink /></a>}</details>
          </>}
          {step === "models" && <>
            {probe?.status === "connected" && <div className="ms-connected"><Check />连接验证成功</div>}
            <label className="ms-field"><span>连接名称</span><input value={name} onChange={e => setName(e.target.value)} disabled={busy} /></label>
            <div className="ms-models-label">选择要添加的模型<span>已选 {chosen.length}</span></div>
            <input className="ms-model-filter" aria-label="筛选可用模型" placeholder="搜索可用模型" value={modelQuery} onChange={e => setModelQuery(e.target.value)} />
            <div className="ms-check-models">{visibleModels.map(id => <label key={id}><input type="checkbox" checked={chosen.includes(id)} disabled={busy || protectedModels.includes(id)} onChange={e => setChosen(e.target.checked ? [...new Set([...chosen, id])] : chosen.filter(value => value !== id))} /><span>{modelLabel(id)}</span></label>)}</div>
            {!visibleModels.length && <p className="ms-muted">{probe?.message || "没有找到模型，可手动填写模型 ID。"}</p>}
            <form className="ms-manual-model" onSubmit={e => { e.preventDefault(); if (manualModel.trim()) { setChosen([...new Set([...chosen, manualModel.trim()])]); setManualModel(""); setModelQuery(""); } }}><input aria-label="模型名称" placeholder="输入模型 ID" value={manualModel} onChange={e => setManualModel(e.target.value)} /><button className="ms-secondary" disabled={!manualModel.trim() || busy}>添加</button></form>
            <div className="ms-form-actions"><button className="ms-quiet" disabled={busy} onClick={() => setStep("connect")}><ArrowLeft />返回</button><button className="ms-primary" disabled={!chosen.length || busy} onClick={() => void save()}>{busy ? "保存中…" : existing ? "保存连接" : "添加连接"}<Check /></button></div>
          </>}
          {step === "done" && <div className="ms-success"><span className="ms-success-icon"><Check /></span><h3>{existing ? "连接已更新" : "连接已添加"}</h3><div className="ms-success-summary"><span className="ms-mark">{provider.mark}</span><div><strong>{name}</strong><span className="ms-meta">{chosen.length} 个模型</span></div></div><button className="ms-primary" onClick={onDone}>返回当前配置<ArrowRight /></button></div>}
          {error && <p className="ms-error" role="alert">{error}</p>}
        </>}
      </div>
    </div>
  </>;
}
