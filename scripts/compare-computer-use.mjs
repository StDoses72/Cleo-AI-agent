/** Run one real /computeruse desktop task against one Cleo code version and time it.
 *
 * Plays the part of Cleo's Electron main process: starts that version's Python backend over
 * JSON lines, serves that version's computer broker on a real bridge (the real local-computer
 * controller underneath), sends the task to the real model, approves the desktop request the way
 * a user click would, and records every tool call.
 *
 * node scripts/compare-computer-use.mjs <code root> <python> <work dir> <label> <out.json>
 *
 * <code root> is a checkout of the version to measure; <python> must import that checkout's
 * ``cleo`` (for an older version, a worktree with its own venv). DRY_TASK replaces the task, e.g.
 * with a built-in-browser task to check the setup without touching the desktop. The default task
 * sends REAL mouse and keyboard input: run it only on an idle desktop, with no Notepad window of
 * your own open. Results and the method are in docs/benchmark-computer-use.md.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

const [root, python, work, label, out] = process.argv.slice(2);
const load = path => import(pathToFileURL(join(root, "ui", "electron", "computer", path)).href);
const { ComputerBridge } = await load("bridge.mjs");
const { ComputerBroker } = await load("broker.mjs");
const { HostClient } = await load("index.mjs");

const TASK = process.env.DRY_TASK || "/computeruse 在本机电脑上打开记事本，输入两行文字：第一行“会议记录”，第二行“三种电脑操作模式按 #160 推进”。输入完成后关闭记事本，弹出保存提示时选择不保存。";
const WAIT_TOOLS = new Set(["desktop_wait", "browser_wait", "user_browser_wait"]);

/** A blank 800x600 PNG for a built-in browser screenshot, should the model take one. */
function blankPng(width = 800, height = 600) {
  const crc = buffer => { let c = ~0; for (const byte of buffer) { c ^= byte; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.alloc(1 + width * 3, 255); row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** The built-in browser is not part of this task; a minimal stand-in keeps its tools answering. */
function fakeBrowsers() {
  const view = { activeId: "t1", geometry: 1, size: { width: 800, height: 600 }, notices: [],
    ensureTab() { return { id: "t1", wc: { getZoomFactor: () => 1 } }; }, requireTab() { return this.ensureTab(); },
    touch() {}, async capture() { return { png: blankPng(), width: 800, height: 600 }; },
    tabState() { return { id: "t1", title: "", url: "about:blank", loading: false, zoom: 1, dialog: null, fileChooser: null, crashed: null, error: null }; },
    state() { return { tabs: [{ id: "t1", title: "", url: "about:blank" }], activeTabId: "t1" }; }, async releaseAll() { return []; } };
  return { on() {}, foregroundId: null, forThread: () => view, state: () => ({ tabs: [] }), async releaseAll() { return []; }, setAgentOverlay() {} };
}

class Backend {
  constructor(env) {
    this.process = spawn(python, ["-m", "cleo.desktop.server"], { cwd: root, env, stdio: ["pipe", "pipe", "ignore"] });
    this.waiters = new Map();
    this.next = 1;
    let buffer = "";
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        const waiter = this.waiters.get(message.id);
        if (!waiter) continue;
        if (message.type === "event") { waiter.events.push({ at: Date.now(), event: message.event }); continue; }
        this.waiters.delete(message.id);
        if (message.type === "error") waiter.reject(new Error(JSON.stringify(message.error).slice(0, 500)));
        else waiter.resolve({ result: message.result, events: waiter.events });
      }
    });
  }
  request(method, params = {}) {
    const id = `d${this.next++}`;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject, events: [] });
      this.process.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    }).then(value => (method.startsWith("computer_") || method === "cancel_run" ? value.result : value));
  }
  async close() { await this.request("shutdown").catch(() => {}); setTimeout(() => this.process.kill(), 5000).unref(); }
}

const home = mkdtempSync(join(tmpdir(), `cleo-cmp-${label}-`));
mkdirSync(work, { recursive: true });
writeFileSync(join(home, "cleo.json"), JSON.stringify({ active_profiles: { agent: "default" }, profiles: {
  agents: { default: { provider: "openai", model: "test", api_key: "test" } }, directories: { default: { root_dir: work } } } }));
writeFileSync(join(home, "harnesses.json"), JSON.stringify({ default_provider: "codex", providers: {
  codex: { type: "codex_sdk", model: "gpt-5.6-sol", options: { approval_mode: "deny_all", sandbox: "read-only" } } } }));

