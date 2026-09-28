const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("cleoMonitor", {
  status: () => ipcRenderer.invoke("cleo:monitor:status"),
  send: body => ipcRenderer.invoke("cleo:monitor:send", body),
  control: (action, params = {}) => ipcRenderer.invoke("cleo:monitor:control", action, params),
});
