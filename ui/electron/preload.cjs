const { contextBridge, ipcRenderer, webUtils } = require("electron");

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
          base64: Buffer.from(await file.arrayBuffer()).toString("base64"),
        });
      }
      return ipcRenderer.invoke("cleo:prepare-attachments", { paths, inline });
    },
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
