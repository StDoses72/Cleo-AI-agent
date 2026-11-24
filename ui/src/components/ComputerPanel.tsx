import { t as tr } from "../../electron/i18n.mjs";
import { MODE_LABEL_KEYS, phaseLabel, stepLabel } from "../../electron/computer/labels.mjs";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import {
  AppWindow, ArrowLeft, ArrowRight, Check, CircleAlert, Download, Expand, Globe, Hand, Loader2, Minimize, Monitor, MoonStar, Play,
  Plus, RefreshCw, RotateCw, ShieldAlert, Square, X,
} from "lucide-react";
import type { Thread, TimelineItem } from "../types";
import type { BrowserTabState, ComputerMode, ComputerSegment, ComputerState, ComputerThreadState, UserBrowserTab } from "../computer-types";
import "./computer-panel.css";

export function isComputerTool(item: TimelineItem): item is Extract<TimelineItem, { type: "tool" }> {
  return item.type === "tool" && /(?:^|__)computer_(?:tools|call)$/.test(item.name);
}

type ComputerAction = Parameters<NonNullable<NonNullable<Window["cleoDesktop"]>["computer"]>>[0];

const MODE_ICON: Record<ComputerMode, typeof Globe> = { browser: Globe, user: AppWindow, host: Monitor };
const modeName = (mode: ComputerMode) => tr(MODE_LABEL_KEYS[mode]);

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

/** Purpose: Follow the desktop app's computer state. Output: state, a request helper, errors. */
export function useComputerState() {
  const [state, setState] = useState<ComputerState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const bridge = window.cleoDesktop;
    if (!bridge?.computer) { setError(tr("computerpanel.use_computer_controls_in_the_cleo_desktop_app")); return; }
    let mounted = true;
    void bridge.computer("state").then(next => { if (mounted) setState(next); }).catch(cause => {
      if (mounted) setError(cause instanceof Error ? cause.message : tr("computerpanel.could_not_load_computer_use_status"));
    });
    const unsubscribe = bridge.onComputerState?.(next => { if (mounted) setState(current => ({ ...next, userTabs: current?.userTabs })); });
    return () => { mounted = false; unsubscribe?.(); };
  }, []);
  const act = useCallback(async (action: ComputerAction, params: Record<string, unknown> = {}) => {
    const bridge = window.cleoDesktop;
    if (!bridge?.computer) return null;
    setBusy(true); setError("");
    try {
      const next = await bridge.computer(action, params);
      if (next && typeof next === "object" && "browser" in next) setState(current => ({ ...next, userTabs: next.userTabs ?? current?.userTabs }));
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : tr("computerpanel.operation_did_not_complete"));
      return null;
    } finally { setBusy(false); }
  }, []);
  return { state, error, busy, act };
}