let backend = null;
const backendProxy = { request: (method, params) => backend.request(method, params) };
const broker = new ComputerBroker({ browser: fakeBrowsers(), host: new HostClient(backendProxy), backend: backendProxy, platform: "win32" });
const calls = [];
const approvals = [];
broker.on("authorization-requested", request => {
  approvals.push({ at: Date.now(), reason: request.reason });
  setTimeout(() => void broker.answerAuthorization(request.id, true), 400);
});
const bridgeDir = mkdtempSync(join(tmpdir(), "cleo-cmp-bridge-"));
const bridge = new ComputerBridge({ directory: bridgeDir, protect: () => {}, handler: async (request, signal) => {
  const identity = request?.identity && typeof request.identity === "object" ? request.identity : {};
  if (request?.op === "tools") { calls.push({ name: "computer_tools", start: Date.now(), end: Date.now(), ok: true }); return broker.catalog(identity); }
  const record = { name: request.name, args: request.arguments, start: Date.now() };
  calls.push(record);
  try {
    const result = await broker.call(identity, request.name, request.arguments ?? {}, signal);
    record.ok = true;
    record.note = result?.find?.(block => block.type === "text")?.text?.slice(0, 200);
    return result;
  } catch (error) {
    record.ok = false;
    record.error = String(error.message).slice(0, 200);
    throw error;
  } finally { record.end = Date.now(); }
} });
const descriptor = await bridge.start();
backend = new Backend({ ...process.env, CLEO_HOME: home, CLEO_CONFIG_PATH: join(home, "cleo.json"), CLEO_HARNESSES_CONFIG_PATH: join(home, "harnesses.json"),
  CLEO_COMPUTER_BRIDGE: descriptor, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" });

await backend.request("load_workspace");
const created = await backend.request("create_thread", { space: "productivity", project_id_value: "productivity:workspace", project_path: work, provider: "codex", model: "gpt-5.6-sol" });
const threadId = created.result.id;
broker.turnStarted(threadId);
const sent = Date.now();
let turn, turnError = null;
try { turn = await backend.request("stream_turn", { thread_id: threadId, prompt: TASK, attachments: [] }); }
catch (error) { turnError = error.message; }
const finished = Date.now();
broker.turnEnded(threadId);

// The window list after the turn tells whether Notepad was left open.
const after = await backend.request("computer_host", { op: "screenshot", arguments: { display: null } }).catch(() => null);
const notepadOpen = Boolean(after?.windows?.some(window => /记事本|Notepad/i.test(window.title)));
const events = turn?.events ?? [];
const text = JSON.stringify(events.map(item => item.event));
const answer = (text.match(/"role":"assistant"[^}]*?"content":"([^"]{0,400})/) || [])[1] || "";

const actions = calls.filter(call => call.name !== "computer_tools");
const first = calls[0]?.start ?? finished;
const last = calls.at(-1)?.end ?? finished;
const tool = actions.filter(call => !WAIT_TOOLS.has(call.name)).reduce((sum, call) => sum + (call.end - call.start), 0);
const wait = actions.filter(call => WAIT_TOOLS.has(call.name)).reduce((sum, call) => sum + (call.end - call.start), 0);
const approvalWait = approvals.length * 400;
const summary = {
  label, root, turn_seconds: (finished - sent) / 1000, before_first_tool_seconds: (first - sent) / 1000,
  computer_seconds: (last - first) / 1000, tool_seconds: tool / 1000, wait_seconds: wait / 1000,
  think_seconds: Math.max(0, last - first - tool - wait - approvalWait) / 1000,
  calls: actions.length, screenshots: actions.filter(call => /screenshot/.test(call.name)).length,
  errors: actions.filter(call => !call.ok).length, approvals: approvals.length,
  launch: actions.filter(call => call.name === "desktop_app").map(call => ({ seconds: (call.end - call.start) / 1000, note: call.note })),
  notepad_left_open: notepadOpen, turn_error: turnError, answer,
  sequence: actions.map(call => `${call.name}${call.ok ? "" : "!"} ${((call.end - call.start) / 1000).toFixed(1)}s`),
};
writeFileSync(out, JSON.stringify({ summary, calls, events: events.slice(-40) }, null, 1));
console.log(JSON.stringify(summary));
await backend.close();
await bridge.close();
process.exit(0);
