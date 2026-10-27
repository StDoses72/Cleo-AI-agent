import { sourceText, t as tr, getLanguage, setLanguage } from "./i18n.mjs";
import { randomUUID } from "node:crypto";
import { readUiLanguage } from "./language.mjs";
import { launchDesktop } from "./evolution-launch.mjs";
import { waitForControllerReady, showRecovery } from "./evolution-recovery.mjs";
import { EvolutionManager } from "./evolution.mjs";
import { listContributionBranches, requestTargetBranch, refreshTargetBranch } from "./evolution-contributions.mjs";
import { checkContribution, submitContribution, inspectPullRequest, contributionRepairPrompt } from "./evolution-merge-assistance.mjs";
import { runEvolutionTurn } from "./evolution-editing.mjs";
import { rmSync } from "node:fs";
import {
  app, BrowserWindow, Menu, Tray, WebContentsView, clipboard, dialog, globalShortcut, ipcMain, nativeImage, protocol, screen, session, shell,
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
} from "./attachments.mjs";
import { BackendBridge } from "./backend.mjs";
import { configureReleaseChannel } from "./release-channel.mjs";
import { openLocalHref } from "./local-files.mjs";
import { SelectableUpdater, SelectableProgramUpdates, prepareSelectedRelease } from "./selectable-updates.mjs";
import { checkReleasePermission, previewRelease, publishRelease, publishMergedRelease, previewMergedRelease } from "./github-releases.mjs";
import { releaseBuilds, publishReleasePackages, releasePackageStatus } from "./release-packages.mjs";
import { ReleaseDownloads } from "./release-downloads.mjs";
import { ReleaseJobs } from "./release-jobs.mjs";
import { GithubReleaseDriver } from "./release-driver.mjs";
import { runReleaseRepair } from "./release-repair.mjs";
import { createQuitBarrier } from "./shutdown.mjs";
import { createTrayController } from "./tray.mjs";
import { createBackgroundMemoryScheduler } from "./background-memory.mjs";
import { DependencyUpdater } from "./dependencies.mjs";
import { acquireSingleInstance } from "./install-state.mjs";

import { SetupManager } from "./setup-manager.mjs";
import { startEvolutionMonitor } from "./evolution-monitor.mjs";
import { EvolutionMonitorStore } from "./evolution-monitor-store.mjs";
import { EvolutionCompanion } from "./evolution-companion.mjs";
import { evolutionActions, nextVersionName } from "./evolution-actions.mjs";
import { readJson } from "./evolution-store.mjs";
import { createStorageQueue, defaultLauncherPaths, reclaimStorage, storageInventory } from "./storage-reclaim.mjs";
import { defaultRuntimeRoot } from "./online-runtime.mjs";

