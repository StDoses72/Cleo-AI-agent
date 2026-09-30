import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft, ArrowRight, CircleAlert, Download, Expand, Globe, Hand, Loader2, Minimize, Monitor, Play,
  Plus, RotateCw, ShieldAlert, Square, X,
} from "lucide-react";
import type { Thread, TimelineItem } from "../types";
import type { BrowserTabState, ComputerMode, ComputerState, ComputerTarget } from "../computer-types";
import "./computer-panel.css";

export function isComputerTool(item: TimelineItem): item is Extract<TimelineItem, { type: "tool" }> {
  return item.type === "tool" && /(?:^|__)computer_(?:tools|call)$/.test(item.name);
}

const OPERATION_LABELS: Record<string, string> = {
  browser_screenshot: "查看浏览器", browser_click: "点击网页", browser_move: "移动指针", browser_drag: "拖动",
  browser_scroll: "滚动网页", browser_type: "输入文字", browser_key: "按键", browser_navigate: "打开网址",
  browser_history: "前进/后退/刷新", browser_tabs: "管理标签页", browser_read: "读取网页内容", browser_dialog: "处理网页对话框",
  browser_upload: "上传文件", browser_wait: "等待页面", request_desktop_control: "请求本机控制",
  desktop_screenshot: "查看本机桌面", desktop_click: "点击本机", desktop_move: "移动鼠标", desktop_drag: "拖动",
  desktop_scroll: "滚动", desktop_type: "输入文字", desktop_key: "按键", desktop_app: "打开或切换应用", desktop_wait: "等待应用",
};

/** Render operation names from JSON or older Python-style timeline input. */
function operationLabel(step: Extract<TimelineItem, { type: "tool" }>) {
  if (step.name.endsWith("computer_tools")) return "读取可用操作";
  const name = /["']name["']\s*:\s*["']([^"']+)["']/.exec(step.command)?.[1] ?? "";
  return OPERATION_LABELS[name] || "操作电脑";
}

const MODAL_SELECTOR = "dialog[open], .setup-overlay, .command-palette, .overlay-backdrop, .settings-modal";

/** Purpose: Hide native browser views while a Cleo modal is actually visible.
 * Input: The mounted DOM, including retained closed dialogs. Output: Visible-modal state.
 */
function useModalOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const check = () => setOpen(Array.from(document.querySelectorAll(MODAL_SELECTOR)).some(element =>
      element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible"));
    const observer = new MutationObserver(check);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["open", "class", "hidden", "style"] });
    check();
    return () => observer.disconnect();
  }, []);
  return open;
}

function useComputerState() {
  const [state, setState] = useState<ComputerState | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const bridge = window.cleoDesktop;
    if (!bridge?.computer) { setError("请在 Cleo 桌面应用中使用电脑操作。"); return; }
    let mounted = true;
    void bridge.computer("state").then(next => { if (mounted) setState(next); }).catch(cause => {
      if (mounted) setError(cause instanceof Error ? cause.message : "无法读取电脑操作状态。");
    });
    const unsubscribe = bridge.onComputerState?.(next => { if (mounted) setState(next); });
    return () => { mounted = false; unsubscribe?.(); };
  }, []);
  return { state, setState, error, setError };
}