function tabLabel(tab: BrowserTabState) {
  return tab.title || tab.url.replace(/^https?:\/\//, "") || tr("computerpanel.new_tab");
}

function seconds(value: number) {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}s`;
}

function total(segment: ComputerSegment) {
  return segment.timing.think + segment.timing.tool + segment.timing.wait;
}

/** The phase as a coloured dot and words: running, needs you, failed or quiet. */
function PhaseState({ entry, stopping }: { entry: ComputerThreadState | undefined; stopping: boolean }) {
  const activity = entry?.activity;
  const phase = activity?.phase ?? "idle";
  const step = activity?.segments.at(-1)?.steps.at(-1);
  const tone = stopping ? "warn" : phase === "paused" || phase === "waiting-user" ? "warn" : phase === "failed" ? "bad" : phase === "idle" ? "" : "run";
  const text = stopping ? tr("computerpanel.stopping_and_confirming")
    : phaseLabel(phase, activity?.current ?? null, step?.status === "running" ? step.detail : "");
  return <span className={`computer-state ${tone}`} data-testid="computer-phase"><i />{text}</span>;
}

/** What the current segment's time went to: the model thinking, actions, waiting for apps. */
function Timing({ segment }: { segment: ComputerSegment }) {
  const all = total(segment);
  if (all < 0.2) return null;
  const width = (value: number) => `${(value / all * 100).toFixed(1)}%`;
  return <div className="computer-timing" data-testid="computer-timing">
    <div className="computer-timing-bar"><i className="think" style={{ width: width(segment.timing.think) }} /><i className="tool" style={{ width: width(segment.timing.tool) }} /><i className="wait" style={{ width: width(segment.timing.wait) }} /></div>
    <div className="computer-timing-legend"><span className="think">{tr("computerpanel.timing_think", { p0: seconds(segment.timing.think) })}</span>
      <span className="tool">{tr("computerpanel.timing_tool", { p0: seconds(segment.timing.tool) })}</span>
      <span className="wait">{tr("computerpanel.timing_wait", { p0: seconds(segment.timing.wait) })}</span></div>
  </div>;
}

function Steps({ segment, paused }: { segment: ComputerSegment; paused: boolean }) {
  const steps = segment.steps.slice(-6).reverse();
  if (!steps.length) return null;
  return <div className="computer-steps">
    <div className="computer-steps-head"><span>{tr("computerpanel.recent_computer_actions")}</span><span>{tr("computerpanel.steps_value", { p0: segment.stepCount })}</span></div>
    {steps.map(step => <article key={step.id} className={`computer-step ${step.status}`}>
      <i /><span>{stepLabel(step.name, step.detail)}</span>
      <small>{step.status === "done" ? seconds(step.seconds) : step.status === "running" ? paused ? tr("computerpanel.waiting_for_control") : tr("computerpanel.in_progress")
        : step.status === "cancelled" ? tr("computerpanel.cancelled") : tr("computerpanel.not_completed")}</small>
    </article>)}
  </div>;
}

export function ComputerPanel({ thread, running, onStop }: { thread: Thread | null; running: boolean; onStop: () => void }) {
  const { state, error, busy, act } = useComputerState();
  const [expanded, setExpanded] = useState(false);
  const [picking, setPicking] = useState(false);
  const modalOpen = useModalOpen();
  const threadId = thread?.id ?? null;
  const entry = threadId ? state?.threads[threadId] : undefined;
  const segments = entry?.activity?.segments ?? [];
  const segment = segments.at(-1) ?? null;
  // The browser of the conversation the main process currently shows; while the panel switches
  // conversations, another conversation's tabs must not flash through.
  const browser = state?.browser && (state.browser.threadId === undefined || state.browser.threadId === threadId) ? state.browser : null;
  const turnRunning = Boolean(entry?.running ?? running);
  // Only the target the agent is using now is shown; after the turn, a summary of what it did.
  const mode: ComputerMode | null = turnRunning && segment ? segment.mode : turnRunning && entry && entry.mode !== "browser" ? entry.mode : null;
  const showBuiltIn = mode === "browser" || (!mode && Boolean(browser?.tabs.length || browser?.hibernated));
  const showSummary = !mode && segments.length > 0;
  const target = mode === "host" ? "desktop" : mode === "user" ? "user" : "browser";
  const control = mode === "user" ? entry?.userControl ?? "agent" : state?.control[target] ?? "agent";
  const stopping = Boolean(state?.stopping);
  const canStop = Boolean(state && (turnRunning || control === "user"));
  const stop = async () => {
    const result = await act("stop", { threadId });
    if (!result && running) onStop();
  };

  if (error && !state) {
    return <section className="computer-panel" aria-label={tr("computerpanel.computer_use_2")}><p className="computer-panel-error"><CircleAlert size={14} />{error}</p></section>;
  }
  if (!mode && !showSummary && !showBuiltIn) {
    return <section className="computer-panel is-empty" aria-label={tr("computerpanel.computer_use_2")} data-testid="computer-empty">
      <p className="computer-empty">{tr("computerpanel.no_computer_use_yet")}</p>
    </section>;
  }

  const Icon = mode ? MODE_ICON[mode] : Check;
  const userTarget = entry?.userTarget ?? null;
  const subtitle = mode === "browser" ? (browser?.tabs.find(tab => tab.id === browser.activeTabId)?.url.replace(/^https?:\/\//, "") || "")
    : mode === "user" ? [state?.userBrowser?.browser?.name, state?.userBrowser?.connected ? tr("computerpanel.connected") : tr("computerpanel.disconnected")].filter(Boolean).join(" · ")
      : mode === "host" ? (segment?.target || tr("computerpanel.real_mouse_and_keyboard")) : "";

  return <section className={`computer-panel ${expanded ? "is-expanded" : ""}`} aria-label={tr("computerpanel.computer_use_2")} data-mode={mode ?? "summary"}>
    {mode ? <header className="computer-mode-head" key={mode} data-testid="computer-mode-head">
      <span className={`computer-mode-icon ${mode}`}><Icon size={16} /></span>
      <div><strong>{modeName(mode)}</strong>{subtitle && <small title={subtitle}>{subtitle}</small>}</div>
      <PhaseState entry={entry} stopping={stopping} />
      {mode === "browser" && <button className="icon-button" type="button" aria-label={expanded ? tr("computerpanel.collapse_browser") : tr("computerpanel.expand_browser")}
        onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize size={15} /> : <Expand size={15} />}</button>}
    </header> : showSummary ? <Summary segments={segments} /> : null}
    {state?.bridgeError && <p className="computer-panel-error"><CircleAlert size={14} />{state.bridgeError}</p>}

    {mode === "user" && <UserBrowserTarget threadId={threadId} entry={entry} state={state} userTarget={userTarget} picking={picking}
      onPick={() => { setPicking(value => !value); if (!picking) void act("userTabs"); }}
      onChoose={tabId => { setPicking(false); void act("userTarget", { threadId, tabId }); }} busy={busy} />}
    {mode === "host" && <div className="computer-section computer-host" data-testid="computer-host">
      <div className="computer-kv"><span>{tr("computerpanel.emergency_stop_shortcut")}</span><kbd>{state?.stopShortcut ?? "Control+Alt+Escape"}</kbd></div>
      {state?.shortcutError && <p className="computer-panel-error"><CircleAlert size={14} />{state.shortcutError}</p>}
      {segment && <Timing segment={segment} />}
    </div>}
    {showBuiltIn && <BuiltInBrowser threadId={threadId} browser={browser} state={state} act={act} agentActive={mode === "browser"}
      visible={!modalOpen} expanded={expanded} />}

    {(mode || control === "user") && <div className="computer-control-bar">
      <div>
        <button type="button" disabled={busy || !state || !turnRunning} onClick={() => void act(control === "user" ? "handback" : "takeover", { target, threadId })}>
          {control === "user" ? <Play size={13} /> : <Hand size={13} />}{control === "user" ? tr("computerpanel.return_control_to_ai") : tr("computerpanel.take_over")}</button>
        <button type="button" className="stop" disabled={busy || !canStop || stopping} onClick={() => void stop()}><Square size={12} />{tr("computerpanel.stop")}</button>
      </div>
    </div>}
    {state?.lastStop && Date.now() - state.lastStop.at < 30000 && (!state.lastStop.threadId || state.lastStop.threadId === threadId) && <p className="computer-panel-hint">
      {state.lastStop.settled ? tr("computerpanel.stopped_value", { p0: state.lastStop.cancelledRun ? tr("computerpanel.task") : tr("computerpanel.computer_use_2") }) : tr("computerpanel.stopping_computer_use_awaiting_confirmation")}{state.lastStop.released.length ? tr("computerpanel.released_value_keys_or_buttons", { p0: state.lastStop.released.length }) : ""}{state.lastStop.hostError ? `；${state.lastStop.hostError}` : ""}{tr("punctuation.period")}</p>}
    {error && <p className="computer-panel-error" role="status"><CircleAlert size={14} />{error}</p>}
    {mode && segment && segment.mode === mode && <Steps segment={segment} paused={control === "user"} />}
  </section>;
}

/** After a turn: one row per stretch of work, in order, with steps and time. */
function Summary({ segments }: { segments: ComputerSegment[] }) {
  const all = segments.reduce((sum, segment) => sum + total(segment), 0);
  return <div className="computer-summary" data-testid="computer-summary">
    <header className="computer-mode-head">
      <span className="computer-mode-icon"><Check size={16} /></span>
      <div><strong>{tr("computerpanel.this_turn")}</strong><small>{tr("computerpanel.segments_value", { p0: segments.length, p1: seconds(all) })}</small></div>
    </header>
    {segments.map(segment => {
      const Icon = MODE_ICON[segment.mode];
      return <div className="computer-summary-row" key={segment.id}>
        <Icon size={14} /><div><strong>{modeName(segment.mode)}</strong>{segment.target && <small title={segment.target}>{segment.target}</small>}</div>
        <small>{tr("computerpanel.steps_value", { p0: segment.stepCount })} · {seconds(total(segment))}</small>
      </div>;
    })}
  </div>;
}

function UserBrowserTarget({ threadId, entry, state, userTarget, picking, onPick, onChoose, busy }: {
  threadId: string | null; entry: ComputerThreadState | undefined; state: ComputerState | null;
  userTarget: ComputerThreadState["userTarget"]; picking: boolean; onPick: () => void; onChoose: (tabId: string) => void; busy: boolean;
}) {
  const alert = entry?.userAlert;
  const tabs = state?.userTabs ?? [];
  const windows = [...new Set(tabs.map(tab => tab.windowId))];
  return <>
    {alert && <div className="computer-alert" role="alert">
      <CircleAlert size={14} /><div><strong>{alert === "closed" ? tr("computerpanel.target_tab_closed") : alert === "detached" ? tr("computerpanel.browser_debugging_cancelled") : tr("computerpanel.browser_disconnected")}</strong>
        {alert === "closed" && <button type="button" disabled={busy || !threadId} onClick={onPick}>{tr("computerpanel.choose_tab")}</button>}</div>
    </div>}
    <div className="computer-section" data-testid="computer-user-target">
      <div className="computer-section-title"><span>{tr("computerpanel.target_tab")}</span>
        <button type="button" disabled={busy || !threadId || !state?.userBrowser?.connected} onClick={onPick}>{userTarget ? tr("computerpanel.change") : tr("computerpanel.choose")}</button></div>
      {userTarget ? <div className="computer-target"><Globe size={14} /><div><strong title={userTarget.title}>{userTarget.title || userTarget.url}</strong><small title={userTarget.url}>{userTarget.url}</small></div></div>
        : <p className="computer-quiet">—</p>}
      {picking && <div className="computer-picker" role="listbox" aria-label={tr("computerpanel.target_tab")}>
        {windows.map((windowId, index) => <div key={windowId}>
          <span className="computer-picker-window">{tr("computerpanel.window_value", { p0: index + 1 })}</span>
          {tabs.filter(tab => tab.windowId === windowId).map((tab: UserBrowserTab) => <button key={tab.id} type="button" role="option"
            aria-selected={tab.id === userTarget?.id} className={tab.id === userTarget?.id ? "active" : ""} onClick={() => onChoose(tab.id)}>
            <span>{tab.title || tab.url}</span>{tab.cleo && <i className="computer-group-chip">Cleo</i>}</button>)}
        </div>)}
        {!tabs.length && <p className="computer-quiet"><Loader2 size={12} className="spin" /></p>}
      </div>}
    </div>
  </>;
}

/** Cleo's own browser: tabs, address bar and the native page view placed over the viewport. */
function BuiltInBrowser({ threadId, browser, state, act, agentActive, visible, expanded }: {
  threadId: string | null; browser: ComputerState["browser"] | null; state: ComputerState | null;
  act: (action: ComputerAction, params?: Record<string, unknown>) => Promise<unknown>; agentActive: boolean; visible: boolean; expanded: boolean;
}) {
  const [address, setAddress] = useState("");
  const [editingAddress, setEditingAddress] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [showDownloads, setShowDownloads] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const lastRect = useRef("");
  const activeTab = browser?.tabs.find(tab => tab.id === browser.activeTabId) ?? null;
  const hibernated = browser?.hibernated ?? null;
  const browserAction = (action: string, params: Record<string, unknown> = {}) => act("browser", { threadId, action, ...params });

  // Keep the native browser view exactly over the viewport placeholder.
  useLayoutEffect(() => {
    const bridge = window.cleoDesktop;
    if (!bridge?.computer) return;
    const element = viewport.current;
    const report = () => {
      const rect = visible && element && !document.hidden ? element.getBoundingClientRect() : null;
      const value = rect && rect.width > 0 && rect.height > 0
        ? { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
        : null;
      const key = JSON.stringify({ value, threadId });
      if (key === lastRect.current) return;
      lastRect.current = key;
      void bridge.computer?.("viewport", { rect: value, threadId }).catch(() => {});
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
      void bridge.computer?.("viewport", { rect: null, threadId }).catch(() => {});
    };
  }, [visible, expanded, threadId]);

  useEffect(() => {
    if (!editingAddress) setAddress(activeTab?.url === "about:blank" ? "" : activeTab?.url ?? "");
  }, [activeTab?.url, activeTab?.id, editingAddress]);
  useEffect(() => { setPromptText(activeTab?.dialog?.defaultPrompt ?? ""); }, [activeTab?.dialog?.message, activeTab?.dialog?.defaultPrompt]);

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    const url = address.trim();
    if (!url) return;
    setEditingAddress(false);
    void (activeTab ? browserAction("navigate", { tabId: activeTab.id, url }) : browserAction("newTab", { url }));
  };

  return <>
    <div className="browser-tabs" role="tablist" aria-label={tr("computerpanel.browser_tabs")}>
      {browser?.tabs.map(tab => <div key={tab.id} role="tab" aria-selected={tab.id === browser.activeTabId}
        className={`browser-tab ${tab.id === browser.activeTabId ? "active" : ""}`}>
        <button type="button" className="browser-tab-title" title={tab.url} onClick={() => void browserAction("activate", { tabId: tab.id })}>
          {tab.loading ? <Loader2 size={11} className="spin" /> : tab.crashed ? <CircleAlert size={11} /> : null}{tabLabel(tab)}
        </button>
        <button type="button" className="browser-tab-close" aria-label={tr("computerpanel.close_value", { p0: tabLabel(tab) })} onClick={() => void browserAction("close", { tabId: tab.id })}><X size={11} /></button>
      </div>)}
      <button type="button" className="browser-tab-new" aria-label={tr("computerpanel.new_tab_2")} onClick={() => void browserAction("newTab")}><Plus size={13} /></button>
    </div>
    <form className="browser-toolbar" onSubmit={navigate}>
      <button type="button" className="icon-button" aria-label={tr("computerpanel.back")} disabled={!activeTab?.canGoBack} onClick={() => void browserAction("back")}><ArrowLeft size={14} /></button>
      <button type="button" className="icon-button" aria-label={tr("computerpanel.forward")} disabled={!activeTab?.canGoForward} onClick={() => void browserAction("forward")}><ArrowRight size={14} /></button>
      <button type="button" className="icon-button" aria-label={activeTab?.loading ? tr("computerpanel.stop_loading") : tr("computerpanel.refresh")} disabled={!activeTab}
        onClick={() => void browserAction(activeTab?.loading ? "stop" : "reload")}>{activeTab?.loading ? <X size={14} /> : <RotateCw size={14} />}</button>
      <input aria-label={tr("computerpanel.address_bar")} value={address} placeholder={tr("computerpanel.enter_a_url_localhost_3000_or_a_search")} spellCheck={false}
        onFocus={() => setEditingAddress(true)} onBlur={() => setEditingAddress(false)} onChange={event => setAddress(event.target.value)} />
      {activeTab && activeTab.zoom !== 1 && <button type="button" className="browser-zoom" title={tr("computerpanel.reset_zoom_to_100")}
        onClick={() => void browserAction("zoomReset")}>{Math.round(activeTab.zoom * 100)}%</button>}
      <button type="button" className="icon-button" aria-label={tr("computerpanel.downloads")} onClick={() => setShowDownloads(value => !value)}>
        <Download size={14} />{browser?.downloads.some(item => item.state === "progressing") && <i className="browser-download-dot" />}
      </button>
    </form>
    {showDownloads && <div className="browser-downloads">
      {!browser?.downloads.length ? <p>{browser?.downloadsDir}</p> : browser.downloads.map(item => <button type="button" key={item.id}
        onClick={() => void browserAction("openDownloads", { downloadId: item.id })}>
        <strong>{item.name}</strong><small>{item.state === "progressing" ? `${item.total ? Math.round(item.received / item.total * 100) : 0}%` : item.state === "completed" ? tr("computerpanel.completed_show_in_folder") : tr("computerpanel.not_completed")}</small>
      </button>)}
    </div>}
    {activeTab?.dialog && <div className="browser-banner" role="alert">
      <CircleAlert size={14} /><div><strong>{tr("computerpanel.browser_dialog")}{activeTab.dialog.type}{tr("punctuation.closeParen")}</strong><p>{activeTab.dialog.message}</p>
        {activeTab.dialog.type === "prompt" && <input aria-label={tr("computerpanel.dialog_input")} value={promptText} onChange={event => setPromptText(event.target.value)} />}
        <div className="computer-authorization-actions">
          <button type="button" onClick={() => void browserAction("dialog", { accept: true, text: promptText })}>{tr("computerpanel.confirm")}</button>
          <button type="button" onClick={() => void browserAction("dialog", { accept: false })}>{tr("computerpanel.cancel")}</button>
        </div></div>
    </div>}
    {activeTab?.fileChooser && <div className="browser-banner" role="alert">
      <CircleAlert size={14} /><div><strong>{tr("computerpanel.the_page_requests_a_file")}</strong>
        <div className="computer-authorization-actions">
          <button type="button" onClick={() => void browserAction("pickFiles")}>{tr("computerpanel.choose_file")}</button>
          <button type="button" onClick={() => void browserAction("cancelFiles")}>{tr("computerpanel.cancel")}</button>
        </div></div>
    </div>}
    {hibernated && !browser?.tabs.length && <div className="browser-banner" role="status" data-testid="browser-hibernated">
      <MoonStar size={14} /><div><strong>{tr("computerpanel.browser_asleep")}</strong>
        <p>{tr("computerpanel.browser_asleep_detail_value", { p0: hibernated.tabs.length })}</p>
        <div className="computer-authorization-actions"><button type="button" onClick={() => void browserAction("wake")}>{tr("computerpanel.reopen_pages")}</button></div></div>
    </div>}
    {(activeTab?.crashed || activeTab?.error || activeTab?.unresponsive) && <div className="browser-banner" role="status">
      <CircleAlert size={14} /><div><strong>{activeTab.crashed ? tr("computerpanel.the_page_crashed") : activeTab.unresponsive ? tr("computerpanel.the_page_is_not_responding") : tr("computerpanel.the_page_failed_to_load")}</strong>
        <p>{activeTab.crashed ? tr("computerpanel.reason_value", { p0: activeTab.crashed }) : activeTab.error?.description || ""}</p>
        <div className="computer-authorization-actions"><button type="button" onClick={() => void browserAction("reload")}><RefreshCw size={12} />{tr("computerpanel.reload")}</button></div></div>
    </div>}
    <div className={`browser-viewport ${agentActive ? "agent" : ""}`} ref={viewport} data-testid="browser-viewport">
      {!browser?.tabs.length && <div className="browser-empty"><Globe size={28} /></div>}
    </div>
    {browser?.notices[0] && Date.now() - browser.notices[0].at < 60000 && state && <p className="computer-panel-hint">{browser.notices[0].text}</p>}
  </>;
}

/** Computer requests that need the user, shown in the conversation like other approvals: the
 * desktop (real mouse and keyboard) and websites in the user's own browser. */
export function ComputerApprovals({ threadId }: { threadId: string | null }) {
  const { state, busy, act, error } = useComputerState();
  if (!threadId || !state) return null;
  const desktop = state.authorization?.threadId === threadId ? state.authorization : null;
  const site = state.siteRequests?.find(item => item.threadId === threadId) ?? null;
  if (!desktop && !site) return null;
  return <section className="computer-approval" role="alert" data-testid="computer-approval">
    {desktop ? <>
      <header><ShieldAlert size={16} /><h3>{tr("computerpanel.ai_requests_local_computer_access_real_mouse_and_keyboard")}</h3></header>
      <ul>
        <li>{tr("computerpanel.reason")}{desktop.reason}</li>
        <li>{tr("computerpanel.approval_host_scope", { p0: state.stopShortcut })}</li>
      </ul>
      <div className="computer-approval-actions">
        <button type="button" className="danger" disabled={busy} onClick={() => void act("authorize", { id: desktop.id, granted: true })}>{tr("computerpanel.authorize_local_control")}</button>
        <button type="button" disabled={busy} onClick={() => void act("authorize", { id: desktop.id, granted: false })}>{tr("approvalprompt.deny")}</button>
      </div>
    </> : site ? <>
      <header><AppWindow size={16} /><h3>{tr("computerpanel.site_question", { p0: site.browser, p1: site.host })}</h3></header>
      {site.title && <p>{site.title}</p>}
      <div className="computer-approval-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void act("site", { id: site.id, choice: "once" })}>{tr("computerpanel.site_once")}</button>
        <button type="button" disabled={busy} onClick={() => void act("site", { id: site.id, choice: "always" })}>{tr("computerpanel.site_always")}</button>
        <button type="button" disabled={busy} onClick={() => void act("site", { id: site.id, choice: "all" })}>{tr("computerpanel.site_all")}</button>
        <button type="button" className="quiet" disabled={busy} onClick={() => void act("site", { id: site.id, choice: "deny" })}>{tr("approvalprompt.deny")}</button>
      </div>
    </> : null}
    {error && <p className="computer-panel-error" role="status"><CircleAlert size={14} />{error}</p>}
  </section>;
}
