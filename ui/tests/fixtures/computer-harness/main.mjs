/** Test harness: Cleo's real computer-use modules in Electron with a scripted UI and backend.
 *
 * Commands arrive as JSON lines on a loopback test socket (Electron's main process does not read
 * piped stdin on Windows); the port and a random token are printed on stdout. The harness never
 * controls the host desktop: host operations are rejected by its fake backend.
 */

import { app, BrowserWindow, WebContentsView, dialog, globalShortcut, nativeImage, protocol, screen, session, shell } from "electron";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { ComputerUse, registerComputerSchemes } from "../../../electron/computer/index.mjs";

registerComputerSchemes(protocol);
if (process.env.CLEO_HARNESS_USER_DATA) app.setPath("userData", process.env.CLEO_HARNESS_USER_DATA);
if (process.env.CLEO_HARNESS_DOWNLOADS) app.setPath("downloads", process.env.CLEO_HARNESS_DOWNLOADS);

const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const owners = new Map();
const calls = [];
const backend = {
  async request(method, params = {}) {
    calls.push({ method, params });
    if (method === "computer_owner") return owners.get(params.client_key) ?? null;
    if (method === "computer_scope") return { cwd: process.env.CLEO_HARNESS_WORKSPACE || "" };
    if (method === "cancel_run") return null;
    if (method === "computer_host_stop") return { stopped: true, released: [] };
    if (method === "computer_host") throw new Error("测试环境不操作本机桌面。");
    throw new Error(`unexpected backend method ${method}`);
  },
};

app.whenReady().then(async () => {
  const computer = new ComputerUse({ app, backend,
    electron: { BrowserWindow, WebContentsView, dialog, globalShortcut, nativeImage, screen, session, shell } });
  // Tests never show the host status bar or register a global shortcut on the user's desktop.
  computer.controls.update = () => {};
  await computer.start();
  const window = new BrowserWindow({ width: 1100, height: 820, x: 60, y: 60, show: false, title: "Cleo computer harness",
    webPreferences: { sandbox: true, contextIsolation: true } });
  computer.attachWindow(window);
  await window.loadURL("data:text/html,<body style='margin:0;background:%23222'></body>");
  if (process.env.CLEO_HARNESS_SHOW !== "0") window.showInactive();
  computer.browser.setViewport({ x: 20, y: 60, width: 900, height: 640 });
  computer.broker.on("takeover", event => write({ event: "takeover", ...event }));

  const commands = {
    state: () => computer.state(),
    owner: ({ key, thread }) => { owners.set(key, thread); return true; },
    turn: ({ thread, running }) => { if (running) computer.broker.turnStarted(thread, "run"); else computer.broker.turnEnded(thread); return true; },
    takeover: ({ target = "browser" }) => computer.broker.takeover(target).then(() => true),
    handback: ({ target = "browser" }) => computer.broker.handback(target).then(() => true),
    stop: () => computer.broker.stop({ source: "test" }),
    mode: ({ thread, mode, confirmed }) => computer.broker.setMode(thread, mode, { confirmed }).then(() => true),
    authorize: ({ granted }) => computer.broker.answerAuthorization(computer.broker.authorization?.id, granted).then(() => true),
    viewport: ({ rect }) => { computer.browser.setViewport(rect); return true; },
    zoom: ({ factor }) => computer.browser.setZoom(computer.browser.activeId, factor),
    userNavigate: ({ url }) => computer.browserAction(window, { action: "navigate", url }).then(() => true),
    minimize: () => { window.minimize(); return true; },
    restore: () => { window.restore(); window.showInactive(); return true; },
    eval: async ({ script }) => computer.browser.activeTab().wc.executeJavaScript(script),
    uiEval: async ({ script }) => window.webContents.executeJavaScript(script),
    preview: ({ root, path }) => computer.handle(window, "preview", { root, path }).then(() => true),
    fileUrl: ({ root, path }) => computer.files.read(root, path).then(file => file.url),
    focused: () => ({ windowFocused: window.isFocused(), anyFocused: BrowserWindow.getFocusedWindow() !== null }),
    calls: () => calls.splice(0),
    quit: async () => { await computer.close(); setTimeout(() => app.exit(0), 50); return true; },
  };
  const token = randomBytes(16).toString("hex");
  const control = createServer(socket => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void (async () => {
          let request;
          try { request = JSON.parse(line); } catch { return; }
          const reply = message => { if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`); };
          if (request.token !== token) { reply({ id: request.id, ok: false, error: "bad token" }); return; }
          try {
            const handler = commands[request.cmd];
            if (!handler) throw new Error(`unknown command ${request.cmd}`);
            reply({ id: request.id, ok: true, result: await handler(request) });
          } catch (error) {
            reply({ id: request.id, ok: false, error: error.message });
          }
        })();
      }
    });
  }).listen(0, "127.0.0.1", () => {
    write({ event: "ready", descriptor: process.env.CLEO_COMPUTER_BRIDGE, pid: process.pid, port: control.address().port, token });
  });
});
app.on("window-all-closed", () => {});
