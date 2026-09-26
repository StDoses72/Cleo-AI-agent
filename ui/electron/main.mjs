import { randomUUID } from "node:crypto";
import { launchDesktop } from "./evolution-launch.mjs";
import { waitForControllerReady, showRecovery } from "./evolution-recovery.mjs";
import { EvolutionManager } from "./evolution.mjs";
import { listContributionBranches, requestTargetBranch, refreshTargetBranch } from "./evolution-contributions.mjs";
import { checkContribution, submitContribution, inspectPullRequest, contributionRepairPrompt } from "./evolution-merge-assistance.mjs";
import { runEvolutionTurn } from "./evolution-editing.mjs";
import { rmSync } from "node:fs";
import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, shell } from "electron";
import { trustedPreviewSender } from "./computer-preview.mjs";
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
import { DependencyUpdater } from "./dependencies.mjs";
import {
  acquireSingleInstance, installationPaths, interceptUpdateStartup,
} from "./install-state.mjs";

import { SetupManager } from "./setup-manager.mjs";
import { startEvolutionMonitor } from "./evolution-monitor.mjs";
import { EvolutionMonitorStore } from "./evolution-monitor-store.mjs";
import { EvolutionCompanion } from "./evolution-companion.mjs";
import { evolutionActions, nextVersionName } from "./evolution-actions.mjs";
import { readJson } from "./evolution-store.mjs";

