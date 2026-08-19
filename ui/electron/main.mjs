import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, shell } from "electron";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BackendBridge } from "./backend.mjs";
import { DesktopUpdater } from "./updater.mjs";

const here = dirname(fileURLToPath(import.meta.url));
app.setName("Cleo");
const backend = new BackendBridge({ app, here });
const updater = new DesktopUpdater({
  app,
  resourcesPath: process.resourcesPath,
  onState: (state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("cleo:update-state", state);
    }
  },
});
const allowedMethods = new Set([
  "load_workspace",
  "load_thread",
  "create_thread",
  "delete_thread",
  "restore_chat_backups",
  "stream_turn",
  "cancel_run",
  "update_runtime",
  "get_config_templates",
  "get_agent_instructions",
  "get_model_settings",
  "get_runtime_catalog",
  "get_productivity_models",
  "save_model_profile",
  "save_agent_instructions",
  "get_memory_review_details",
  "review_memory_source",
  "reset_workspace",
]);

function createWindow() {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, "cleo.png")
    : join(here, "../public/cleo.png");

  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    show: false,
    title: "Cleo",
    icon: iconPath,
    backgroundColor: "#0b0d10",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0b0d10",
      symbolColor: "#8c939d",
      height: 44,
    },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(here, "preload.cjs"),
      additionalArguments: process.env.CLEO_DESKTOP_MOCK === "1" ? ["--cleo-desktop-mock"] : [],
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  void window.loadFile(join(here, "../dist/index.html"));
}

app.setAppUserModelId("ai.cleo.desktop");
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  ipcMain.handle("cleo:request", async (event, payload) => {
    const method = String(payload?.method || "");
    if (!allowedMethods.has(method)) throw new Error(`Unsupported desktop method: ${method}`);
    const streamId = payload?.streamId ? String(payload.streamId) : null;
    const result = await backend.request(method, payload?.params || {}, (streamEvent) => {
      if (streamId && !event.sender.isDestroyed()) {
        event.sender.send("cleo:stream-event", { streamId, event: streamEvent });
      }
    });
    if (method === "save_model_profile") await backend.restart();
    return result;
  });
  ipcMain.handle("cleo:pick-attachments", async () => {
    const result = await dialog.showOpenDialog({
      title: "添加图片",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (result.canceled) return [];
    return Promise.all(
      result.filePaths.map(async (path) => {
        const extension = path.split(".").at(-1)?.toLowerCase();
        const mimeType = extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : extension === "gif" ? "image/gif" : "image/jpeg";
        return {
          name: path.split(/[\\/]/).at(-1) || "image",
          path,
          mimeType,
          base64: (await readFile(path)).toString("base64"),
        };
      }),
    );
  });
  ipcMain.handle("cleo:pick-workspace", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择工作目录",
      buttonLabel: "打开目录",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle("cleo:copy-text", (_event, value) => clipboard.writeText(String(value || "")));
  ipcMain.handle("cleo:reveal-path", (_event, value) => shell.showItemInFolder(String(value || "")));
  ipcMain.handle("cleo:update:get-state", () => updater.getState());
  ipcMain.handle("cleo:update:check", () => updater.check());
  ipcMain.handle("cleo:update:download", () => updater.download());
  ipcMain.handle("cleo:update:install", () => updater.install());
  createWindow();
  setTimeout(() => void updater.check(), 1500);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let shutdownStarted = false;
app.on("before-quit", (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  void backend.close().finally(() => app.quit());
});
