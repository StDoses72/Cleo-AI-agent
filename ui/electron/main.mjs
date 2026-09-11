import { randomUUID } from "node:crypto";
import { launchDesktop } from "./evolution-launch.mjs";
import { waitForControllerReady, showRecovery } from "./evolution-recovery.mjs";
import { EvolutionManager } from "./evolution.mjs";
import { rmSync } from "node:fs";
import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ATTACHMENT_FILTERS,
  MAX_ATTACHMENT_COUNT,
  attachmentsFromPaths,
  materializeInlineAttachments,
} from "./attachments.mjs";
import { BackendBridge } from "./backend.mjs";
import { openLocalHref } from "./local-files.mjs";
import { DesktopUpdater } from "./updater.mjs";
import { DependencyUpdater } from "./dependencies.mjs";
import {
  acquireSingleInstance, installationPaths, interceptUpdateStartup,
} from "./install-state.mjs";

const here = dirname(fileURLToPath(import.meta.url));
app.setName("Cleo");
if (app.isPackaged) {
  if (process.platform === "win32") {
    const paths = installationPaths(app.getPath("temp"), process.execPath);
    if (await interceptUpdateStartup(paths)) app.exit(0);
  }
  if (!acquireSingleInstance(app, () => BrowserWindow.getAllWindows())) app.exit(0);
}
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
const dependencies = new DependencyUpdater({
  app, resourcesPath: process.resourcesPath,
  cleoHome: backend.runtimePaths().cleoHome,
  onState: (state) => updater.setState({ dependencies: state }),
});
const evolution = new EvolutionManager({
  app, root: join(app.getPath("userData"), "evolution"), dataHome: backend.runtimePaths().cleoHome,
  onState: () => {
    void evolution.status().then((state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send("cleo:evolution:state", state);
      }
    }).catch((error) => console.error("Evolution status:", error.message));
  },
});
process.env.CLEO_EVOLUTION_WORKSPACE = evolution.source;

/** Purpose: Hand off activation after explicit consent. Input: build id; current user data is always retained. Output: app restart. */
async function applyEvolution(id) {
  if (backend.pending.size) throw new Error("请先等待当前任务完成或停止任务，再应用改动。");
  const state = await evolution.store.read();
  if (state.active === id) return true;
  const tx = await evolution.stage(id);
  try {
    const controller = await launchDesktop(process.execPath,
      [`--cleo-apply-parent=${process.pid}`, `--user-data-dir=${app.getPath("userData")}`],
      { ...process.env, CLEO_HOME: evolution.store.dataHome });
    await waitForControllerReady(evolution.store, tx.id, controller);
    await backend.close();
  } catch (error) {
    await evolution.store.update({ transaction: null });
    await backend.restart();
    throw error;
  }
  app.quit();
  return Boolean(tx);
}

/** Purpose: Release harness processes before archiving their source workspace.
 * Input: chosen version or discard intent. Output: restart into the chosen program, or a resumed backend on failure.
 */
async function changeEvolutionBase(id, discard = false) {
  await backend.close();
  try {
    const target = discard ? await evolution.discardIteration() : await evolution.selectVersion(id);
    if ((await evolution.store.read()).active === target) {
      await backend.restart();
      return true;
    }
    return await applyEvolution(target);
  } catch (error) {
    await backend.restart();
    throw error;
  }
}

const allowedMethods = new Set([
  "load_workspace",
  "open_evolution_thread",
  "load_thread",
  "create_thread",
  "delete_thread",
  "add_project",
  "remove_project",
  "restore_chat_backups",
  "stream_turn",
  "cancel_run",
  "resolve_approval",
  "update_runtime",
  "get_config_templates",
  "get_agent_instructions",
  "get_model_settings",
  "get_runtime_catalog",
  "get_productivity_models",
  "save_model_profile",
  "save_dream_settings",
  "check_model_connection",
  "create_model_connection",
  "select_chat_model",
  "rename_model_connection",
  "remove_model_connection",
  "get_subscription_catalog",
  "check_subscription",
  "start_subscription_login",
  "read_subscription_login",
  "cancel_subscription_login",
  "save_agent_instructions",
  "get_memory_review_details",
  "review_memory_source",
  "undo_changes",
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
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 14, y: 14 } } : {}),
    titleBarOverlay: process.platform === "darwin" ? false : {
      color: "#0b0e12",
      symbolColor: "#848c98",
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
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  void window.loadFile(join(here, "../dist/index.html"));
}