function tabLabel(tab: BrowserTabState) {
  return tab.title || tab.url.replace(/^https?:\/\//, "") || "新标签页";
}

export function ComputerPanel({ thread, running, onStop }: { thread: Thread | null; running: boolean; onStop: () => void }) {
  const { state, setState, error, setError } = useComputerState();
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [confirmHost, setConfirmHost] = useState(false);
  const [address, setAddress] = useState("");
  const [editingAddress, setEditingAddress] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [shortcut, setShortcut] = useState("");
  const [showDownloads, setShowDownloads] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const lastRect = useRef("");
  const modalOpen = useModalOpen();
  const threadId = thread?.id ?? null;
  const mode: ComputerMode = (threadId && state?.threads[threadId]?.mode) || "browser";
  const target: ComputerTarget = mode === "host" ? "desktop" : "browser";
  const browser = state?.browser;
  const activeTab = browser?.tabs.find(tab => tab.id === browser.activeTabId) ?? null;
  const control = state?.control[target] ?? "agent";
  const working = Boolean(state?.inflight.some(job => job.target === target));
  const steps = (thread?.items ?? []).filter(isComputerTool).slice(-6).reverse();
  const showBrowser = mode === "browser" && !modalOpen && !confirmHost;

  const act = useCallback(async (action: Parameters<NonNullable<NonNullable<Window["cleoDesktop"]>["computer"]>>[0], params: Record<string, unknown> = {}) => {
    const bridge = window.cleoDesktop;
    if (!bridge?.computer) return null;
    setBusy(true); setError("");
    try {
      const next = await bridge.computer(action, params);
      if (next && typeof next === "object" && "browser" in next) setState(next);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "操作未完成。");
      return null;
    } finally { setBusy(false); }
  }, [setError, setState]);

  // Keep the native browser view exactly over the viewport placeholder.
  useLayoutEffect(() => {
    const bridge = window.cleoDesktop;
    if (!bridge?.computer) return;
    const element = viewport.current;
    const report = () => {
      const rect = showBrowser && element && !document.hidden ? element.getBoundingClientRect() : null;
      const value = rect && rect.width > 0 && rect.height > 0
        ? { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
        : null;
      const key = JSON.stringify(value);
      if (key === lastRect.current) return;
      lastRect.current = key;
      void bridge.computer?.("viewport", { rect: value }).catch(() => {});
    };
    report();
    const observer = element ? new ResizeObserver(report) : null;
    if (element) observer?.observe(element);
    window.addEventListener("resize", report);
    document.addEventListener("visibilitychange", report);
    const timer = setInterval(report, 400);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", report);
      document.removeEventListener("visibilitychange", report);
      clearInterval(timer);
      lastRect.current = "";
      void bridge.computer?.("viewport", { rect: null }).catch(() => {});
    };
  }, [showBrowser, expanded]);

  useEffect(() => {
    if (!editingAddress) setAddress(activeTab?.url === "about:blank" ? "" : activeTab?.url ?? "");
  }, [activeTab?.url, activeTab?.id, editingAddress]);

  useEffect(() => { setPromptText(activeTab?.dialog?.defaultPrompt ?? ""); }, [activeTab?.dialog?.message, activeTab?.dialog?.defaultPrompt]);

  const browserAction = (action: string, params: Record<string, unknown> = {}) => act("browser", { action, ...params });

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    const url = address.trim();
    if (!url) return;
    setEditingAddress(false);
    void (activeTab ? browserAction("navigate", { tabId: activeTab.id, url }) : browserAction("newTab", { url }));
  };

  const chooseMode = (next: ComputerMode) => {
    if (!threadId || next === mode) return;
    if (next === "host") { setConfirmHost(true); return; }
    void act("mode", { threadId, mode: "browser" });
  };

  const stop = async () => {
    const result = await act("stop");
    if (!result && running) onStop();
  };

  if (error && !state) {
    return <section className="computer-panel" aria-label="电脑操作"><p className="computer-panel-error"><CircleAlert size={14} />{error}</p></section>;
  }

  const authorization = state?.authorization;
  const statusText = state?.stopping ? "正在停止并确认…" : control === "user" ? "你正在操作 · AI 已暂停"
    : working ? `AI 正在操作${mode === "host" ? "本机" : "浏览器"}` : (state?.lease?.running && state.lease.threadId === threadId) ? "电脑任务进行中" : "空闲";
  const canStop = Boolean(state && (working || state.lease?.running || running || control === "user"));

  return <section className={`computer-panel ${expanded ? "is-expanded" : ""}`} aria-label="电脑操作">
    <header className="computer-panel-header">
      <Monitor size={16} /><strong>电脑操作</strong>
      <div className="computer-mode-switch" role="radiogroup" aria-label="操作目标">
        <button type="button" role="radio" aria-checked={mode === "browser"} className={mode === "browser" ? "active" : ""}
          disabled={!threadId || busy} onClick={() => chooseMode("browser")}><Globe size={13} />内置浏览器</button>
        <button type="button" role="radio" aria-checked={mode === "host"} className={mode === "host" ? "active host" : ""}
          disabled={!threadId || busy || state?.hostSupported === false} title={state?.hostSupported === false ? "本机电脑模式目前仅支持 Windows" : undefined}
          onClick={() => chooseMode("host")}><Monitor size={13} />本机电脑</button>
      </div>
      {mode === "browser" && <button className="icon-button" type="button" aria-label={expanded ? "收起浏览器" : "放大浏览器"}
        onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize size={15} /> : <Expand size={15} />}</button>}
    </header>
    {!threadId && <p className="computer-panel-hint">选择或新建一个任务后，可在这里选择 AI 的操作目标。</p>}
    {state?.bridgeError && <p className="computer-panel-error"><CircleAlert size={14} />{state.bridgeError}</p>}

    {authorization && <div className="computer-authorization" role="alert">
      <ShieldAlert size={16} />
      <div><strong>AI 请求使用本机电脑（真实鼠标键盘）</strong>
        <p>{authorization.threadId === threadId ? "当前任务" : "另一个任务"}说明：“{authorization.reason}”。这段说明来自 AI，可能受网页内容影响；只有你确认需要时才授权。</p>
        <div className="computer-authorization-actions">
          <button type="button" className="danger" disabled={busy} onClick={() => void act("authorize", { id: authorization.id, granted: true })}>授权本机控制</button>
          <button type="button" disabled={busy} onClick={() => void act("authorize", { id: authorization.id, granted: false })}>拒绝</button>
        </div>
      </div>
    </div>}

    {confirmHost && <div className="computer-host-confirm" role="dialog" aria-label="授权本机电脑模式">
      <ShieldAlert size={18} />
      <strong>切换到本机电脑模式？</strong>
      <ul>
        <li>AI 将使用<strong>真实鼠标和键盘</strong>操作你的 Windows 桌面，可打开或切换任何应用（包括终端）。</li>
        <li>你同时使用电脑会与 AI 冲突；检测到你操作鼠标键盘时 AI 会暂停。</li>
        <li>屏幕顶部会一直显示状态条，可随时接管或停止；紧急停止快捷键：{state?.stopShortcut ?? "Control+Alt+Escape"}。</li>
        <li>授权只对当前任务有效，切回内置浏览器、停止或重启 Cleo 后失效。</li>
      </ul>
      <div className="computer-authorization-actions">
        <button type="button" className="danger" disabled={busy} onClick={() => { setConfirmHost(false); void act("mode", { threadId, mode: "host", confirmed: true }); }}>授权并切换</button>
        <button type="button" disabled={busy} onClick={() => setConfirmHost(false)}>取消</button>
      </div>
    </div>}

    {mode === "browser" ? <>
      <div className="browser-tabs" role="tablist" aria-label="浏览器标签页">
        {browser?.tabs.map(tab => <div key={tab.id} role="tab" aria-selected={tab.id === browser.activeTabId}
          className={`browser-tab ${tab.id === browser.activeTabId ? "active" : ""}`}>
          <button type="button" className="browser-tab-title" title={tab.url} onClick={() => void browserAction("activate", { tabId: tab.id })}>
            {tab.loading ? <Loader2 size={11} className="spin" /> : tab.crashed ? <CircleAlert size={11} /> : null}{tabLabel(tab)}
          </button>
          <button type="button" className="browser-tab-close" aria-label={`关闭 ${tabLabel(tab)}`} onClick={() => void browserAction("close", { tabId: tab.id })}><X size={11} /></button>
        </div>)}
        <button type="button" className="browser-tab-new" aria-label="新建标签页" onClick={() => void browserAction("newTab")}><Plus size={13} /></button>
      </div>
      <form className="browser-toolbar" onSubmit={navigate}>
        <button type="button" className="icon-button" aria-label="后退" disabled={!activeTab?.canGoBack} onClick={() => void browserAction("back")}><ArrowLeft size={14} /></button>
        <button type="button" className="icon-button" aria-label="前进" disabled={!activeTab?.canGoForward} onClick={() => void browserAction("forward")}><ArrowRight size={14} /></button>
        <button type="button" className="icon-button" aria-label={activeTab?.loading ? "停止加载" : "刷新"} disabled={!activeTab}
          onClick={() => void browserAction(activeTab?.loading ? "stop" : "reload")}>{activeTab?.loading ? <X size={14} /> : <RotateCw size={14} />}</button>
        <input aria-label="地址栏" value={address} placeholder="输入网址、localhost:3000 或搜索内容" spellCheck={false}
          onFocus={() => setEditingAddress(true)} onBlur={() => setEditingAddress(false)} onChange={event => setAddress(event.target.value)} />
        {activeTab && activeTab.zoom !== 1 && <button type="button" className="browser-zoom" title="恢复 100% 缩放"
          onClick={() => void browserAction("zoomReset")}>{Math.round(activeTab.zoom * 100)}%</button>}
        <button type="button" className="icon-button" aria-label="下载" onClick={() => setShowDownloads(value => !value)}>
          <Download size={14} />{browser?.downloads.some(item => item.state === "progressing") && <i className="browser-download-dot" />}
        </button>
      </form>
      {showDownloads && <div className="browser-downloads">
        {!browser?.downloads.length ? <p>还没有下载。文件会保存到 {browser?.downloadsDir}。</p> : browser.downloads.map(item => <button type="button" key={item.id}
          onClick={() => void browserAction("openDownloads", { downloadId: item.id })}>
          <strong>{item.name}</strong><small>{item.state === "progressing" ? `${item.total ? Math.round(item.received / item.total * 100) : 0}%` : item.state === "completed" ? "已完成 · 在文件夹中显示" : "未完成"}</small>
        </button>)}
      </div>}
      {activeTab?.dialog && <div className="browser-banner" role="alert">
        <CircleAlert size={14} /><div><strong>网页对话框（{activeTab.dialog.type}）</strong><p>{activeTab.dialog.message}</p>
          {activeTab.dialog.type === "prompt" && <input aria-label="对话框输入" value={promptText} onChange={event => setPromptText(event.target.value)} />}
          <div className="computer-authorization-actions">
            <button type="button" onClick={() => void browserAction("dialog", { accept: true, text: promptText })}>确定</button>
            <button type="button" onClick={() => void browserAction("dialog", { accept: false })}>取消</button>
          </div></div>
      </div>}
      {activeTab?.fileChooser && <div className="browser-banner" role="alert">
        <CircleAlert size={14} /><div><strong>网页请求选择文件</strong><p>AI 只能上传当前任务工作目录中的文件；也可以由你选择。</p>
          <div className="computer-authorization-actions">
            <button type="button" onClick={() => void browserAction("pickFiles")}>选择文件…</button>
            <button type="button" onClick={() => void browserAction("cancelFiles")}>取消</button>
          </div></div>
      </div>}
      {(activeTab?.crashed || activeTab?.error || activeTab?.unresponsive) && <div className="browser-banner" role="status">
        <CircleAlert size={14} /><div><strong>{activeTab.crashed ? "页面已崩溃" : activeTab.unresponsive ? "页面无响应" : "页面加载失败"}</strong>
          <p>{activeTab.crashed ? `原因：${activeTab.crashed}` : activeTab.error?.description || ""}</p>
          <div className="computer-authorization-actions"><button type="button" onClick={() => void browserAction("reload")}>重新加载</button></div></div>
      </div>}
      <div className="browser-viewport" ref={viewport} data-testid="browser-viewport">
        {!browser?.tabs.length && <div className="browser-empty"><Globe size={28} /><span>在地址栏输入网址开始浏览。AI 执行 /computeruse 任务时也会在这里打开网页。</span></div>}
        {modalOpen && <div className="browser-empty"><span>对话框打开时浏览器画面暂时隐藏。</span></div>}
      </div>
      {browser?.notices[0] && Date.now() - browser.notices[0].at < 60000 && <p className="computer-panel-hint">{browser.notices[0].text}</p>}
    </> : <div className="computer-host-panel">
      <Monitor size={28} />
      <strong>{state?.threads[threadId ?? ""]?.hostAuthorized ? "已授权 AI 操作本机电脑" : "本机电脑模式"}</strong>
      <p>AI 使用真实鼠标和键盘操作 Windows 桌面上的应用。它操作时屏幕顶部会显示红色状态条；你移动鼠标或按键时 AI 会自动暂停。</p>
      <p>不会操作 Cleo 自身的窗口。网页任务请切回内置浏览器，它不会影响你正在使用的其他应用。</p>
      <form className="computer-shortcut" onSubmit={event => { event.preventDefault(); if (shortcut.trim()) void act("shortcut", { value: shortcut.trim() }).then(() => setShortcut("")); }}>
        <label>紧急停止快捷键<input value={shortcut} placeholder={state?.stopShortcut ?? "Control+Alt+Escape"} onChange={event => setShortcut(event.target.value)} /></label>
        <button type="submit" disabled={busy || !shortcut.trim()}>保存</button>
      </form>
      <small>{state?.shortcutError || (state?.shortcutActive ? `${state.stopShortcut} 已生效，在任何应用中按下都会立即停止。` : "授权本机控制后快捷键生效。")}</small>
      <button type="button" disabled={busy} onClick={() => chooseMode("browser")}>撤销授权，切回内置浏览器</button>
    </div>}

    <div className="computer-control-bar">
      <span><i className={working ? "is-running" : control === "user" ? "is-user" : ""} />{statusText}</span>
      <div>
        <button type="button" disabled={busy || !state} onClick={() => void act(control === "user" ? "handback" : "takeover", { target })}>
          {control === "user" ? <Play size={13} /> : <Hand size={13} />}{control === "user" ? "交回 AI" : "接管"}</button>
        <button type="button" className="stop" disabled={busy || !canStop || state?.stopping} onClick={() => void stop()}><Square size={12} />停止</button>
      </div>
    </div>
    {control === "user" && <p className="computer-panel-hint">AI 已暂停，未执行的操作已取消。交回后 AI 会重新截图，不会沿用旧坐标。</p>}
    {state?.lastStop && Date.now() - state.lastStop.at < 30000 && <p className="computer-panel-hint">
      {state.lastStop.settled ? `已停止${state.lastStop.cancelledRun ? "任务" : "电脑操作"}` : "正在停止电脑操作，等待确认"}{state.lastStop.released.length ? `，释放了 ${state.lastStop.released.length} 个按键或按钮` : ""}{state.lastStop.hostError ? `；${state.lastStop.hostError}` : ""}。</p>}
    {error && <p className="computer-panel-error" role="status"><CircleAlert size={14} />{error}</p>}
    <div className="computer-steps"><h3>最近的电脑操作</h3>
      {!steps.length && <p>输入 /computeruse 和任务内容，AI 会使用这里选择的目标。</p>}
      {steps.map(step => <article key={step.id} className={`computer-step ${step.status}`}>
        <i /><div><strong>{operationLabel(step)}</strong></div>
        <small>{step.status === "error" ? "未完成" : step.status === "running" ? control === "user" ? "等待交回" : "进行中" : "已返回"}</small>
      </article>)}
    </div>
  </section>;
}
