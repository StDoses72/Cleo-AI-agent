const { contextBridge, ipcRenderer } = require("electron");

if (!process.argv.includes("--cleo-desktop-mock")) {
  contextBridge.exposeInMainWorld("cleoDesktop", {
    request: (method, params = {}, streamId = null) =>
      ipcRenderer.invoke("cleo:request", { method, params, streamId }),
    onStreamEvent: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on("cleo:stream-event", handler);
      return () => ipcRenderer.removeListener("cleo:stream-event", handler);
    },
    pickAttachments: () => ipcRenderer.invoke("cleo:pick-attachments"),
    pickWorkspace: () => ipcRenderer.invoke("cleo:pick-workspace"),
    copyText: (value) => ipcRenderer.invoke("cleo:copy-text", value),
    revealPath: (value) => ipcRenderer.invoke("cleo:reveal-path", value),
    openLocalPath: async (href, workspacePath) => {
      const result = await ipcRenderer.invoke("cleo:open-local-path", { href, workspacePath });
      if (!result?.ok) throw new Error(result?.error || "无法打开本地文件");
    },
    getUpdateState: () => ipcRenderer.invoke("cleo:update:get-state"),
    checkForUpdates: () => ipcRenderer.invoke("cleo:update:check"),
    downloadUpdate: () => ipcRenderer.invoke("cleo:update:download"),
    installUpdate: () => ipcRenderer.invoke("cleo:update:install"),
    onUpdateState: (listener) => {
      const handler = (_event, state) => listener(state);
      ipcRenderer.on("cleo:update-state", handler);
      return () => ipcRenderer.removeListener("cleo:update-state", handler);
    },
  });
}
