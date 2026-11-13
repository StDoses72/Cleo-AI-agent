import { t as tr, getLanguage, setLanguage } from "./i18n.mjs";
import { randomUUID } from "node:crypto";
import { readUiLanguage } from "./language.mjs";
import { launchDesktop } from "./program-launch.mjs";
import { waitForControllerReady, showRecovery } from "./program-recovery.mjs";
import { ProgramVersions } from "./program-versions.mjs";
import { rmSync } from "node:fs";
import {
  app, BrowserWindow, Menu, Tray, WebContentsView, clipboard, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, protocol, screen, session, shell,
} from "electron";
import { trustedPreviewSender } from "./computer-preview.mjs";
import { ComputerUse, registerComputerSchemes } from "./computer/index.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ATTACHMENT_FILTERS,
  MAX_ATTACHMENT_COUNT,
  attachmentsFromPaths,
  materializeInlineAttachments,
  withThumbnails,
} from "./attachments.mjs";
import { BackendBridge } from "./backend.mjs";
import { configureReleaseChannel } from "./release-channel.mjs";
import { openLocalHref } from "./local-files.mjs";
import { createSourceControl } from "./source-control.mjs";
import { SelectableUpdater, SelectableProgramUpdates } from "./selectable-updates.mjs";
import { ReleaseDownloads } from "./release-downloads.mjs";
import { createQuitBarrier } from "./shutdown.mjs";
import { createTrayController } from "./tray.mjs";
import { createBackgroundMemoryScheduler } from "./background-memory.mjs";
import { DependencyUpdater } from "./dependencies.mjs";
import { acquireSingleInstance } from "./install-state.mjs";

import { SetupManager } from "./setup-manager.mjs";
import { readJson } from "./program-store.mjs";
import { createStorageQueue, defaultLauncherPaths, reclaimStorage, storageInventory } from "./storage-reclaim.mjs";
import { defaultRuntimeRoot } from "./online-runtime.mjs";

