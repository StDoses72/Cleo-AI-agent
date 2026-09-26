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
 * Input: native setup bridge. Output: first-run or settings dialog; scan never installs anything.
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
    const inspect = async (show = false) => {
      const current = ++revision.current;
      if (show) setOpen(true);
      try {
        const next = await native(show ? "scan" : "startup");
        if (!alive || current !== revision.current) return;
        setState(next); if (show || next.showOnStartup) setOpen(true);
      } catch (failure) { if (alive) { setError(String(failure)); setOpen(true); } }
    };
    const show = () => { void inspect(true); };
    window.addEventListener("cleo:open-setup", show);
    void inspect();
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
  return <Modal open className="setup-overlay" label="运行环境" onClose={busy ? undefined : () => void close()}>
    <section className="setup-dialog">
      <header><div><small>CLEO / SETUP</small><h2>准备你的工作环境</h2></div><button className="icon-button" aria-label="关闭运行环境" disabled={busy} onClick={() => void close()}><X size={18} /></button></header>
      <p>已检查本机依赖。选择需要的功能，再授权安装；独立桌面可以稍后准备。</p>
      {!state?.items.length && <p role="status">正在检查运行环境…</p>}
      <div className="setup-items">{state?.items.map(item => <label className="setup-item" key={item.id}>
        {item.ready ? <Check size={18} className="setup-ready" /> : <input type="checkbox" aria-label={item.action} checked={selected.includes(item.id)} disabled={busy}
          onChange={event => { setSelected(ids => event.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id)); setConsent(false); }} />}
        <span><strong>{item.title}</strong><small>{item.detail}</small></span><em>{item.ready ? "已就绪" : item.optional ? "可选" : "需要处理"}</em>
      </label>)}</div>
      {selected.length > 0 && <label className="setup-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />
        <span>允许下载并安装所选依赖。WSL / Docker 可能要求系统授权或重启；安装 Docker 需同意其许可协议及软件源协议，账号登录由我完成。</span></label>}
      {state?.restartRequired && <p className="setup-notice">如 Windows 要求重启，请重启电脑后重新打开此向导。安装进度会保留。</p>}
      {!error && (state?.message || busy) && <p role="status">{state?.message || "正在检查…"}</p>}
      {error && <p role="alert" className="setup-error">{error}</p>}
      {state?.logs && <details><summary>查看安装日志</summary><pre>{state.logs}</pre></details>}
      <footer>{Boolean(state?.pendingIds?.length) && <button disabled={busy} onClick={() => void operate("install", true)}>继续已授权安装</button>}<button disabled={busy} onClick={() => void close()}>稍后再说</button><button disabled={busy} onClick={() => void operate("scan")}><RefreshCw size={14} />重新检查</button>
        <button className="setup-install" disabled={busy || !selected.length || !consent} onClick={() => void operate("install")}><Download size={14} />{busy ? "处理中…" : "安装所选依赖"}</button></footer>
    </section>
  </Modal>;
}
