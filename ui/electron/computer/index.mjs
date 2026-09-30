/** Wires Cleo's computer use into Electron: built-in browser, host control, bridge, files. */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CleoBrowser } from "./browser.mjs";
import { ComputerBridge } from "./bridge.mjs";
import { ComputerBroker } from "./broker.mjs";
import { FILE_SCHEME, WorkspaceFiles } from "./files.mjs";
import { HostControls } from "./host-ui.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export { registerComputerSchemes } from "./schemes.mjs";

/** Forwards host-desktop operations to the Python backend, which owns SendInput. */
export class HostClient {
  constructor(backend) { this.backend = backend; }

  async call(op, args, signal) {
    signal?.throwIfAborted();
    const cancel = () => { void this.backend.request("computer_host_stop", { reason: "cancel" }).catch(() => {}); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await this.backend.request("computer_host", { op, arguments: args });
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  stop({ reason = "stop" } = {}) {
    return this.backend.request("computer_host_stop", { reason });
  }
}

export class ComputerUse {
  constructor({ electron, app, backend }) {
    this.electron = electron;
    this.app = app;
    this.backend = backend;
    this.files = new WorkspaceFiles();
    this.browser = new CleoBrowser({
      electron,
      downloadsDir: join(app.getPath("downloads"), "Cleo"),
      overlay: { html: join(here, "agent-overlay.html"), preload: join(here, "overlay-preload.cjs") },
    });
    this.broker = new ComputerBroker({ browser: this.browser, host: new HostClient(backend), backend, platform: process.platform });
    this.controls = new HostControls({ electron, broker: this.broker,
      preferencesPath: join(app.getPath("userData"), "computer-use-ui.json"),
      files: { preload: join(here, "overlay-preload.cjs"), statusHtml: join(here, "host-status.html") } });
    this.bridge = new ComputerBridge({ directory: join(app.getPath("userData"), "computer-bridge"),
      handler: (request, signal) => this.dispatch(request, signal) });
    this.windows = new Set();
    this.pushTimer = null;
    this.bridgeError = "";
    this.broker.on("state", () => this.push());
    this.browser.on("state", () => this.push());
    this.browser.on("user-input", ({ tab, event, input }) => this.userInput(tab, event, input));
    this.browser.on("file-chooser", () => this.push());
  }

  /** Purpose: Start the bridge before the backend so tool processes can find it. */
  async start() {
    const { session } = this.electron;
    const handler = request => this.files.respond(request);
    this.browser.session().protocol.handle(FILE_SCHEME, handler);
    if (!await session.defaultSession.protocol.isProtocolHandled(FILE_SCHEME)) {
      session.defaultSession.protocol.handle(FILE_SCHEME, handler);
    }
    try {
      process.env.CLEO_COMPUTER_BRIDGE = await this.bridge.start();
    } catch (error) {
      this.bridgeError = `电脑操作通道未能启动：${error.message}`;
      delete process.env.CLEO_COMPUTER_BRIDGE;
    }
  }

  async dispatch(request, signal) {
    const identity = request?.identity && typeof request.identity === "object" ? request.identity : {};
    if (request?.op === "tools") return this.broker.catalog(identity);
    if (request?.op === "call") return this.broker.call(identity, request.name, request.arguments ?? {}, signal);
    throw new Error("未知的电脑操作请求。");
  }

  attachWindow(window) {
    this.windows.add(window);
    window.once("closed", () => this.windows.delete(window));
    this.browser.attachWindow(window);
  }

  state() {
    return { ...this.broker.state(), ...this.controls.status(), bridgeError: this.bridgeError };
  }

  push() {
    this.controls.update();
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      const state = this.state();
      for (const window of this.windows) {
        if (!window.isDestroyed()) window.webContents.send("cleo:computer:state", state);
      }
    }, 60);
  }

  /** Real keyboard input into the page while the AI operates it counts as taking over. */
  userInput(tab, _event, input) {
    if (input.type !== "keyDown" || !this.broker.browserEngaged()) return;
    if (tab.id !== this.browser.activeId) return;
    void this.broker.takeover("browser", "keyboard");
  }

  /** Purpose: Convert renderer CSS pixels to window DIPs and place the browser. */
  setViewport(window, rect) {
    if (!rect) { this.browser.setViewport(null); return; }
    const zoom = window.webContents.getZoomFactor() || 1;
    const values = ["x", "y", "width", "height"].map(key => Number(rect[key]));
    if (values.some(value => !Number.isFinite(value))) throw new Error("浏览器区域无效。");
    const [x, y, width, height] = values.map(value => value * zoom);
    this.browser.setViewport({ x, y, width, height });
  }