/** The theme chosen in the main window (light/dark), handed to the restart window; null = system. */
let windowTheme = null;
const here = dirname(fileURLToPath(import.meta.url));
const alphaChannel = configureReleaseChannel(app);
let desktopTray;
if (app.isPackaged && !acquireSingleInstance(app, () => {
    const window = desktopTray?.isQuitting() ? null : desktopTray?.getWindow();
    return window ? [window] : [];
  })) {
  app.exit(0);
} else {
// Do not register ready handlers or publish a bridge after the instance lock was denied.
registerComputerSchemes(protocol);
const backend = new BackendBridge({ app, here });
setLanguage(await readUiLanguage(backend.runtimePaths().cleoHome));
const computer = new ComputerUse({
  app, backend,
  electron: { BrowserWindow, WebContentsView, dialog, globalShortcut, nativeImage, screen, session, shell },
});
// Program versions, downloads and switch journals live here; the directory name is an on-disk format.
const controlRoot = join(app.getPath("userData"), "evolution");
const releaseDownloads = new ReleaseDownloads({
  root: join(controlRoot, "downloads"),
  legacyPaths: manifest => [
    join(app.getPath("temp"), `cleo-update-${manifest.version}${process.platform === "win32" ? "" : `-${manifest.platform}`}`, manifest.archive),
    join(controlRoot, "downloads", `v${manifest.version}-${manifest.archive}`),
  ],
});
const updater = new SelectableUpdater({
  app,
  downloads: releaseDownloads,
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
const versions = new ProgramVersions({
  app, root: controlRoot, dataHome: backend.runtimePaths().cleoHome, downloads: releaseDownloads,
  onState: () => updater.setState({ operationBusy: programUpdates.busy || versions.phase !== "idle",
    blocksTasks: programUpdates.blocksTasks || versions.phase !== "idle" }),
});
const programUpdates = new SelectableProgramUpdates({ updater, versions, apply: applyVersion,
  hasRunningTask: () => backend.pending.size > 0 || setup.busy });
/** Purpose: Describe Cleo-owned storage and reclaim what no retained program references.
 * Input: whether the user asked (manual also drops convenience caches). Output: inventory or reclaim result.
 */
// The other release channel keeps its own data and registry but shares the online runtime root.
const siblingChannel = () => {
  const cleoHome = backend.runtimePaths().cleoHome;
  const name = alphaChannel ? "Cleo" : "Cleo Alpha";
  return { label: name, controlRoot: join(dirname(app.getPath("userData")), name, "evolution"),
    dataHome: join(dirname(cleoHome), name) };
};
let storageReady = false;
const storageOptions = () => ({
  dataHome: backend.runtimePaths().cleoHome, store: versions.store, siblings: [siblingChannel()],
  currentResources: process.resourcesPath, currentRuntimeNamespace: dependencies.installationRoot,
  currentBaseResources: dependencies.baseResources, onlineRoots: [defaultRuntimeRoot(), defaultRuntimeRoot(true)],
  installedExecutables: [process.execPath, ...defaultLauncherPaths()], currentVersion: app.getVersion(),
  protectedVersions: [updater.getState().latestVersion, updater.getState().selectedTag?.replace(/^v/, "")].filter(Boolean),
  downloadsBusy: () => releaseDownloads.busy || programUpdates.busy || versions.phase !== "idle" || setup.busy,
  pruneOnlineRuntimes: storageReady,
});
const storage = createStorageQueue();
app.on("cleo:healthy", (transactionId) => {
  storageReady = true;
  // Reclaim after the program proved itself; locked entries stay journaled for the next start.
  void storage(() => reclaimStorage(storageOptions())).then(result => {
    if (result.removed.length || result.failed.length) console.log(`Storage cleanup: removed ${result.removed.length}, failed ${result.failed.length}, freed ${result.freedBytes} bytes.`);
  }).catch(error => console.error("Storage cleanup:", error.message));
  void versions.store.read().then(state => {
    if (!transactionId || state.transaction || state.lastApplication?.id !== transactionId) return;
    const build = state.builds.find(item => item.id === state.active);
    if (build?.kind === "official" && state.lastApplication.to === state.active) {
      updater.setState({ phase: "updated", latestVersion: build.version, installStage: null, error: null });
    }
  }).catch(error => console.error("Update result:", error.message));
});
const setup = new SetupManager({ root: join(process.env.CLEO_HOME || backend.runtimePaths().cleoHome, "setup"),
  version: app.getVersion(),
  python: process.env.CLEO_PYTHON || backend.runtimePaths().python || (process.platform === "win32" ? "python" : "python3"),
  resourcesPath: process.resourcesPath,
  repairRuntime: async () => {
    if (!dependencies.runtime) throw new Error(tr("main.the_runtime_bundled_with_the_application_cannot_start_reinstall_cleo_and_try_again"));
    await dependencies.check();
    const result = await readJson(join(dependencies.root, "state.json"), {});
    if (result.phase === "error" || updater.getState().dependencies?.phase === "error")
      throw new Error(result.error || updater.getState().dependencies.error || tr("main.runtime_repair_is_not_complete"));
  },
});

/** Purpose: Hand a version switch to the restart controller after explicit consent.
 * Input: retained build id; current user data is always kept. Output: app restart, or true when already active.
 */
async function applyVersion(id) {
  if (backend.pending.size) throw new Error(tr("main.wait_for_the_current_task_to_finish_or_stop_it_before_applying_changes"));
  const state = await versions.store.read();
  if (state.active === id) return true;
  const tx = await versions.stage(id);
  try {
    const controller = await launchDesktop(process.execPath,
      [`--cleo-apply-parent=${process.pid}`, `--user-data-dir=${app.getPath("userData")}`,
        ...(windowTheme ? [`--cleo-theme=${windowTheme}`] : [])],
      { ...process.env, CLEO_HOME: versions.store.dataHome });
    await waitForControllerReady(versions.store, tx.id, controller);
    await backend.close();
  } catch (error) {
    await versions.store.update({ transaction: null });
    await backend.restart();
    throw error;
  }
  programUpdates.beginRestart();
  app.quit();
  return Boolean(tx);
}

const allowedMethods = new Set([
  "get_ui_language",
  "set_ui_language",
  "load_workspace",
  "load_memory",
  "load_thread",
  "create_thread",
  "delete_thread",
  "move_thread",
  "add_project",
  "remove_project",
  "restore_chat_backups",
  "stream_turn",
  "steer_run",
  "rewind_thread",
  "cancel_run",
  "resolve_approval",
  "resolve_question",
  "get_pending_questions",
  "load_timeline",
  "read_timeline_content",
  "get_timing",
  "update_runtime",
  "switch_harness",
  "get_config_templates",
  "get_agent_instructions",
  "get_model_settings",
  "get_routing_settings",
  "save_routing_settings",
  "refresh_routing_benchmarks",
  "save_benchmark_connection",
  "submit_routing_feedback",
  "get_runtime_catalog",
  "get_config_status",
  "get_productivity_models",
  "get_harness_usage",
  "get_local_skills",
  "get_harness_sync",
  "sync_harness_items",
  "save_model_profile",
  "save_dream_settings",
  "get_background_memory_state",
  "get_memory_sources",
  "save_memory_sources",
  "save_background_memory_settings",
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

// Share the platform icon between the window and tray.
const iconFile = process.platform === "win32" ? "cleo.ico" : "cleo.png";
const iconPath = app.isPackaged
  ? join(process.resourcesPath, iconFile)
  : join(here, "../public", iconFile);
desktopTray = createTrayController({
  app, Menu, Tray, nativeImage, iconPath, createWindow,
  canOpen: () => !programUpdates.closed,
  onOpenMemory: window => {
    const send = () => { if (!window.isDestroyed()) window.webContents.send("cleo:open-memory"); };
    if (window.webContents.isLoading()) window.webContents.once("did-finish-load", send);
    else send();
  },
});
const backgroundMemory = createBackgroundMemoryScheduler({
  backend,
  canRun: () => !programUpdates.closed && !programUpdates.busy && !setup.busy
    && versions.phase === "idle" && backend.pending.size === 0,
  onError: error => console.error("Background memory:", error.message),
});

function createWindow() {
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
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 14, y: 11 } } : {}),
    titleBarOverlay: process.platform === "darwin" ? false : {
      color: "#111113",
      symbolColor: "#98989e",
      height: 38,
    },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(here, "preload.cjs"),
      additionalArguments: [`--cleo-ui-language=${getLanguage()}`, ...(process.env.CLEO_DESKTOP_MOCK === "1" ? ["--cleo-desktop-mock"] : [])],
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  desktopTray.attachWindow(window);
  window.once("ready-to-show", () => {
    if (!desktopTray.isQuitting()) window.show();
  });
  computer.attachWindow(window);
  void window.loadFile(join(here, "../dist/index.html"));
  return window;
}

app.setAppUserModelId(alphaChannel ? "ai.cleo.desktop.alpha" : "ai.cleo.desktop");
app.whenReady().then(async () => {
  // The computer bridge must exist before the backend starts so tool processes can find it.
  // A failure here disables computer use only; Cleo itself must still start.
  await computer.start().catch(error => console.error("Computer use:", error.message));
  ipcMain.handle("cleo:setup", async (event, action, params = {}) => {
    if (!trustedPreviewSender(event, pathToFileURL(join(here, "../dist/index.html")).href)) throw new Error(tr("main.manage_dependencies_in_cleo_s_main_window"));
    if (action === "status") return setup.state();
    if (action === "startup") return setup.startup();
    if (action === "scan") return setup.scan();
    if (action === "dismiss") return setup.dismiss();
    if (action === "install") {
      if (backend.pending.size || versions.phase !== "idle" || programUpdates.busy) throw new Error(tr("main.wait_for_current_tasks_and_version_operations_to_finish"));
      return setup.install(params.ids, params.consent);
    }
    throw new Error(tr("main.unknown_dependency_operation"));
  });
  const appUrl = pathToFileURL(join(here, "../dist/index.html")).href;
  ipcMain.handle("cleo:computer", (event, action = "state", params = {}) => {
    if (!trustedPreviewSender(event, appUrl)) throw new Error(tr("main.the_computer_panel_is_available_only_to_cleo_s_main_window"));
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error(tr("main.cleo_s_main_window_was_not_found"));
    return computer.handle(window, String(action), params && typeof params === "object" ? params : {});
  });
  ipcMain.handle("cleo:files", (event, op, params = {}) => {
    if (!trustedPreviewSender(event, appUrl)) throw new Error(tr("main.the_file_sidebar_is_available_only_to_cleo_s_main_window"));
    return computer.handleFiles(String(op), params && typeof params === "object" ? params : {});
  });
  const sourceControl = createSourceControl();
  ipcMain.handle("cleo:git", (event, op, params = {}) => {
    if (!trustedPreviewSender(event, appUrl)) throw new Error(tr("main.the_file_sidebar_is_available_only_to_cleo_s_main_window"));
    return sourceControl(String(op), params && typeof params === "object" ? params : {});
  });
  // Take-over and stop clicks from Cleo's own overlay page and host status bar.
  ipcMain.on("cleo:computer:overlay", (event, action) => computer.overlay(event.sender, String(action)));
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
  // Finished replies the user has not opened: a dock badge where the OS has one, an overlay icon on Windows.
  ipcMain.on("cleo:window-badge", (event, payload) => {
    const count = Math.max(0, Math.floor(Number(payload?.count) || 0));
    const overlay = typeof payload?.overlay === "string" && payload.overlay.startsWith("data:image/png;base64,") ? payload.overlay : null;
    if (process.platform === "darwin" || process.platform === "linux") {
      try { app.setBadgeCount(count); } catch { /* badge support depends on the desktop environment */ }
      return;
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    if (!count || !overlay) {
      window.setOverlayIcon(null, "");
      return;
    }
    window.setOverlayIcon(nativeImage.createFromDataURL(overlay), tr("main.value_completed_replies", { p0: count }));
  });
  ipcMain.on("cleo:window-theme", (event, theme) => {
    if (theme !== "light" && theme !== "dark") return;
    // The restart window follows the theme chosen in the main window rather than the system's.
    windowTheme = theme;
    nativeTheme.themeSource = theme;
    if (process.platform !== "win32" && process.platform !== "linux") return;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    window.setTitleBarOverlay({
      color: theme === "light" ? "#f7f7f6" : "#111113",
      symbolColor: theme === "light" ? "#59636f" : "#98989e",
    });
  });
  ipcMain.handle("cleo:request", async (event, payload) => {
    if (programUpdates.closed) throw new Error(tr("main.cleo_is_shutting_down_try_again_later"));
    const method = String(payload?.method || "");
    if (!allowedMethods.has(method)) throw new Error(`Unsupported desktop method: ${method}`);
    const streamId = payload?.streamId ? String(payload.streamId) : null;
    const controlsRun = method === "stream_turn" || method === "steer_run";
    if (controlsRun && (programUpdates.blocksTasks || setup.busy)) {
      throw new Error(tr("main.wait_for_the_version_or_setup_operation_to_finish"));
    }
    const params = payload?.params || {};
    const onEvent = (streamEvent) => {
      if (streamId && !event.sender.isDestroyed()) {
        event.sender.send("cleo:stream-event", { streamId, event: streamEvent });
      }
    };
    const tracksTurn = method === "stream_turn" && typeof params.thread_id === "string";
    if (controlsRun) {
      // A turn must not start while a program switch is journaled or a version operation is writing.
      const transaction = (await versions.store.read()).transaction;
      if (programUpdates.closed) throw new Error(tr("main.cleo_is_shutting_down_try_again_later"));
      if (programUpdates.blocksTasks || transaction || versions.phase !== "idle")
        throw new Error(tr("main.wait_for_the_current_version_operation_to_finish"));
    }
    if (tracksTurn) computer.broker.turnStarted(params.thread_id, params.run_id);
    let result;
    try {
      result = await backend.request(method, params, onEvent);
    } finally {
      // Queued computer actions of a finished turn must never run in a later one.
      if (tracksTurn) computer.broker.turnEnded(params.thread_id);
    }
    // A deleted conversation leaves no browser pages, queued actions or site data behind.
    if (method === "delete_thread" && typeof params.thread_id === "string") void computer.forgetThread(params.thread_id).catch(() => {});
    if (method === "load_workspace") backend.hotReload = result?.backend?.hotReload === true;
    if (method === "set_ui_language" || method === "get_ui_language") {
      setLanguage(result);
      desktopTray.refreshLanguage();
      computer.browser.refreshLanguage();
      computer.controls.pushStatus();
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send("cleo:language-changed", result);
      }
    }
    // Backends without hot reload still need a restart.
    if (!backend.hotReload && ["save_model_profile", "save_dream_settings", "create_model_connection",
      "select_chat_model", "rename_model_connection", "remove_model_connection"].includes(method)) {
      await backend.restart();
    }
    return result;
  });
  ipcMain.handle("cleo:pick-attachments", async () => {
    const result = await dialog.showOpenDialog({
      title: tr("conversation.add_attachment"),
      buttonLabel: tr("connectionwizard.add"),
      properties: ["openFile", "multiSelections"],
      filters: ATTACHMENT_FILTERS,
    });
    if (result.canceled) return [];
    return withThumbnails(await attachmentsFromPaths(result.filePaths), nativeImage.createFromPath);
  });
  ipcMain.handle("cleo:prepare-attachments", async (_event, payload) => {
    const paths = Array.isArray(payload?.paths) ? payload.paths : [];
    const inline = Array.isArray(payload?.inline) ? payload.inline : [];
    if (paths.length + inline.length > MAX_ATTACHMENT_COUNT) {
      throw new Error(tr("attachments.you_can_add_at_most_value_attachments_at_once", { p0: MAX_ATTACHMENT_COUNT }));
    }
    const [pathAttachments, inlineAttachments] = await Promise.all([
      attachmentsFromPaths(paths),
      materializeInlineAttachments(inline, attachmentTempRoot),
    ]);
    return withThumbnails([...pathAttachments, ...inlineAttachments], nativeImage.createFromPath);
  });
  ipcMain.handle("cleo:pick-workspace", async (event) => {
    const options = {
      title: tr("main.choose_or_create_a_project_folder"),
      buttonLabel: tr("main.use_as_workspace"),
      properties: ["openDirectory", "createDirectory"],
    };
    const parent = BrowserWindow.fromWebContents(event.sender);
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
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
        error: error instanceof Error ? error.message : tr("app.could_not_open_the_local_file"),
      };
    }
  });
  ipcMain.handle("cleo:update:get-state", () => updater.getState());
  ipcMain.handle("cleo:update:check", (_event, tag) => programUpdates.check(tag));
  ipcMain.handle("cleo:update:download", () => programUpdates.download());
  ipcMain.handle("cleo:update:install", () => programUpdates.install());
  ipcMain.handle("cleo:storage:inventory", () => storage(() => storageInventory(storageOptions())));
  ipcMain.handle("cleo:storage:reclaim", () => {
    if (backend.pending.size) throw new Error(tr("main.wait_for_the_current_task_to_finish_or_stop_it_before_reclaiming_storage"));
    return storage(() => reclaimStorage(storageOptions(), { manual: true }));
  });
  // The version and recovery chooser, opened from inside the app; a selection restarts into that program.
  ipcMain.handle("cleo:program:recovery", (event) => {
    if (setup.busy) throw new Error(tr("main.wait_for_dependency_installation_to_finish"));
    if (backend.pending.size) throw new Error(tr("main.wait_for_the_current_task_to_finish_or_stop_it"));
    if (programUpdates.closed) throw new Error(tr("main.cleo_is_shutting_down_try_again_later"));
    return programUpdates.run(async () => {
      await versions.operation("preparing", () => versions.ensureBaseline());
      const selected = await showRecovery(versions.store, { selectOnly: true, parentWindow: BrowserWindow.fromWebContents(event.sender) });
      if (selected) return applyVersion(selected);
    });
  });
  // bootstrap.mjs owns the startup confirmation in a packaged app; development has no version switch to confirm.
  if (!app.isPackaged) ipcMain.handle("cleo:program:healthy", () => {});
  // Downloaded updates never authorize installation. Selection is explicit and recoverable.
  try { backend.runtime = await dependencies.prepare(); }
  catch (error) { updater.setState({ dependencies: { phase: "error", error: error.message } }); }
  setup.python = process.env.CLEO_PYTHON || backend.runtimePaths().python || (process.platform === "win32" ? "python" : "python3");
  desktopTray.start();
  createWindow();
  backgroundMemory.start();
  // External setup and internal runtime updates require a user-approved setup action.
  const refresh = () => programUpdates.check().catch((error) => console.error("Update check:", error.message));
  if (!process.env.CLEO_EVOLUTION_TRANSACTION) setTimeout(() => void refresh(), 1500);
  const refreshTimer = setInterval(() => void refresh(), 6 * 60 * 60 * 1000);
  app.once("will-quit", () => clearInterval(refreshTimer));
});

app.on("before-quit", createQuitBarrier({
  close: [() => backgroundMemory.stop(), () => setup.close(), () => computer.close(), () => programUpdates.close(), () => backend.shutdown(), () => dependencies.close(),
    () => releaseDownloads.close(), () => versions.close()],
  onError: error => console.error("Cleo shutdown failed:", error),
  quit: () => app.quit(),
}));

}
