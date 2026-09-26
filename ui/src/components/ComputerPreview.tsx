import { useEffect, useRef, useState } from "react";
import { CircleAlert, Expand, Hand, Minimize, Monitor, Pause, Play, Square } from "lucide-react";
import RFBModule from "@novnc/novnc/lib/rfb.js";
import type { Thread, TimelineItem } from "../types";
import "./computer-preview.css";

// noVNC is published as CommonJS; development and production expose its default differently.
const RFB = "default" in RFBModule ? RFBModule.default : RFBModule;

export interface DesktopState {
  phase: "ready" | "starting" | "stopped" | "external";
  runtime?: "isolated" | "host" | "custom";
  hostSupported?: boolean;
  canSwitch?: boolean;
  mode?: "agent" | "user";
  viewerUrl?: string;
  width?: number;
  height?: number;
  detail?: string;
}

export function isComputerTool(item: TimelineItem): item is Extract<TimelineItem, { type: "tool" }> {
  return item.type === "tool" && /(?:^|__)computer_(?:tools|call)$/.test(item.name);
}

/** Render operation names from either JSON or older Python-style timeline input. */
function operationLabel(step: Extract<TimelineItem, { type: "tool" }>) {
  if (step.name.endsWith("computer_tools")) return "读取可用操作";
  const name = /["']name["']\s*:\s*["']([^"']+)["']/.exec(step.command)?.[1] ?? "";
  const labels: Record<string, string> = { Snapshot: "查看桌面", Click: "点击界面", Type: "输入文字",
    Scroll: "滚动页面", Shortcut: "按下快捷键", Move: "移动鼠标", Drag: "拖动界面",
    App: "打开或切换应用", Clipboard: "使用剪贴板", WaitFor: "等待界面变化",
    Window: "调整窗口", Shell: "执行电脑命令", FileSystem: "操作文件" };
  return labels[name] || "操作电脑";
}

/** Purpose: Select a desktop target. Input: task/stop action. Output: guest viewer or host guidance. */
export function ComputerPreview({ thread, running, onStop }: {
  thread: Thread | null; running: boolean; onStop: () => void;
}) {
  const [state, setState] = useState<DesktopState>({ phase: "stopped" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [connected, setConnected] = useState(false);
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");
  const screen = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const changeVersion = useRef(0);
  const manual = state.mode === "user";
  const isolated = state.runtime ? state.runtime === "isolated" : state.phase !== "external";
  const custom = state.runtime === "custom";
  const steps = (thread?.items ?? []).filter(isComputerTool).slice(-6).reverse();

  useEffect(() => {
    mounted.current = true;
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => { mounted.current = false; document.removeEventListener("visibilitychange", update); };
  }, []);

  useEffect(() => {
    if (!visible) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = changeVersion.current;
      try {
        if (!window.cleoDesktop?.computerDesktop) throw new Error("请在新版 Cleo 桌面应用中打开独立桌面。");
        const result = await window.cleoDesktop.computerDesktop();
        if (!stopped && version === changeVersion.current) { setState(result); setLoaded(true); }
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : "无法连接独立桌面。");
      } finally {
        if (!stopped) timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [visible]);

  useEffect(() => {
    if (!screen.current || !state.viewerUrl || paused || !visible) return;
    let stopped = false;
    const host = document.createElement("div");
    host.style.cssText = "width:100%;height:100%";
    screen.current.append(host);
    const client = new RFB(host, state.viewerUrl);
    client.scaleViewport = true;
    client.resizeSession = false;
    client.viewOnly = !manual;
    client.qualityLevel = 7;
    client.compressionLevel = 2;
    const connect = () => { if (!stopped) { host.dataset.connected = "true"; setConnected(true); setError(""); } };
    const disconnect = () => {
      if (!stopped) { setConnected(false); setError("桌面连接已中断，可点击重新连接。"); }
    };
    client.addEventListener("connect", connect);
    client.addEventListener("disconnect", disconnect);
    return () => { stopped = true; client.disconnect(); host.remove(); setConnected(false); };
  }, [state.viewerUrl, paused, visible, manual, retry]);

  /** Purpose: Transfer ownership through the guest lock. Input: UI action. Output: fresh state. */
  const act = async (action: "start" | "take" | "release" | "stop" | "text" | "select", runtime = "") => {
    if (!window.cleoDesktop?.computerDesktop || busy) return;
    changeVersion.current++;
    setBusy(true); setError("");
    try {
      const result = await window.cleoDesktop.computerDesktop(action, action === "text" ? text : runtime);
      if (mounted.current) {
        setState(result);
        if (action === "text" || action === "select") setText("");
        if (action === "select") { setExpanded(false); setPaused(false); }
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "操作未完成。");
    } finally {
      changeVersion.current++;
      if (mounted.current) setBusy(false);
    }
  };

  return <section className={`computer-preview ${expanded ? "is-expanded" : ""}`} aria-label="电脑操作">
    <div className="computer-preview-toolbar">
      <Monitor size={16} /><strong>电脑操作</strong><span className="computer-desktop-kind">{isolated ? "Docker" : custom ? "自定义" : "Windows"}</span>
      {isolated && <><button className="icon-button" type="button" aria-label={expanded ? "收起桌面" : "放大桌面"}
        onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize size={15} /> : <Expand size={15} />}</button>
      <button className="icon-button" type="button" aria-label={paused ? "继续观看" : "暂停观看"}
        onClick={() => setPaused(value => !value)}>{paused ? <Play size={15} /> : <Pause size={15} />}</button></>}
    </div>
    <label className="computer-runtime-choice">操作环境
      <select aria-label="电脑操作环境" value={state.runtime ?? (isolated ? "isolated" : "custom")}
        disabled={!loaded || busy || running || state.canSwitch === false || custom}
        onChange={event => void act("select", event.target.value)}>
        <option value="isolated">独立桌面 · Docker</option>
        <option value="host" disabled={state.hostSupported === false}>本机桌面 · Windows</option>
        {custom && <option value="custom">自定义电脑工具</option>}
      </select>
    </label>
    <p className="computer-preview-hint">此选择用于所有会话的电脑操作。</p>
    {(running || state.canSwitch === false) && <p className="computer-preview-hint">任务结束后可切换操作环境。</p>}
    {isolated ? <><div className="computer-remote-screen">
      <div ref={screen} className="computer-vnc" data-testid="remote-desktop" />
      {(!connected || paused) && <div className="computer-preview-placeholder">
        <Monitor size={32} />
        <span>{paused ? "观看已暂停" : busy || state.phase === "starting" ? "正在准备独立桌面…" : state.phase === "ready" ? "正在连接桌面…" : "浏览器和软件将在这里运行"}</span>
        {state.phase === "stopped" && !busy && <button type="button" onClick={() => void act("start")}>打开独立桌面</button>}
      </div>}
      {connected && !manual && !paused && <button className="computer-take-overlay" type="button"
        aria-label="点击桌面接管" disabled={busy} onClick={() => void act("take")}><span><Hand size={14} />点击接管</span></button>}
    </div>
    <div className="computer-control-bar">
      <span><i className={connected ? "is-running" : ""} />{manual ? "你正在操作 · AI 已暂停" : running ? "Cleo 正在操作" : "等待任务"}</span>
      {state.phase === "ready" && <button type="button" disabled={busy} onClick={() => void act(manual ? "release" : "take")}>
        {manual ? <Play size={13} /> : <Hand size={13} />}{manual ? "交回控制" : "接管"}</button>}
    </div>
    <p className="computer-preview-hint">{manual
      ? "直接点击画面并输入，可登录账号。完成后交回控制，Cleo 会继续。点击聊天区域即可继续使用 Cleo。"
      : "这是专供任务使用的桌面。需要登录或手动操作时，点击画面接管。"}</p>
    {manual && <form className="computer-text-entry" onSubmit={event => { event.preventDefault(); void act("text"); }}>
      <input aria-label="发送到桌面的文字" type="password" autoComplete="off" value={text}
        onChange={event => setText(event.target.value)} placeholder="中文或需要粘贴的文字" />
      <button type="submit" disabled={busy || !text}>输入</button>
    </form>}</> : <div className="computer-host-desktop">
      <Monitor size={32} /><strong>{custom ? "使用自定义电脑工具" : "直接操作你的电脑"}</strong>
      <p>{custom ? "操作过程在对应环境中进行。" : "Cleo 会使用真实鼠标和键盘，打开浏览器、切换窗口或操作其他应用。你可以最小化 Cleo，直接在桌面查看过程。"}</p>
      {!custom && <p>需要登录时，在原应用里完成输入，再回到聊天告诉 Cleo 继续。停止按钮仍在聊天和此面板中。</p>}
    </div>}
    {error && <p className="computer-preview-error" role="status"><CircleAlert size={14} />{error}
      <button type="button" onClick={() => { setError(""); setRetry(value => value + 1); }}>重新连接</button></p>}
    {state.detail && <p className={isolated ? "computer-preview-error" : "computer-preview-hint"}>{state.detail}</p>}
    <div className="computer-preview-task">
      <span>{thread?.waitingFor === "approval" ? "等待你的确认" : thread?.waitingFor === "question" ? "等待你的回答" : "当前任务"}</span>
      {running ? <button type="button" onClick={onStop}><Square size={12} />停止任务</button>
        : state.phase === "ready" && <button type="button" disabled={busy} onClick={() => void act("stop")}>关闭桌面</button>}
    </div>
    <div className="computer-preview-steps"><h3>最近的电脑操作</h3>
      {!steps.length && <p>输入 /computeruse 和任务内容，Cleo 会使用这个桌面。</p>}
      {steps.map(step => <article key={step.id} className={`computer-step ${step.status}`}>
        <i /><div><strong>{operationLabel(step)}</strong></div>
        <small>{step.status === "error" ? "未完成" : step.status === "running" ? manual ? "等待交回" : "进行中" : "已返回"}</small>
      </article>)}
    </div>
  </section>;
}
