import { t as tr } from "../../../electron/i18n.mjs";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ExternalLink, Eye, KeyRound, UserRound } from "lucide-react";
import { cleoClient } from "../../services/cleoClient";
import type { ApplyModelSettings, ModelConnectionInput, ModelConnectionProbe, ModelProfileInput, ModelProfileSummary, ModelSettings, SubscriptionLogin, SubscriptionRuntime } from "../../types";
import { accounts, apiProviders, isAccount, modelLabel, profileLabel, profileModels } from "./catalog";
import { ConnectionScope } from "./ConnectionScope";

const message = (error: unknown) => error instanceof Error ? error.message : tr("connectionwizard.connection_failed_try_again");

export function ConnectionWizard({ existing, settings, busy, onApply, onDone, active = true }: {
  existing: ModelProfileSummary | null; settings: ModelSettings; busy: boolean;
  onApply: ApplyModelSettings; onDone: () => void;
  active?: boolean;
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
  const [step, setStep] = useState<"connect" | "models">("connect");
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
  const saving = useRef(false);
  const account = providerId ? accounts[providerId] : undefined;
  const api = apiProviders.find(p => p.id === providerId);
  const provider = type === "api" ? api : account;
  const runtime = catalog.find(p => p.backend === providerId);
  const input: ModelConnectionInput = { displayName: name.trim(), backend: type === "api" ? "api" : providerId || "", provider: existing?.provider || (type === "api" ? api?.provider || "openai" : providerId || ""), apiKey: type === "api" ? key.trim() : "", baseUrl: type === "api" ? baseUrl.trim() : "", executable: type === "account" ? executable.trim() : "", models: chosen };
  const protectedModels = existing ? [...new Set([existing.model, ...(settings.activeDreamAgent === existing.name && settings.activeDreamModel ? [settings.activeDreamModel] : [])])] : [];
  const locked = busy || working || login?.status === "pending";
  const probeState = useRef({ step, working });
  probeState.current = { step, working };

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
      setChosen(current => existing ? profileModels(existing) : current.length ? current : result.models.length ? [result.models[0]] : type === "account" ? ["default"] : []);
      setStep("models");
    } catch (error) { if (mounted.current && request === operation.current) setError(message(error)); }
    finally { if (mounted.current && request === operation.current) setWorking(false); }
  };

  useEffect(() => {
    if (!active || type !== "account" || !providerId) return;
    const refresh = () => {
      if (!document.hidden && probeState.current.step === "connect" && !probeState.current.working && !loginRef.current) void readModels();
    };
    const timer = window.setTimeout(refresh, 250);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearTimeout(timer); window.removeEventListener("focus", refresh);
      operation.current++; setWorking(false);
      if (loginRef.current) {
        const id = loginRef.current; loginRef.current = null; setLogin(null);
        void cleoClient.cancelSubscriptionLogin(id).catch(() => {});
      }
    };
  }, [active, type, providerId, executable]);

  useEffect(() => {
    if (!active || !login || login.status !== "pending") return;
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
  }, [login, active]);

  const chooseProvider = (id: string, nextType = type) => {
    operation.current++; setWorking(false); setType(nextType); setProviderId(id); setStep("connect"); setProbe(null); setChosen([]); setLogin(null); setError(""); setKey(""); setManualModel(""); setModelQuery(""); setExecutable("");
    const item = nextType === "api" ? apiProviders.find(p => p.id === id)! : accounts[id];
    setName(`${item.name} · ${nextType === "api" ? "API" : tr("connectionwizard.personal_account")}`);
    setBaseUrl(nextType === "api" ? apiProviders.find(p => p.id === id)!.baseUrl : "");
  };
  const switchType = (value: "api" | "account") => {
    operation.current++; setWorking(false); setType(value); setProviderId(null); setKey(""); setLogin(null); setStep("connect"); setProbe(null); setError("");
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
    if (saving.current || busy) return;
    if (!name.trim()) { setError(tr("connectionwizard.enter_a_connection_name")); return; }
    if (!chosen.length) { setError(tr("connectionwizard.select_or_enter_at_least_one_model")); return; }
    saving.current = true;
    setError("");
    try {
      if (existing) await onApply(() => cleoClient.saveModelProfile({
        name: existing.name, displayName: name.trim(), provider: input.provider, backend: input.backend,
        model: existing.model, models: [...new Set([...chosen, ...protectedModels])],
        apiKey: input.apiKey, baseUrl: input.baseUrl, executable: input.executable,
        maxTokens: existing.maxTokens, activateAgent: false, activateDreamAgent: false,
      }));
      else await onApply(() => cleoClient.createModelConnection(input));
      if (mounted.current) { setKey(""); onDone(); }
    } catch (error) { if (mounted.current) setError(message(error)); }
    finally { saving.current = false; }
  };
  const visibleModels = [...new Set([...(probe?.models || []), ...chosen])].filter(id => `${id} ${modelLabel(id)}`.toLowerCase().includes(modelQuery.toLowerCase()));

  return <>
    <div className="ms-tabs" role="tablist" aria-label={tr("connectionwizard.connection_method")}>
      {([['api', tr("catalog.api_key"), KeyRound], ['account', tr("catalog.account_sign_in"), UserRound]] as const).map(([value, label, Icon]) => <button key={value} role="tab" aria-selected={type === value} className={type === value ? "active" : ""} disabled={busy || login?.status === "pending" || !!existing} onClick={() => switchType(value)}><Icon />{label}</button>)}
    </div>
    <div className="ms-connect-layout">
      <div className="ms-providers">
        <div className="ms-list-label">{tr("connectionwizard.choose_provider")}</div>
        {(type === "api" ? apiProviders : catalog.map(item => ({ id: item.backend, ...accounts[item.backend], name: accounts[item.backend]?.name || item.label, mark: accounts[item.backend]?.mark || "·" }))).map(item =>
          <button key={item.id} className={`ms-provider-option ${providerId === item.id ? "active" : ""}`} aria-pressed={providerId === item.id} disabled={busy || login?.status === "pending" || !!existing} onClick={() => chooseProvider(item.id)}><span className="ms-mark">{item.mark}</span><strong>{item.name}</strong></button>)}
        {type === "account" && !catalog.length && <p className="ms-muted">{error || tr("connectionwizard.loading_sign_in_options")}</p>}
      </div>
      <div className="ms-connect-pane">
        {!provider ? <div className="ms-empty-selection">{type === "api" ? <KeyRound /> : <UserRound />}<strong>{tr("connectionwizard.select_a_provider")}</strong></div> : <>
          <div className="ms-connect-heading"><span className="ms-mark">{provider.mark}</span><h3>{tr("connectionwizard.connect")}{provider.name}</h3></div>
          <div className="ms-steps">{[type === "api" ? tr("connectionwizard.verify_key") : tr("connectionwizard.account_connection"), tr("connectionwizard.choose_model")].map((label, i) => <span key={label} className={i === ({ connect: 0, models: 1 })[step] ? "active" : ""}><b>{i + 1}</b>{label}</span>)}</div>
          {step === "connect" && type === "api" && <form onSubmit={e => { e.preventDefault(); void readModels(); }}>
            <label className="ms-field"><span>{tr("connectiondetails.connection_name")}</span><input value={name} onChange={e => setName(e.target.value)} required disabled={locked} /></label>
            <label className="ms-field"><span>API Key</span><div className="ms-input-wrap"><input type={showKey ? "text" : "password"} autoComplete="new-password" value={key} onChange={e => { setKey(e.target.value); setError(""); }} required disabled={locked} /><button type="button" className="ms-icon" aria-label={tr("connectionwizard.show_or_hide_key")} onClick={() => setShowKey(!showKey)}><Eye /></button></div></label>
            <details className="ms-advanced" open={providerId === "custom" || undefined}><summary>{tr("connectionwizard.advanced_settings")}</summary><label className="ms-field"><span>Base URL</span><input type="url" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} required={providerId === "custom"} disabled={locked} /></label></details>
            <button className="ms-primary ms-full" disabled={locked}>{working ? tr("connectionwizard.verifying_connection") : <>{tr("connectionwizard.verify_and_continue")}<ArrowRight /></>}</button>
          </form>}
          {step === "connect" && type === "account" && account && <>
            <p className="ms-meta">{account.billing}</p>
            <ConnectionScope note={account.note} />
            {login?.status === "pending" ? <div className="ms-waiting"><div className="ms-spinner" /><h3>{tr("connectionwizard.waiting_for_account_authorization")}</h3>{login.url?.startsWith("https://") && <a className="ms-secondary" href={login.url} target="_blank" rel="noreferrer">{tr("connectionwizard.open_the_official_sign_in_page")}<ExternalLink /></a>}<button className="ms-quiet" disabled={working} onClick={() => void cancelLogin()}>{tr("githublogin.cancel_sign_in")}</button></div> : <>
              <button className="ms-primary ms-full" disabled={locked} onClick={() => void startLogin()}><ExternalLink />{working ? tr("connectionwizard.connecting") : account.login}</button>
              {error && <button className="ms-quiet ms-full" disabled={locked} onClick={() => void readModels()}>{tr("connectiondetails.retry_check")}</button>}
            </>}
            {login?.output && <pre className="ms-login-output">{login.output}</pre>}
            {runtime && <a className="ms-link" href={runtime.docs} target="_blank" rel="noreferrer">{tr("connectionwizard.install_the_official_client")}<ExternalLink /></a>}
            <details className="ms-advanced"><summary>{tr("connectionwizard.specify_client_path")}</summary><label className="ms-field"><span>{tr("connectionwizard.client_path")}</span><input value={executable} onChange={e => setExecutable(e.target.value)} placeholder={tr("connectionwizard.automatically_find_a_locally_installed_client")} disabled={busy || login?.status === "pending"} /></label></details>
          </>}
          {step === "models" && <>
            {probe?.status === "connected" && <div className="ms-connected"><Check />{type === "account" ? tr("connectiondetails.client_checks_passed") : tr("connectionwizard.connection_verified")}</div>}
            {type === "account" && <ConnectionScope />}
            <label className="ms-field"><span>{tr("connectiondetails.connection_name")}</span><input value={name} onChange={e => setName(e.target.value)} disabled={busy} /></label>
            <div className="ms-models-label">{tr("connectionwizard.select_models_to_add")}<span>{tr("connectionwizard.selected")}{chosen.length}</span></div>
            <input className="ms-model-filter" aria-label={tr("connectionwizard.filter_available_models")} placeholder={tr("connectionwizard.search_available_models")} value={modelQuery} onChange={e => setModelQuery(e.target.value)} />
            <div className="ms-check-models">{visibleModels.map(id => <label key={id}><input type="checkbox" checked={chosen.includes(id)} disabled={busy || protectedModels.includes(id)} onChange={e => setChosen(e.target.checked ? [...new Set([...chosen, id])] : chosen.filter(value => value !== id))} /><span>{modelLabel(id)}</span></label>)}</div>
            {!visibleModels.length && <p className="ms-muted">{probe?.message || tr("connectionwizard.no_models_found_you_can_enter_a_model_id_manually")}</p>}
            <form className="ms-manual-model" onSubmit={e => { e.preventDefault(); if (manualModel.trim()) { setChosen([...new Set([...chosen, manualModel.trim()])]); setManualModel(""); setModelQuery(""); } }}><input aria-label={tr("connectionwizard.model_name")} placeholder={tr("connectionwizard.enter_model_id")} value={manualModel} onChange={e => setManualModel(e.target.value)} /><button className="ms-secondary" disabled={!manualModel.trim() || busy}>{tr("connectionwizard.add")}</button></form>
            <div className="ms-form-actions"><button className="ms-quiet" disabled={busy} onClick={() => setStep("connect")}><ArrowLeft />{tr("connectionwizard.back")}</button><button className="ms-primary" disabled={!chosen.length || busy} onClick={() => void save()}>{busy ? tr("backgroundmemorysettingspanel.saving") : existing ? tr("connectionwizard.save_connection") : tr("connectionwizard.add_connection")}<Check /></button></div>
          </>}
          {error && <p className="ms-error" role="alert">{error}</p>}
        </>}
      </div>
    </div>
  </>;
}