  async browserAction(window, params = {}) {
    const { action } = params;
    const tab = () => this.browser.requireTab(params.tabId || this.browser.activeId);
    // A user steering the shared browser takes control away from the AI first.
    const userAction = !["openDownloads", "pickFiles", "cancelFiles", "dialog"].includes(action);
    if (userAction && this.broker.browserEngaged()) await this.broker.takeover("browser", "chrome");
    const actions = {
      navigate: () => this.browser.navigate((params.tabId ? tab() : this.browser.ensureTab()).id, params.url),
      back: () => this.browser.history(tab().id, "back"),
      forward: () => this.browser.history(tab().id, "forward"),
      reload: () => this.browser.history(tab().id, "reload"),
      stop: () => this.browser.history(tab().id, "stop"),
      newTab: () => { const created = this.browser.createTab({ activate: true }); return params.url ? this.browser.navigate(created.id, params.url) : null; },
      activate: () => this.browser.activate(params.tabId),
      close: () => this.browser.close(params.tabId),
      zoomIn: () => this.browser.setZoom(tab().id, tab().wc.getZoomFactor() + 0.1),
      zoomOut: () => this.browser.setZoom(tab().id, tab().wc.getZoomFactor() - 0.1),
      zoomReset: () => this.browser.setZoom(tab().id, 1),
      dialog: () => this.browser.handleDialog(tab().id, params.accept === true, typeof params.text === "string" ? params.text : ""),
      cancelFiles: () => this.browser.cancelFileChooser(tab().id),
      pickFiles: async () => {
        const current = tab();
        if (!current.fileChooser) throw new Error("网页当前没有等待中的文件选择框。");
        const result = await this.electron.dialog.showOpenDialog(window, { title: "选择要上传到网页的文件",
          properties: current.fileChooser.mode === "selectMultiple" ? ["openFile", "multiSelections"] : ["openFile"] });
        if (result.canceled || !result.filePaths.length) return null;
        return this.browser.setFiles(current.id, result.filePaths);
      },
      openDownloads: () => {
        const item = this.browser.downloads.find(download => download.id === params.downloadId);
        if (item) this.electron.shell.showItemInFolder(item.path);
        else this.electron.shell.openPath(this.browser.downloadsDir);
      },
    };
    if (!Object.hasOwn(actions, action)) throw new Error("未知的浏览器操作。");
    await actions[action]();
    return this.state();
  }

  /** Purpose: Serve Cleo's own UI. Input: validated IPC from the main window. Output: state. */
  async handle(window, action, params = {}) {
    if (action === "state") return this.state();
    if (action === "viewport") { this.setViewport(window, params.rect || null); return null; }
    if (action === "browser") return this.browserAction(window, params);
    if (action === "mode") { await this.broker.setMode(String(params.threadId || ""), params.mode, { confirmed: params.confirmed === true }); return this.state(); }
    if (action === "authorize") { await this.broker.answerAuthorization(String(params.id || ""), params.granted === true); return this.state(); }
    if (action === "takeover") { await this.broker.takeover(params.target); return this.state(); }
    if (action === "handback") { await this.broker.handback(params.target); return this.state(); }
    if (action === "stop") return { ...this.state(), stopResult: await this.broker.stop({ source: "panel" }) };
    if (action === "shortcut") { this.controls.setShortcut(String(params.value || "")); return this.state(); }
    if (action === "preview") {
      const file = await this.files.read(String(params.root || ""), String(params.path || ""));
      if (!["html", "pdf", "image", "text", "markdown"].includes(file.kind)) throw new Error("该文件不能在内置浏览器中预览。");
      if (this.broker.browserEngaged()) await this.broker.takeover("browser", "preview");
      const tab = this.browser.createTab({ activate: true });
      await this.browser.navigate(tab.id, file.url);
      return this.state();
    }
    throw new Error("未知的电脑面板操作。");
  }

  handleFiles(op, params = {}) {
    const root = String(params.root || "");
    if (op === "list") return this.files.list(root, String(params.path || ""));
    if (op === "read") return this.files.read(root, String(params.path || ""));
    if (op === "locate") return this.files.locate(root, String(params.href || ""));
    throw new Error("未知的文件操作。");
  }

  /** Clicks from the overlay page or the always-on-top host status bar. */
  overlay(sender, action) {
    const fromOverlay = this.browser.isOverlay(sender);
    const fromStatus = this.controls.isStatusWindow(sender);
    if (!fromOverlay && !fromStatus) return;
    if (action === "takeover-browser" && fromOverlay) void this.broker.takeover("browser", "overlay");
    else if (action === "takeover-desktop" && fromStatus) void this.broker.takeover("desktop", "status-bar");
    else if (action === "handback-desktop" && fromStatus) void this.broker.handback("desktop");
    else if (action === "stop" && fromStatus) void this.broker.stop({ source: "status-bar" });
  }

  async close() {
    clearTimeout(this.pushTimer);
    await this.broker.close().catch(() => {});
    this.controls.close();
    await this.bridge.close().catch(() => {});
    await this.browser.shutdown().catch(() => {});
  }
}