if (process.argv.includes("--cleo-evolution-monitor")) {
  configureReleaseChannel(app);
  await startEvolutionMonitor();
} else {
const here = dirname(fileURLToPath(import.meta.url));
const alphaChannel = configureReleaseChannel(app);
registerComputerSchemes(protocol);
let desktopTray;
if (app.isPackaged) {
  if (!acquireSingleInstance(app, () => {
    const window = desktopTray?.isQuitting() ? null : desktopTray?.getWindow();
    return window ? [window] : [];
  })) app.exit(0);
}
const backend = new BackendBridge({ app, here });
setLanguage(await readUiLanguage(backend.runtimePaths().cleoHome));
const computer = new ComputerUse({
  app, backend,
  electron: { BrowserWindow, WebContentsView, dialog, globalShortcut, nativeImage, screen, session, shell },
});
const evolutionRoot = join(app.getPath("userData"), "evolution");
const releaseDownloads = new ReleaseDownloads({
  root: join(evolutionRoot, "downloads"),
  legacyPaths: manifest => [
    join(app.getPath("temp"), `cleo-update-${manifest.version}${process.platform === "win32" ? "" : `-${manifest.platform}`}`, manifest.archive),
    join(evolutionRoot, "downloads", `v${manifest.version}-${manifest.archive}`),
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
const evolution = new EvolutionManager({
  app, root: evolutionRoot, dataHome: backend.runtimePaths().cleoHome,
  downloads: releaseDownloads,
  openExternal: (url) => shell.openExternal(url),
  onState: () => {
    updater.setState({ operationBusy: programUpdates.busy || evolution.phase !== "idle",
      blocksTasks: programUpdates.blocksTasks || evolution.phase !== "idle" });
    void evolutionState().then((state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send("cleo:evolution:state", state);
      }
    }).catch((error) => console.error("Evolution status:", error.message));
  },
});
const programUpdates = new SelectableProgramUpdates({ updater, evolution, apply: applyEvolution,
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
const storageOptions = () => ({
  dataHome: backend.runtimePaths().cleoHome, store: evolution.store, siblings: [siblingChannel()],
  currentResources: process.resourcesPath, currentRuntimeNamespace: dependencies.installationRoot,
  currentBaseResources: dependencies.baseResources, onlineRoots: [defaultRuntimeRoot()],
  installedExecutables: [process.execPath, ...defaultLauncherPaths()], currentVersion: app.getVersion(),
  protectedVersions: [updater.getState().latestVersion, updater.getState().selectedTag?.replace(/^v/, "")].filter(Boolean),
  downloadsBusy: () => releaseDownloads.busy || programUpdates.busy || evolution.phase !== "idle" || setup.busy,
});
const storage = createStorageQueue();
app.on("cleo:healthy", (transactionId) => {
  // Reclaim after the program proved itself; locked entries stay journaled for the next start.
  void storage(() => reclaimStorage(storageOptions())).then(result => {
    if (result.removed.length || result.failed.length) console.log(`Storage cleanup: removed ${result.removed.length}, failed ${result.failed.length}, freed ${result.freedBytes} bytes.`);
  }).catch(error => console.error("Storage cleanup:", error.message));
  void evolution.store.read().then(state => {
    if (!transactionId || state.transaction || state.lastApplication?.id !== transactionId) return;
    const build = state.builds.find(item => item.id === state.active);
    if (build?.kind === "official" && state.lastApplication.to === state.active) {
      updater.setState({ phase: "updated", latestVersion: build.version, installStage: null, error: null });
    }
  }).catch(error => console.error("Update result:", error.message));
});
process.env.CLEO_EVOLUTION_WORKSPACE = evolution.source;
const setup = new SetupManager({ root: join(process.env.CLEO_HOME || backend.runtimePaths().cleoHome, "setup"),
  version: app.getVersion(),
  toolsRoot: join(evolutionRoot, "tools"), python: process.env.CLEO_PYTHON || backend.runtimePaths().python || (process.platform === "win32" ? "python" : "python3"),
  resourcesPath: process.resourcesPath,
  repairRuntime: async () => {
    if (!dependencies.runtime) throw new Error(tr("main.the_runtime_bundled_with_the_application_cannot_start_reinstall_cleo_and_try_again"));
    await dependencies.check();
    const result = await readJson(join(dependencies.root, "state.json"), {});
    if (result.phase === "error" || updater.getState().dependencies?.phase === "error")
      throw new Error(result.error || updater.getState().dependencies.error || tr("main.runtime_repair_is_not_complete"));
  },
});

const monitorStore = new EvolutionMonitorStore(evolutionRoot);
let monitorLaunching = null;
let editingThread = null;
let editingDetail = "";
const companion = new EvolutionCompanion({ store: monitorStore, backend, evolution,
  ready: () => !editingThread && !backend.pending.size && !setup.busy && !programUpdates.busy && !programUpdates.closed && evolution.phase === "idle",
  turn: params => monitoredEvolutionTurn(params, () => {}),
  stop: async threadId => {
    if (evolution.operationAbort) evolution.operationAbort.abort(new Error(tr("main.the_user_stopped_evolution_checks")));
    if (threadId) await backend.request("cancel_run", { thread_id: threadId });
    for (let attempt = 0; attempt < 100 && (editingThread || evolution.phase !== "idle"); attempt++)
      await new Promise(resolve => setTimeout(resolve, 100));
    if (editingThread || evolution.phase !== "idle") throw new Error(tr("main.the_task_has_not_stopped_yet_retry_recovery_later"));
  },
  discard: () => programUpdates.run(() => changeEvolutionBase(null, true)),
  rollback: id => programUpdates.run(() => changeEvolutionBase(id, true)),
  build: () => programUpdates.run(() => evolution.build()),
  apply: id => programUpdates.run(() => applyEvolution(id)),
  save: name => programUpdates.run(() => evolution.saveVersion(name)),
  notify: thread => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send("cleo:companion-thread", thread);
  },
});
/** Purpose: Reuse one independent progress window, including across application restart.
 * Input: none. Output: launched monitor or reuse of its fresh presence marker.
 */
async function openEvolutionMonitor() {
  if (monitorLaunching) return monitorLaunching;
  monitorLaunching = (async () => {
    const presence = await readJson(join(monitorStore.root, "presence.json"), {});
    if (presence.version === app.getVersion() && Date.now() - (presence.updatedAt || 0) < 7000) return;
    await launchDesktop(process.execPath, ["--cleo-evolution-monitor", `--user-data-dir=${app.getPath("userData")}`],
      { ...process.env, CLEO_HOME: evolution.store.dataHome, CLEO_EVOLUTION_CHILD: "1" });
  })();
  try { await monitorLaunching; } finally { monitorLaunching = null; }
}
/** Purpose: Publish progress without giving the monitor write access to version state.
 * Input: current app state. Output: a bounded, restart-independent status record.
 */
async function publishMonitor() {
  const state = await evolution.status();
  await monitorStore.publish({ version: app.getVersion(), protocol: 2, uiLanguage: getLanguage(), threadId: editingThread || state.threadId,
    phase: editingThread ? tr("main.the_agent_is_editing") : state.phase === "idle" ? tr("main.conversation_ready") : tr("main.checking_or_preparing_a_version"),
    detail: editingDetail || state.validation?.message || tr("main.you_can_continue_chatting_click_check_changes_when_you_are_ready_to_try_them"),
    logs: (state.logs || "").slice(-12000), thread: companion.snapshot(),
    actions: { ...evolutionActions(state), running: Boolean(editingThread) },
    paused: await monitorStore.paused(), running: Boolean(editingThread) });
  if (companion.thread && companion.turnTask) companion.notify(companion.thread);
}

const releaseJobs = new ReleaseJobs(evolutionRoot, new GithubReleaseDriver(evolution, {
  runtime: async () => backend.request("release_runtime", { thread_id: (await evolution.store.read()).threadId }),
  repair: (request, signal) => runReleaseRepair(backend, request, signal),
}), { onChange: () => {
  void evolutionState().then(state => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("cleo:evolution:state", state);
    }
  }).catch(error => console.error("Release progress:", error.message));
} });

async function evolutionState() {
  const state = await evolution.status();
  const job = await releaseJobs.status();
  return { ...state, releases: updater.catalog.length ? updater.catalog : state.releases,
    releaseJob: job ? { id: job.id, tag: job.tag, phase: job.phase, message: job.message,
      error: job.error, workflowUrl: job.workflowUrl, releaseUrl: job.releaseUrl } : null,
    releaseTypes: Object.fromEntries(updater.catalog.map(item => [item.tag, item.prerelease])),
    acceptance: undefined, acceptanceRequests: [], suggestedVersionName: nextVersionName(state) };
}

/** Purpose: Hand off activation after explicit consent. Input: build id; current user data is always retained. Output: app restart. */
async function applyEvolution(id) {
  if (backend.pending.size) throw new Error(tr("main.wait_for_the_current_task_to_finish_or_stop_it_before_applying_changes"));
  const state = await evolution.store.read();
  if (state.active === id) return true;
  await openEvolutionMonitor();
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
  programUpdates.beginRestart();
  app.quit();
  return Boolean(tx);
}

/** Purpose: Release harness processes before archiving their source workspace.
 * Input: chosen version or discard intent. Output: restart into the chosen program, or a resumed backend on failure.
 */
async function changeEvolutionBase(id, discard = false) {
  await backend.close();
  try {
    const target = discard ? id ? await evolution.selectVersion(id, true) : await evolution.discardIteration() : await evolution.selectVersion(id);
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

/** Purpose: Deliver one ordinary or queued turn without automatic case generation or builds.
 * Input: validated IPC turn. Output: streamed events and durable delivery receipt.
 */
async function monitoredEvolutionTurn(params, onEvent) {
  const queued = await monitorStore.message(params.run_id);
  if (queued) {
    if (queued.threadId !== params.thread_id || queued.body !== params.prompt) throw new Error(tr("main.the_additional_message_does_not_match_the_conversation"));
    if (!(await monitorStore.messages()).some(item => item.id === queued.id && item.status === "queued"))
      throw new Error(tr("evolution_monitor_store.this_message_was_already_submitted_check_the_conversation_first_to_avoid_executing_it"));
    await monitorStore.claim(queued.id);
  }
  let completed = false;
  let failed = false;
  editingThread = params.thread_id;
  computer.broker.turnStarted(params.thread_id, params.run_id);
  editingDetail = tr("main.you_can_keep_sending_additional_messages_answer_any_tradeoff_questions_in_the_convers");
  try {
    await companion.load(params.thread_id).catch(error => console.error("Companion history:", error.message));
    if (companion.thread?.id === params.thread_id) { companion.thread.status = "running"; companion.thread.activeRunId = params.run_id; }
    await publishMonitor().catch(error => console.error("Evolution monitor:", error.message));
    await openEvolutionMonitor().catch(error => console.error("Evolution monitor:", error.message));
    return await runEvolutionTurn({ evolution, backend, params, onEvent: event => {
      companion.event(params.thread_id, event);
      if (event.type === "done") completed = true;
      if (event.type === "error") failed = true;
      if (event.type === "question-request") editingDetail = tr("main.the_agent_is_asking_about_a_tradeoff_answer_here_or_in_the_cleo_conversation");
      onEvent(event);
    } });
  } catch (error) { failed = true; throw error; }
  finally {
    if (queued) await monitorStore.receipt(queued.id, completed && !failed ? "completed" : "interrupted");
    await companion.load(params.thread_id).catch(error => console.error("Companion history:", error.message));
    editingThread = null; editingDetail = "";
    computer.broker.turnEnded(params.thread_id);
    await publishMonitor().catch(error => console.error("Evolution monitor:", error.message));
  }
}

const allowedMethods = new Set([
  "get_ui_language",
  "set_ui_language",
  "load_workspace",
  "load_memory",
  "open_evolution_thread",
  "load_thread",
  "create_thread",
  "delete_thread",
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
  "get_runtime_catalog",
  "get_config_status",
  "get_productivity_models",
  "get_local_skills",
  "get_harness_sync",
  "sync_harness_items",
  "save_model_profile",
  "save_dream_settings",
  "get_background_memory_state",
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
    && evolution.phase === "idle" && !editingThread && backend.pending.size === 0,
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
      if (backend.pending.size || evolution.phase !== "idle" || programUpdates.busy) throw new Error(tr("main.wait_for_current_tasks_and_version_operations_to_finish"));
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
    if (process.platform !== "win32" && process.platform !== "linux") return;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    window.setTitleBarOverlay({
      color: theme === "light" ? "#e9e9e6" : "#0b0e12",
      symbolColor: theme === "light" ? "#59636f" : "#848c98",
    });
  });
  ipcMain.handle("cleo:request", async (event, payload) => {
    if (programUpdates.closed) throw new Error(tr("main.cleo_is_shutting_down_try_again_later"));
    const method = String(payload?.method || "");
    if (!allowedMethods.has(method)) throw new Error(`Unsupported desktop method: ${method}`);
    const streamId = payload?.streamId ? String(payload.streamId) : null;
    const controlsRun = method === "stream_turn" || method === "steer_run";
    if (controlsRun && (programUpdates.blocksTasks || setup.busy || companion.controlling)) {
      throw new Error(tr("main.wait_for_the_evolution_operation_to_finish_before_editing_code"));
    }
    const params = payload?.params || {};
    const onEvent = (streamEvent) => {
      if (streamId && !event.sender.isDestroyed()) {
        event.sender.send("cleo:stream-event", { streamId, event: streamEvent });
      }
    };
    if (programUpdates.closed) throw new Error(tr("main.cleo_is_shutting_down_try_again_later"));
    const isEvolution = controlsRun && await backend.request("is_evolution_thread", { thread_id: params.thread_id });
    if (programUpdates.closed) throw new Error(tr("main.cleo_is_shutting_down_try_again_later"));
    const tracksTurn = method === "stream_turn" && !isEvolution && typeof params.thread_id === "string";
    if (controlsRun) {
      const transaction = (await evolution.store.read()).transaction;
      if (programUpdates.blocksTasks || transaction || (evolution.phase !== "idle" && (!evolution.readOnlyOperation || isEvolution)))
        throw new Error(tr("main.wait_for_the_current_version_operation_to_finish"));
    }
    if (isEvolution && programUpdates.busy) throw new Error(tr("main.wait_for_the_current_version_operation_to_finish"));
    if (tracksTurn) computer.broker.turnStarted(params.thread_id, params.run_id);
    let result;
    try {
      result = isEvolution && method === "stream_turn"
        ? await monitoredEvolutionTurn(params, onEvent)
        : await backend.request(method, params, onEvent);
    } finally {
      // Queued computer actions of a finished turn must never run in a later one.
      if (tracksTurn) computer.broker.turnEnded(params.thread_id);
    }
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
    // Backends without hot reload (older versions selected by evolution) still need a restart.
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
    return attachmentsFromPaths(result.filePaths);
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
    return [...pathAttachments, ...inlineAttachments];
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
  ipcMain.handle("cleo:evolution:state", () => evolutionState());
  ipcMain.handle("cleo:evolution:action", async (_event, payload) => {
    const { action, ...params } = payload || {};
    if (setup.busy && !["monitor", "nextMessage"].includes(action)) throw new Error(tr("main.wait_for_dependency_installation_to_finish"));
    if (backend.pending.size && action === "contributionRepairPrompt")
      throw new Error(tr("main.wait_for_the_current_task_to_finish_or_stop_it_before_checking_the_merge"));
    if (backend.pending.size && ["prepare", "build", "merge", "submit", "apply", "recovery", "select", "discard", "save", "begin", "repairPrompt", "requestBranch", "refreshBranchRequest"].includes(action)) {
      throw new Error(tr("main.wait_for_the_current_task_to_finish_or_stop_it"));
    }
    const actions = {
      prepare: () => evolution.prepare(),
      begin: () => evolution.begin(),
      // A blank name uses the previous version number with its last digit incremented.
      save: async () => evolution.saveVersion(String(params.name || "").trim() || nextVersionName(await evolution.status())),
      select: () => changeEvolutionBase(params.id),
      discard: () => changeEvolutionBase(null, true),
      build: async () => { await openEvolutionMonitor(); return evolution.build(); },
      monitor: () => openEvolutionMonitor(),
      nextMessage: () => monitorStore.pending(params.threadId),
      repairPrompt: async () => {
        const state = await evolution.store.read();
        if (state.lastRestartError) return sourceText("main.the_previous_application_failed_to_start_investigate_and_fix_startup_in_the_cleo_sour") + state.lastRestartError;
        return (await evolution.repairPrompt()).replace(sourceText("main.the_desktop_app_will_run_checks_again_after_this_turn"), sourceText("main.after_the_fix_the_user_chooses_when_to_check_changes"));
      },
      releases: async () => {
        await updater.refreshCatalog();
        return updater.catalog;
      },
      selectUpdate: async () => {
        updater.select(params.tag);
        const state = await updater.check();
        if (state.phase === "error") throw new Error(state.error);
        return state;
      },
      download: async () => {
        updater.select(params.tag);
        const checked = await updater.check();
        if (checked.phase === "error") throw new Error(checked.error);
        const downloaded = await updater.download();
        if (downloaded.phase !== "ready") throw new Error(downloaded.error || tr("main.download_and_verify_the_selected_version_first"));
        return prepareSelectedRelease(evolution, updater, params.tag);
      },
      merge: () => evolution.mergeRelease(params.tag),
      login: async () => {
        const auth = await evolution.login();
        if (auth?.status === "connected") await checkReleasePermission(evolution);
        return evolution.githubAuth;
      },
      releasePermission: () => checkReleasePermission(evolution),
      previewRelease: () => previewRelease(evolution, params),
      publishRelease: () => publishRelease(evolution, params),
      publishMergedRelease: () => publishMergedRelease(evolution, params),
      startRelease: () => releaseJobs.start(params),
      retryRelease: () => releaseJobs.resume(true),
      cancelRelease: () => releaseJobs.cancel(),
      previewMergedRelease: () => previewMergedRelease(evolution, params),
      releaseBuilds: () => releaseBuilds(evolution, params),
      publishReleasePackages: () => publishReleasePackages(evolution, params),
      releasePackageStatus: () => releasePackageStatus(evolution, params),
      openGithubLogin: () => evolution.openGithubLogin(),
      cancelLogin: () => evolution.cancelLogin(),
      submit: () => submitContribution(evolution, params.title, params.body, params.submissionId, params),
      checkContribution: () => checkContribution(evolution, params),
      mergeAssistance: () => inspectPullRequest(evolution, params.url),
      contributionRepairPrompt: () => contributionRepairPrompt(evolution, params),
      contributionBranches: () => listContributionBranches(evolution),
      requestBranch: () => requestTargetBranch(evolution, params),
      refreshBranchRequest: () => refreshTargetBranch(evolution, params.id),
      pullRequest: () => evolution.refreshPullRequest(params.url),
      apply: () => applyEvolution(params.id),
      thread: () => evolution.operation("preparing", () => evolution.store.update({ threadId: String(params.id || "") })),
      recovery: async () => {
        await evolution.operation("preparing", () => evolution.ensureBaseline());
        const selected = await showRecovery(evolution.store, { selectOnly: true, parentWindow: BrowserWindow.fromWebContents(_event.sender) });
        if (selected) return applyEvolution(selected);
      },
    };
    if (!Object.hasOwn(actions, action)) throw new Error(tr("evolution_companion.unsupported_evolution_action"));
    if (programUpdates.closed) throw new Error(tr("main.cleo_is_shutting_down_try_again_later"));
    if (["startRelease", "retryRelease", "cancelRelease", "cancelLogin", "openGithubLogin", "monitor", "nextMessage"].includes(action)) return actions[action]();
    return programUpdates.run(actions[action], {
      allowRunning: ["releases", "download", "pullRequest", "releasePermission", "previewMergedRelease", "contributionBranches", "checkContribution", "mergeAssistance"].includes(action),
    });
  });
  if (!app.isPackaged) ipcMain.handle("cleo:evolution:healthy", () => {});
  // Downloaded updates never authorize installation. Selection is explicit and recoverable.
  try { backend.runtime = await dependencies.prepare(); }
  catch (error) { updater.setState({ dependencies: { phase: "error", error: error.message } }); }
  setup.python = process.env.CLEO_PYTHON || backend.runtimePaths().python || (process.platform === "win32" ? "python" : "python3");
  void releaseJobs.resume().catch(error => console.error("Release resume:", error.message));
  desktopTray.start();
  createWindow();
  backgroundMemory.start();
  void evolution.store.read().then(state => companion.load(state.threadId)).catch(error => console.error("Companion history:", error.message));
  const monitorTimer = setInterval(() => {
    void publishMonitor().catch(error => console.error("Evolution monitor:", error.message));
    void companion.tick().catch(error => console.error("Companion delivery:", error.message));
  }, 1000);
  app.once("will-quit", () => clearInterval(monitorTimer));
  // External setup and internal runtime updates require a user-approved setup action.
  const refresh = () => programUpdates.check().catch((error) => console.error("Update check:", error.message));
  if (!process.env.CLEO_EVOLUTION_TRANSACTION) setTimeout(() => void refresh(), 1500);
  const refreshTimer = setInterval(() => void refresh(), 6 * 60 * 60 * 1000);
  app.once("will-quit", () => clearInterval(refreshTimer));
});

app.on("before-quit", createQuitBarrier({
  close: [() => backgroundMemory.stop(), () => setup.close(), () => computer.close(), () => releaseJobs.close(), () => programUpdates.close(), () => backend.shutdown(), () => dependencies.close(),
    () => releaseDownloads.close(), () => evolution.close(), () => evolution.cancelLogin()],
  onError: error => console.error("Cleo shutdown failed:", error),
  quit: () => app.quit(),
}));

}
