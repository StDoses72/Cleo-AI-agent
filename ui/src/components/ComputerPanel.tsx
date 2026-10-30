import { t as tr } from "../../electron/i18n.mjs";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft, ArrowRight, CircleAlert, Download, Expand, Globe, Hand, Loader2, Minimize, Monitor, MoonStar, Play,
  Plus, RotateCw, ShieldAlert, Square, X,
} from "lucide-react";
import type { Thread, TimelineItem } from "../types";
import type { BrowserTabState, ComputerMode, ComputerState, ComputerTarget } from "../computer-types";
import "./computer-panel.css";

export function isComputerTool(item: TimelineItem): item is Extract<TimelineItem, { type: "tool" }> {
  return item.type === "tool" && /(?:^|__)computer_(?:tools|call)$/.test(item.name);
}

const OPERATION_LABELS: Record<string, string> = {
  get browser_screenshot() { return tr("computerpanel.view_browser"); }, get browser_click() { return tr("computerpanel.click_on_the_page"); }, get browser_move() { return tr("computerpanel.move_pointer"); }, get browser_drag() { return tr("computerpanel.drag"); },
  get browser_scroll() { return tr("computerpanel.scroll_the_page"); }, get browser_type() { return tr("computerpanel.type_text"); }, get browser_key() { return tr("computerpanel.press_keys"); }, get browser_navigate() { return tr("computerpanel.open_url"); },
  get browser_history() { return tr("computerpanel.back_forward_reload"); }, get browser_tabs() { return tr("computerpanel.manage_tabs"); }, get browser_read() { return tr("computerpanel.read_page_content"); }, get browser_dialog() { return tr("computerpanel.handle_browser_dialogs"); },
  get browser_upload() { return tr("computerpanel.upload_files"); }, get browser_wait() { return tr("computerpanel.wait_for_the_page"); }, get request_desktop_control() { return tr("computerpanel.request_local_computer_control"); },
  get desktop_screenshot() { return tr("computerpanel.view_the_local_desktop"); }, get desktop_click() { return tr("computerpanel.click_on_the_desktop"); }, get desktop_move() { return tr("computerpanel.move_mouse"); }, get desktop_drag() { return tr("computerpanel.drag"); },
  get desktop_scroll() { return tr("computerpanel.scroll"); }, get desktop_type() { return tr("computerpanel.type_text"); }, get desktop_key() { return tr("computerpanel.press_keys"); }, get desktop_app() { return tr("computerpanel.open_or_switch_applications"); }, get desktop_wait() { return tr("computerpanel.wait_for_an_application"); },
};

/** Render operation names from JSON or older Python-style timeline input. */
function operationLabel(step: Extract<TimelineItem, { type: "tool" }>) {
  if (step.name.endsWith("computer_tools")) return tr("computerpanel.read_available_actions");
  const name = /["']name["']\s*:\s*["']([^"']+)["']/.exec(step.command)?.[1] ?? "";
  return OPERATION_LABELS[name] || tr("computerpanel.computer_use");
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
    if (!bridge?.computer) { setError(tr("computerpanel.use_computer_controls_in_the_cleo_desktop_app")); return; }
    let mounted = true;
    void bridge.computer("state").then(next => { if (mounted) setState(next); }).catch(cause => {
      if (mounted) setError(cause instanceof Error ? cause.message : tr("computerpanel.could_not_load_computer_use_status"));
    });
    const unsubscribe = bridge.onComputerState?.(next => { if (mounted) setState(next); });
    return () => { mounted = false; unsubscribe?.(); };
  }, []);
  return { state, setState, error, setError };
}