app.setAppUserModelId("ai.cleo.desktop");
app.whenReady().then(async () => {
  const attachmentTempRoot = join(app.getPath("temp"), "Cleo", "attachments", randomUUID());
  app.once("will-quit", () => {
    try {
      rmSync(attachmentTempRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of app-owned clipboard attachment files.
    }
  });
  Menu.setApplicationMenu(process.platform === "darwin" ? Menu.buildFromTemplate([
    { role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
  ]) : null);
  ipcMain.on("cleo:window-theme", (event, theme) => {
    if (theme !== "light" && theme !== "dark") return;
    if (process.platform !== "win32" && process.platform !== "linux") return;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    window.setTitleBarOverlay({
      color: theme === "light" ? "#e9e9e6" : "#0b0e12",
      symbolColor: theme === "light" ? "#59636f" : "#848c98",
    });
  });
  ipcMain.handle("cleo:request", async (event, payload) => {
    const method = String(payload?.method || "");
    if (!allowedMethods.has(method)) throw new Error(`Unsupported desktop method: ${method}`);
    const streamId = payload?.streamId ? String(payload.streamId) : null;
    if (method === "stream_turn" && evolution.phase !== "idle") {
      throw new Error("请等待进化操作完成后再修改代码。");
    }
    const result = await backend.request(method, payload?.params || {}, (streamEvent) => {
      if (streamId && !event.sender.isDestroyed()) {
        event.sender.send("cleo:stream-event", { streamId, event: streamEvent });
      }
    });
    if (["save_model_profile", "save_dream_settings", "create_model_connection",
      "select_chat_model", "rename_model_connection", "remove_model_connection"].includes(method)) {
      await backend.restart();
    }
    return result;
  });
  ipcMain.handle("cleo:pick-attachments", async () => {
    const result = await dialog.showOpenDialog({
      title: "添加附件",
      buttonLabel: "添加",
      properties: ["openFile", "multiSelections"],
      filters: ATTACHMENT_FILTERS,
    });
    if (result.canceled) return [];
    return attachmentsFromPaths(result.filePaths);
  });
  ipcMain.handle("cleo:prepare-attachments", async (_event, payload) => {
    const paths = Array.isArray(payload?.paths) ? payload.paths : [];
    const inline = Array.isArray(payload?.inline) ? payload.inline : [];
    if (paths.length + inline.length > MAX_ATTACHMENT_COUNT) {
      throw new Error(`一次最多添加 ${MAX_ATTACHMENT_COUNT} 个附件`);
    }
    const [pathAttachments, inlineAttachments] = await Promise.all([
      attachmentsFromPaths(paths),
      materializeInlineAttachments(inline, attachmentTempRoot),
    ]);
    return [...pathAttachments, ...inlineAttachments];
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
  ipcMain.handle("cleo:open-local-path", async (_event, payload) => {
    try {
      const result = await openLocalHref({
        href: payload?.href,
        workspacePath: payload?.workspacePath,
        shellAdapter: shell,
      });
      return { ok: true, ...result };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "无法打开本地文件",
      };
    }
  });
  ipcMain.handle("cleo:update:get-state", () => updater.getState());
  ipcMain.handle("cleo:update:check", () => updater.check());
  ipcMain.handle("cleo:update:download", () => updater.download());
  ipcMain.handle("cleo:update:install", async () => {
    const releases = await evolution.releases();
    const release = releases.find((item) => item.tag.replace(/^v/, "") === updater.getState().latestVersion);
    if (!release) throw new Error("请重新检查正式版本。");
    return applyEvolution(await evolution.downloadRelease(release.tag));
  });
  ipcMain.handle("cleo:evolution:state", () => evolution.status());
  ipcMain.handle("cleo:evolution:action", async (_event, payload) => {
    const { action, ...params } = payload || {};
    if (backend.pending.size && ["prepare", "build", "merge", "submit", "apply", "recovery", "select", "discard", "save", "begin"].includes(action)) {
      throw new Error("请先等待当前任务完成或停止任务。");
    }
    const actions = {
      prepare: () => evolution.prepare(),
      begin: () => evolution.operation("preparing", () => evolution.store.beginIteration()),
      save: () => evolution.saveVersion(params.name),
      select: () => changeEvolutionBase(params.id),
      discard: () => changeEvolutionBase(null, true),
      build: () => evolution.build(),
      releases: () => evolution.releases(),
      download: () => evolution.downloadRelease(params.tag),
      merge: () => evolution.mergeRelease(params.tag),
      login: () => evolution.login(),
      submit: () => evolution.submitPullRequest(params.title, params.body),
      pullRequest: () => evolution.refreshPullRequest(),
      apply: () => applyEvolution(params.id),
      thread: () => evolution.operation("preparing", () => evolution.store.update({ threadId: String(params.id || "") })),
      recovery: async () => {
        await evolution.ensureBaseline();
        const selected = await showRecovery(evolution.store, { selectOnly: true, parentWindow: BrowserWindow.fromWebContents(_event.sender) });
        if (selected) return applyEvolution(selected);
      },
    };
    if (!Object.hasOwn(actions, action)) throw new Error("不支持的进化操作。");
    return actions[action]();
  });
  if (!app.isPackaged) ipcMain.handle("cleo:evolution:healthy", () => {});
  // Downloaded updates never authorize installation. Selection is explicit and recoverable.
  backend.runtime = await dependencies.prepare();
  const hasInstallResult = await updater.restoreInstallationResult();
  createWindow();
  const installResult = await updater.takeInstallResult();
  if (installResult) {
    void dialog.showMessageBox({
      type: installResult.status === "installed" ? "info" : "error",
      message: installResult.status === "installed" ? `Cleo 已更新至 ${installResult.version}` : "Cleo 更新未完成",
      detail: installResult.error || "新版本已安装完成。",
    });
  }
  const refresh = () => updater.check().catch((error) => console.error("Update check:", error.message));
  if (!hasInstallResult) setTimeout(() => void refresh(), 1500);
  const refreshTimer = setInterval(() => void refresh(), 6 * 60 * 60 * 1000);
  app.once("will-quit", () => clearInterval(refreshTimer));
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
  void Promise.all([backend.close(), dependencies.close()])
    .catch((error) => console.error("Cleo shutdown failed:", error))
    .finally(() => app.quit());
});
