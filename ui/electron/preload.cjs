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
  });
}