if (process.argv.includes("--cleo-evolution-monitor")) {
  configureReleaseChannel(app);
  await startEvolutionMonitor();
} else {
const here = dirname(fileURLToPath(import.meta.url));
const alphaChannel = configureReleaseChannel(app);
if (app.isPackaged) {
  if (process.platform === "win32") {
    const paths = installationPaths(app.getPath("temp"), process.execPath);
    if (await interceptUpdateStartup(paths)) app.exit(0);
  }
  if (!acquireSingleInstance(app, () => BrowserWindow.getAllWindows())) app.exit(0);
}
const backend = new BackendBridge({ app, here });
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
app.on("cleo:healthy", (transactionId) => {
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
  desktop: action => backend.request("computer_desktop", { action, target: "isolated" }),
  repairRuntime: async () => {
    if (!dependencies.runtime) throw new Error("随应用安装的运行环境无法启动，请重新安装 Cleo 后重试。");
    await dependencies.check();
    const result = await readJson(join(dependencies.root, "state.json"), {});
    if (result.phase === "error" || updater.getState().dependencies?.phase === "error")
      throw new Error(result.error || updater.getState().dependencies.error || "运行环境修复尚未完成。");
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
    if (evolution.operationAbort) evolution.operationAbort.abort(new Error("用户已停止进化检查。"));
    if (threadId) await backend.request("cancel_run", { thread_id: threadId });
    for (let attempt = 0; attempt < 100 && (editingThread || evolution.phase !== "idle"); attempt++)
      await new Promise(resolve => setTimeout(resolve, 100));
    if (editingThread || evolution.phase !== "idle") throw new Error("任务尚未停止，请稍后重试恢复操作。");
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
  await monitorStore.publish({ version: app.getVersion(), protocol: 2, threadId: editingThread || state.threadId,
    phase: editingThread ? "agent 正在修改" : state.phase === "idle" ? "会话就绪" : "正在检查或准备版本",
    detail: editingDetail || state.validation?.message || "可以继续聊天，准备体验时点击检查改动。",
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
  if (backend.pending.size) throw new Error("请先等待当前任务完成或停止任务，再应用改动。");
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
    if (queued.threadId !== params.thread_id || queued.body !== params.prompt) throw new Error("补充消息与会话不匹配。");
    if (!(await monitorStore.messages()).some(item => item.id === queued.id && item.status === "queued"))
      throw new Error("此消息已经提交，请先核对会话，避免重复执行。");
    await monitorStore.claim(queued.id);
  }
  let completed = false;
  let failed = false;
  editingThread = params.thread_id;
  editingDetail = "用户补充可以继续发送；有取舍问题时请在会话中回答。";
  try {
    await companion.load(params.thread_id).catch(error => console.error("Companion history:", error.message));
    if (companion.thread?.id === params.thread_id) { companion.thread.status = "running"; companion.thread.activeRunId = params.run_id; }
    await publishMonitor().catch(error => console.error("Evolution monitor:", error.message));
    await openEvolutionMonitor().catch(error => console.error("Evolution monitor:", error.message));
    return await runEvolutionTurn({ evolution, backend, params, onEvent: event => {
      companion.event(params.thread_id, event);
      if (event.type === "done") completed = true;
      if (event.type === "error") failed = true;
      if (event.type === "question-request") editingDetail = "agent 正在询问取舍，可在此窗口或 Cleo 会话中回答。";
      onEvent(event);
    } });
  } catch (error) { failed = true; throw error; }
  finally {
    if (queued) await monitorStore.receipt(queued.id, completed && !failed ? "completed" : "interrupted");
    await companion.load(params.thread_id).catch(error => console.error("Companion history:", error.message));
    editingThread = null; editingDetail = "";
    await publishMonitor().catch(error => console.error("Evolution monitor:", error.message));
  }
}

const allowedMethods = new Set([
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
  "get_productivity_models",
  "get_local_skills",
  "get_harness_sync",
  "sync_harness_items",
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

app.setAppUserModelId(alphaChannel ? "ai.cleo.desktop.alpha" : "ai.cleo.desktop");
app.whenReady().then(async () => {
  ipcMain.handle("cleo:setup", async (event, action, params = {}) => {
    if (!trustedPreviewSender(event, pathToFileURL(join(here, "../dist/index.html")).href)) throw new Error("请在 Cleo 主窗口管理依赖。");
    if (action === "status") return setup.state();
    if (action === "startup") return setup.startup();
    if (action === "scan") return setup.scan();
    if (action === "dismiss") return setup.dismiss();
    if (action === "install") {
      if (backend.pending.size || evolution.phase !== "idle" || programUpdates.busy) throw new Error("请先等待任务及版本操作完成。");
      return setup.install(params.ids, params.consent);
    }
    throw new Error("未知依赖操作。");
  });
  ipcMain.handle("cleo:computer-desktop", (event, action = "status", text = "") => {
    if (!trustedPreviewSender(event, pathToFileURL(join(here, "../dist/index.html")).href)) {
      throw new Error("独立桌面仅供 Cleo 主窗口使用。");
    }
    return backend.request("computer_desktop", { action, text });
  });
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
    if (programUpdates.closed) throw new Error("Cleo 正在退出，请稍后重试。");
    const method = String(payload?.method || "");
    if (!allowedMethods.has(method)) throw new Error(`Unsupported desktop method: ${method}`);
    const streamId = payload?.streamId ? String(payload.streamId) : null;
    const controlsRun = method === "stream_turn" || method === "steer_run";
    if (controlsRun && (programUpdates.blocksTasks || setup.busy || companion.controlling)) {
      throw new Error("请等待进化操作完成后再修改代码。");
    }
    const params = payload?.params || {};
    const onEvent = (streamEvent) => {
      if (streamId && !event.sender.isDestroyed()) {
        event.sender.send("cleo:stream-event", { streamId, event: streamEvent });
      }
    };
    if (programUpdates.closed) throw new Error("Cleo 正在退出，请稍后重试。");
    const isEvolution = controlsRun && await backend.request("is_evolution_thread", { thread_id: params.thread_id });
    if (programUpdates.closed) throw new Error("Cleo 正在退出，请稍后重试。");
    if (controlsRun) {
      const transaction = (await evolution.store.read()).transaction;
      if (programUpdates.blocksTasks || transaction || (evolution.phase !== "idle" && (!evolution.readOnlyOperation || isEvolution)))
        throw new Error("请等待当前版本操作完成。");
    }
    if (isEvolution && programUpdates.busy) throw new Error("请等待当前版本操作完成。");
    const result = isEvolution && method === "stream_turn"
      ? await monitoredEvolutionTurn(params, onEvent)
      : await backend.request(method, params, onEvent);
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
  ipcMain.handle("cleo:pick-workspace", async (event) => {
    const options = {
      title: "选择或新建项目文件夹",
      buttonLabel: "用作工作区",
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
        error: error instanceof Error ? error.message : "无法打开本地文件",
      };
    }
  });
  ipcMain.handle("cleo:update:get-state", () => updater.getState());
  ipcMain.handle("cleo:update:check", (_event, tag) => programUpdates.check(tag));
  ipcMain.handle("cleo:update:download", () => programUpdates.download());
  ipcMain.handle("cleo:update:install", () => programUpdates.install());
  ipcMain.handle("cleo:evolution:state", () => evolutionState());
  ipcMain.handle("cleo:evolution:action", async (_event, payload) => {
    const { action, ...params } = payload || {};
    if (setup.busy && !["monitor", "nextMessage"].includes(action)) throw new Error("请等待依赖安装完成。");
    if (backend.pending.size && action === "contributionRepairPrompt")
      throw new Error("请先等待当前任务完成或停止任务，再检查合并。");
    if (backend.pending.size && ["prepare", "build", "merge", "submit", "apply", "recovery", "select", "discard", "save", "begin", "repairPrompt", "requestBranch", "refreshBranchRequest"].includes(action)) {
      throw new Error("请先等待当前任务完成或停止任务。");
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
        if (state.lastRestartError) return "上次应用未能正常启动，请在 Cleo 源码工作区调查并修复启动问题。保留用户数据和恢复控制器，不要自行重启。诊断数据：\n" + state.lastRestartError;
        return (await evolution.repairPrompt()).replace("桌面会在本轮结束后重新检查。", "修复后由用户选择检查改动。");
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
        if (downloaded.phase !== "ready") throw new Error(downloaded.error || "请先下载并校验所选版本。");
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
    if (!Object.hasOwn(actions, action)) throw new Error("不支持的进化操作。");
    if (programUpdates.closed) throw new Error("Cleo 正在退出，请稍后重试。");
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
  const hasInstallResult = await updater.restoreInstallationResult();
  createWindow();
  void evolution.store.read().then(state => companion.load(state.threadId)).catch(error => console.error("Companion history:", error.message));
  const monitorTimer = setInterval(() => {
    void publishMonitor().catch(error => console.error("Evolution monitor:", error.message));
    void companion.tick().catch(error => console.error("Companion delivery:", error.message));
  }, 1000);
  app.once("will-quit", () => clearInterval(monitorTimer));
  // External setup and internal runtime updates require a user-approved setup action.
  const installResult = await updater.takeInstallResult();
  if (installResult) {
    void dialog.showMessageBox({
      type: installResult.status === "installed" ? "info" : "error",
      message: installResult.status === "installed" ? `Cleo 已更新至 ${installResult.version}` : "Cleo 更新未完成",
      detail: installResult.error || "新版本已安装完成。",
    });
  }
  const refresh = () => programUpdates.check().catch((error) => console.error("Update check:", error.message));
  if (!hasInstallResult && !process.env.CLEO_EVOLUTION_TRANSACTION) setTimeout(() => void refresh(), 1500);
  const refreshTimer = setInterval(() => void refresh(), 6 * 60 * 60 * 1000);
  app.once("will-quit", () => clearInterval(refreshTimer));
  app.on("activate", () => {
    if (!programUpdates.closed && BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", createQuitBarrier({
  close: [() => setup.close(), () => releaseJobs.close(), () => programUpdates.close(), () => backend.shutdown(), () => dependencies.close(),
    () => releaseDownloads.close(), () => evolution.close(), () => evolution.cancelLogin()],
  onError: error => console.error("Cleo shutdown failed:", error),
  quit: () => app.quit(),
}));

}