function tabLabel(tab: BrowserTabState) {
  return tab.title || tab.url.replace(/^https?:\/\//, "") || tr("computerpanel.new_tab");
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
  // The main process reports the browser of the conversation it currently shows; while the
  // panel switches conversations, another conversation's tabs must not flash through.
  const browser = state?.browser && (state.browser.threadId === undefined || state.browser.threadId === threadId) ? state.browser : null;
  const activeTab = browser?.tabs.find(tab => tab.id === browser.activeTabId) ?? null;
  const hibernated = browser?.hibernated ?? null;
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
      setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : tr("computerpanel.operation_did_not_complete"));
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
  }, [showBrowser, expanded, threadId]);

  useEffect(() => {
    if (!editingAddress) setAddress(activeTab?.url === "about:blank" ? "" : activeTab?.url ?? "");
  }, [activeTab?.url, activeTab?.id, editingAddress]);

  useEffect(() => { setPromptText(activeTab?.dialog?.defaultPrompt ?? ""); }, [activeTab?.dialog?.message, activeTab?.dialog?.defaultPrompt]);

  const browserAction = (action: string, params: Record<string, unknown> = {}) => act("browser", { threadId, action, ...params });

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
    const result = await act("stop", { threadId });
    if (!result && running) onStop();
  };

  if (error && !state) {
    return <section className="computer-panel" aria-label={tr("computerpanel.computer_use_2")}><p className="computer-panel-error"><CircleAlert size={14} />{error}</p></section>;
  }

  const authorization = state?.authorization;
  const statusText = state?.stopping ? tr("computerpanel.stopping_and_confirming") : control === "user" ? tr("computerpanel.you_are_in_control_ai_paused")
    : working ? tr("computerpanel.ai_is_controlling_value", { p0: mode === "host" ? tr("computerpanel.this_computer") : tr("computerpanel.the_browser") }) : (state?.lease?.running && state.lease.threadId === threadId) ? tr("computerpanel.computer_task_in_progress") : tr("computerpanel.idle");
  const canStop = Boolean(state && (working || state.lease?.running || running || control === "user"));

  return <section className={`computer-panel ${expanded ? "is-expanded" : ""}`} aria-label={tr("computerpanel.computer_use_2")}>
    <header className="computer-panel-header">
      <Monitor size={16} /><strong>{tr("computerpanel.computer_use_2")}</strong>
      <div className="computer-mode-switch" role="radiogroup" aria-label={tr("computerpanel.control_target")}>
        <button type="button" role="radio" aria-checked={mode === "browser"} className={mode === "browser" ? "active" : ""}
          disabled={!threadId || busy} onClick={() => chooseMode("browser")}><Globe size={13} />{tr("computerpanel.built_in_browser")}</button>
        <button type="button" role="radio" aria-checked={mode === "host"} className={mode === "host" ? "active host" : ""}
          disabled={!threadId || busy || state?.hostSupported === false} title={state?.hostSupported === false ? tr("computerpanel.local_computer_mode_currently_supports_windows_only") : undefined}
          onClick={() => chooseMode("host")}><Monitor size={13} />{tr("computerpanel.local_computer")}</button>
      </div>
      {mode === "browser" && <button className="icon-button" type="button" aria-label={expanded ? tr("computerpanel.collapse_browser") : tr("computerpanel.expand_browser")}
        onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize size={15} /> : <Expand size={15} />}</button>}
    </header>
    {!threadId && <p className="computer-panel-hint">{tr("computerpanel.select_or_create_a_task_to_choose_where_ai_can_operate")}</p>}
    {state?.bridgeError && <p className="computer-panel-error"><CircleAlert size={14} />{state.bridgeError}</p>}

    {authorization && <div className="computer-authorization" role="alert">
      <ShieldAlert size={16} />
      <div><strong>{tr("computerpanel.ai_requests_local_computer_access_real_mouse_and_keyboard")}</strong>
        <p>{authorization.threadId === threadId ? tr("computerpanel.current_task") : tr("computerpanel.another_task")}{tr("computerpanel.reason")}{authorization.reason}{tr("computerpanel.this_explanation_comes_from_ai_and_may_be_influenced_by_web_content_authorize_only_if")}</p>
        <div className="computer-authorization-actions">
          <button type="button" className="danger" disabled={busy} onClick={() => void act("authorize", { id: authorization.id, granted: true })}>{tr("computerpanel.authorize_local_control")}</button>
          <button type="button" disabled={busy} onClick={() => void act("authorize", { id: authorization.id, granted: false })}>{tr("approvalprompt.deny")}</button>
        </div>
      </div>
    </div>}

    {confirmHost && <div className="computer-host-confirm" role="dialog" aria-label={tr("computerpanel.authorize_local_computer_mode")}>
      <ShieldAlert size={18} />
      <strong>{tr("computerpanel.switch_to_local_computer_mode")}</strong>
      <ul>
        <li>{tr("computerpanel.ai_will_use")}<strong>{tr("computerpanel.your_real_mouse_and_keyboard")}</strong>{tr("computerpanel.to_operate_your_windows_desktop_and_open_or_switch_to_any_application_including_a_ter")}</li>
        <li>{tr("computerpanel.using_the_computer_at_the_same_time_will_interfere_with_ai_ai_pauses_when_it_detects_")}</li>
        <li>{tr("computerpanel.a_status_bar_stays_at_the_top_of_the_screen_you_can_take_over_or_stop_at_any_time_eme")}{state?.stopShortcut ?? "Control+Alt+Escape"}{tr("punctuation.period")}</li>
        <li>{tr("computerpanel.authorization_applies_only_to_this_task_it_ends_when_you_switch_to_the_built_in_brows")}</li>
      </ul>
      <div className="computer-authorization-actions">
        <button type="button" className="danger" disabled={busy} onClick={() => { setConfirmHost(false); void act("mode", { threadId, mode: "host", confirmed: true }); }}>{tr("computerpanel.authorize_and_switch")}</button>
        <button type="button" disabled={busy} onClick={() => setConfirmHost(false)}>{tr("computerpanel.cancel")}</button>
      </div>
    </div>}

    {mode === "browser" ? <>
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
        {!browser?.downloads.length ? <p>{tr("computerpanel.no_downloads_yet_files_are_saved_to")}{browser?.downloadsDir}{tr("punctuation.period")}</p> : browser.downloads.map(item => <button type="button" key={item.id}
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
        <CircleAlert size={14} /><div><strong>{tr("computerpanel.the_page_requests_a_file")}</strong><p>{tr("computerpanel.ai_can_upload_only_files_in_this_task_s_working_directory_you_can_also_choose_a_file_")}</p>
          <div className="computer-authorization-actions">
            <button type="button" onClick={() => void browserAction("pickFiles")}>{tr("computerpanel.choose_file")}</button>
            <button type="button" onClick={() => void browserAction("cancelFiles")}>{tr("computerpanel.cancel")}</button>
          </div></div>
      </div>}
      {hibernated && !browser?.tabs.length && <div className="browser-banner" role="status" data-testid="browser-hibernated">
        <MoonStar size={14} /><div><strong>{tr("computerpanel.browser_asleep")}</strong>
          <p>{tr("computerpanel.browser_asleep_detail_value", { p0: hibernated.tabs.length })}</p>
          <div className="computer-authorization-actions"><button type="button" disabled={busy} onClick={() => void browserAction("wake")}>{tr("computerpanel.reopen_pages")}</button></div></div>
      </div>}
      {(activeTab?.crashed || activeTab?.error || activeTab?.unresponsive) && <div className="browser-banner" role="status">
        <CircleAlert size={14} /><div><strong>{activeTab.crashed ? tr("computerpanel.the_page_crashed") : activeTab.unresponsive ? tr("computerpanel.the_page_is_not_responding") : tr("computerpanel.the_page_failed_to_load")}</strong>
          <p>{activeTab.crashed ? tr("computerpanel.reason_value", { p0: activeTab.crashed }) : activeTab.error?.description || ""}</p>
          <div className="computer-authorization-actions"><button type="button" onClick={() => void browserAction("reload")}>{tr("computerpanel.reload")}</button></div></div>
      </div>}
      <div className="browser-viewport" ref={viewport} data-testid="browser-viewport">
        {!browser?.tabs.length && <div className="browser-empty"><Globe size={28} /><span>{hibernated ? tr("computerpanel.browser_asleep_hint") : tr("computerpanel.enter_a_url_to_browse_ai_also_opens_pages_here_when_running_computeruse_tasks")}</span></div>}
        {modalOpen && <div className="browser-empty"><span>{tr("computerpanel.the_browser_view_is_temporarily_hidden_while_a_dialog_is_open")}</span></div>}
      </div>
      {browser?.notices[0] && Date.now() - browser.notices[0].at < 60000 && <p className="computer-panel-hint">{browser.notices[0].text}</p>}
    </> : <div className="computer-host-panel">
      <Monitor size={28} />
      <strong>{state?.threads[threadId ?? ""]?.hostAuthorized ? tr("computerpanel.ai_is_authorized_to_control_this_computer") : tr("computerpanel.local_computer_mode")}</strong>
      <p>{tr("computerpanel.ai_uses_the_real_mouse_and_keyboard_to_operate_windows_applications_a_red_status_bar_")}</p>
      <p>{tr("computerpanel.ai_does_not_control_cleo_s_own_windows_use_the_built_in_browser_for_web_tasks_to_avoi")}</p>
      <form className="computer-shortcut" onSubmit={event => { event.preventDefault(); if (shortcut.trim()) void act("shortcut", { value: shortcut.trim() }).then(() => setShortcut("")); }}>
        <label>{tr("computerpanel.emergency_stop_shortcut")}<input value={shortcut} placeholder={state?.stopShortcut ?? "Control+Alt+Escape"} onChange={event => setShortcut(event.target.value)} /></label>
        <button type="submit" disabled={busy || !shortcut.trim()}>{tr("computerpanel.save")}</button>
      </form>
      <small>{state?.shortcutError || (state?.shortcutActive ? tr("computerpanel.value_is_active_press_it_in_any_application_to_stop_immediately", { p0: state.stopShortcut }) : tr("computerpanel.the_shortcut_becomes_active_after_you_authorize_local_control"))}</small>
      <button type="button" disabled={busy} onClick={() => chooseMode("browser")}>{tr("computerpanel.revoke_access_and_switch_to_the_built_in_browser")}</button>
    </div>}

    <div className="computer-control-bar">
      <span><i className={working ? "is-running" : control === "user" ? "is-user" : ""} />{statusText}</span>
      <div>
        <button type="button" disabled={busy || !state} onClick={() => void act(control === "user" ? "handback" : "takeover", { target, threadId })}>
          {control === "user" ? <Play size={13} /> : <Hand size={13} />}{control === "user" ? tr("computerpanel.return_control_to_ai") : tr("computerpanel.take_over")}</button>
        <button type="button" className="stop" disabled={busy || !canStop || state?.stopping} onClick={() => void stop()}><Square size={12} />{tr("computerpanel.stop")}</button>
      </div>
    </div>
    {control === "user" && <p className="computer-panel-hint">{tr("computerpanel.ai_is_paused_and_pending_actions_have_been_cancelled_on_resuming_ai_takes_a_new_scree")}</p>}
    {state?.lastStop && Date.now() - state.lastStop.at < 30000 && <p className="computer-panel-hint">
      {state.lastStop.settled ? tr("computerpanel.stopped_value", { p0: state.lastStop.cancelledRun ? tr("computerpanel.task") : tr("computerpanel.computer_use_2") }) : tr("computerpanel.stopping_computer_use_awaiting_confirmation")}{state.lastStop.released.length ? tr("computerpanel.released_value_keys_or_buttons", { p0: state.lastStop.released.length }) : ""}{state.lastStop.hostError ? `；${state.lastStop.hostError}` : ""}{tr("punctuation.period")}</p>}
    {error && <p className="computer-panel-error" role="status"><CircleAlert size={14} />{error}</p>}
    <div className="computer-steps"><h3>{tr("computerpanel.recent_computer_actions")}</h3>
      {!steps.length && <p>{tr("computerpanel.enter_computeruse_followed_by_your_task_ai_uses_the_target_selected_here")}</p>}
      {steps.map(step => <article key={step.id} className={`computer-step ${step.status}`}>
        <i /><div><strong>{operationLabel(step)}</strong></div>
        <small>{step.status === "error" ? tr("computerpanel.not_completed") : step.status === "running" ? control === "user" ? tr("computerpanel.waiting_for_control") : tr("computerpanel.in_progress") : tr("computerpanel.returned")}</small>
      </article>)}
    </div>
  </section>;
}
