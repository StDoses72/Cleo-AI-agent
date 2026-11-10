const { contextBridge, ipcRenderer, webUtils } = require("electron");

let uiLanguage = process.argv.includes("--cleo-ui-language=en") ? "en" : "zh-CN";
ipcRenderer.on("cleo:language-changed", (_event, language) => { uiLanguage = language; });
// Local evolution was removed (docs/adr/0009-remove-local-evolution.md). The renderer still calls these
// bridge methods until its own cleanup lands; each reports the feature as unavailable without reaching
// the main process.
const evolutionUnavailable = () => uiLanguage === "en"
  ? "Local evolution is no longer part of Cleo."
  : "Cleo 已不再提供本地进化。";
const inertEvolutionState = () => ({
  supported: false, phase: "idle", prepared: false, currentVersion: "", active: null, baseline: null, baseTag: null,
  source: null, threadId: null, error: null, logs: "", builds: [], pullRequest: null, releases: [], recoveryPath: null,
});
const memoryListeners = new Set();
let pendingOpenMemory = false;
ipcRenderer.on("cleo:open-memory", () => {
  if (!memoryListeners.size) pendingOpenMemory = true;
  for (const listener of memoryListeners) listener();
});

contextBridge.exposeInMainWorld("cleoWindow", {
  language: process.argv.includes("--cleo-ui-language=en") ? "en" : "zh-CN",
  onLanguageChanged: (listener) => {
    const handler = (_event, language) => listener(language);
    ipcRenderer.on("cleo:language-changed", handler);
    return () => ipcRenderer.removeListener("cleo:language-changed", handler);
  },
  platform: process.platform,
  setTheme: (theme) => ipcRenderer.send("cleo:window-theme", theme),
  setBadge: (count, overlay) => ipcRenderer.send("cleo:window-badge", { count, overlay }),
  onOpenMemory: (listener) => {
    memoryListeners.add(listener);
    if (pendingOpenMemory) { pendingOpenMemory = false; listener(); }
    return () => { memoryListeners.delete(listener); };
  },
});

if (!process.argv.includes("--cleo-desktop-mock")) {
  contextBridge.exposeInMainWorld("cleoDesktop", {
    getUiLanguage: () => ipcRenderer.invoke("cleo:request", { method: "get_ui_language", params: {} }),
    onCompanionThread: () => () => {},
    setup: (action, params = {}) => ipcRenderer.invoke("cleo:setup", action, params),
    computer: (action = "state", params = {}) => ipcRenderer.invoke("cleo:computer", action, params),
    onComputerState: (listener) => {
      const handler = (_event, state) => listener(state);
      ipcRenderer.on("cleo:computer:state", handler);
      return () => ipcRenderer.removeListener("cleo:computer:state", handler);
    },
    files: (op, params = {}) => ipcRenderer.invoke("cleo:files", op, params),
    git: (op, params = {}) => ipcRenderer.invoke("cleo:git", op, params),
    request: (method, params = {}, streamId = null) =>
      ipcRenderer.invoke("cleo:request", { method, params, streamId }),
    onStreamEvent: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on("cleo:stream-event", handler);
      return () => ipcRenderer.removeListener("cleo:stream-event", handler);
    },
    pickAttachments: () => ipcRenderer.invoke("cleo:pick-attachments"),
    prepareAttachments: async (files) => {
      const paths = [];
      const inline = [];
      for (const file of Array.from(files || [])) {
        let path = "";
        try {
          path = webUtils.getPathForFile(file);
        } catch {
          // In-memory clipboard files do not have an operating-system path.
        }
        if (path) {
          paths.push(path);
          continue;
        }
        inline.push({
          name: file.name,
          mimeType: file.type,
          // Electron 45 dropped the Buffer global from sandboxed preloads; ship raw bytes and let main encode them.
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
      }
      return ipcRenderer.invoke("cleo:prepare-attachments", { paths, inline });
    },
    pickWorkspace: () => ipcRenderer.invoke("cleo:pick-workspace"),
    copyText: (value) => ipcRenderer.invoke("cleo:copy-text", value),
    revealPath: (value) => ipcRenderer.invoke("cleo:reveal-path", value),
    openLocalPath: async (href, workspacePath) => {
      const result = await ipcRenderer.invoke("cleo:open-local-path", { href, workspacePath });
      if (!result?.ok) throw new Error(result?.error || (uiLanguage === "en" ? "Could not open the local file" : "无法打开本地文件"));
    },
    getEvolutionState: async () => inertEvolutionState(),
    evolutionAction: async () => { throw new Error(evolutionUnavailable()); },
    onEvolutionState: () => () => {},
    // Startup confirmation for the version switch controller: the journal clears only after this.
    confirmHealthy: () => ipcRenderer.invoke("cleo:program:healthy"),
    // Opens the version and recovery chooser from inside the app; a selection restarts Cleo.
    openRecovery: () => ipcRenderer.invoke("cleo:program:recovery"),
    getUpdateState: () => ipcRenderer.invoke("cleo:update:get-state"),
    checkForUpdates: (tag) => ipcRenderer.invoke("cleo:update:check", tag),
    downloadUpdate: () => ipcRenderer.invoke("cleo:update:download"),
    installUpdate: () => ipcRenderer.invoke("cleo:update:install"),
    storageInventory: () => ipcRenderer.invoke("cleo:storage:inventory"),
    reclaimStorage: () => ipcRenderer.invoke("cleo:storage:reclaim"),
    onUpdateState: (listener) => {
      const handler = (_event, state) => listener(state);
      ipcRenderer.on("cleo:update-state", handler);
      return () => ipcRenderer.removeListener("cleo:update-state", handler);
    },
  });
}
