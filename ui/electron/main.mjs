import { randomUUID } from "node:crypto";
import { launchDesktop } from "./evolution-launch.mjs";
import { waitForControllerReady, showRecovery } from "./evolution-recovery.mjs";
import { EvolutionManager } from "./evolution.mjs";
import { listContributionBranches, requestTargetBranch, refreshTargetBranch } from "./evolution-contributions.mjs";
import { checkContribution, submitContribution, inspectPullRequest, contributionRepairPrompt } from "./evolution-merge-assistance.mjs";
import { EvolutionAcceptance } from "./evolution-acceptance.mjs";
import { requireApplicable, reviewApplied } from "./evolution-behavior-policy.mjs";
import { EvolutionRequests } from "./evolution-requests.mjs";
import { compareBuiltVersion, runPreparedEvolutionTurn } from "./evolution-editing.mjs";
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
  hasRunningTask: () => backend.pending.size > 0 });
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
const acceptance = new EvolutionAcceptance(evolution.store);
const acceptanceRequests = new EvolutionRequests(acceptance,
  (threadId, request, existing_cases) => backend.request("analyze_evolution_request", { thread_id: threadId, request, existing_cases }),
  () => { void evolutionState().then((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("cleo:evolution:state", state);
    }
  }).catch((error) => console.error("Acceptance preparation:", error.message)); });

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
    acceptance: await acceptance.status(state), acceptanceRequests: await acceptanceRequests.status() };
}

/** Purpose: Hand off activation after explicit consent. Input: build id; current user data is always retained. Output: app restart. */
async function applyEvolution(id) {
  if (backend.pending.size) throw new Error("请先等待当前任务完成或停止任务，再应用改动。");
  const state = await evolution.store.read();
  if (state.active === id) return true;
  await requireApplicable(acceptance, id);
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
    if (programUpdates.closed) throw new Error("Cleo 正在退出，请稍后重试。");
    const method = String(payload?.method || "");
    if (!allowedMethods.has(method)) throw new Error(`Unsupported desktop method: ${method}`);
    const streamId = payload?.streamId ? String(payload.streamId) : null;
    const controlsRun = method === "stream_turn" || method === "steer_run";
    if (controlsRun && programUpdates.blocksTasks) {
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
      ? await runPreparedEvolutionTurn({ evolution, requests: acceptanceRequests, acceptance, backend, params, onEvent })
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
  ipcMain.handle("cleo:update:check", (_event, tag) => programUpdates.check(tag));
  ipcMain.handle("cleo:update:download", () => programUpdates.download());
  ipcMain.handle("cleo:update:install", () => programUpdates.install());
  ipcMain.handle("cleo:evolution:state", () => evolutionState());
  ipcMain.handle("cleo:evolution:action", async (_event, payload) => {
    const { action, ...params } = payload || {};
    if (backend.pending.size && action === "contributionRepairPrompt")
      throw new Error("请先等待当前任务完成或停止任务，再检查合并。");
    if (backend.pending.size && ["prepare", "build", "merge", "submit", "apply", "recovery", "select", "discard", "save", "begin", "repairPrompt", "createCase", "archiveCase", "compareCases", "reviewCase", "prepareRequest", "repairRequest", "reviseRequest", "feedbackRequest", "completeCase", "cancelCase", "continueCaseRequest", "abandonRequest", "requestBranch", "refreshBranchRequest"].includes(action)) {
      throw new Error("请先等待当前任务完成或停止任务。");
    }
    const actions = {
      prepare: () => evolution.prepare(),
      begin: () => evolution.begin(),
      save: async () => { await acceptance.requirePassed((await evolution.store.read()).active); return evolution.saveVersion(params.name); },
      select: () => changeEvolutionBase(params.id),
      discard: () => changeEvolutionBase(null, true),
      build: async () => {
        const id = await evolution.build();
        await compareBuiltVersion(evolution, acceptance, id);
        return id;
      },
      createCase: () => evolution.operation("recording", () => acceptance.create(params)),
      prepareRequest: () => evolution.operation("planning", () => acceptanceRequests.prepare(params)),
      abandonRequest: () => evolution.operation("recording", async () => {
        const state = await evolution.store.read();
        const result = await acceptanceRequests.abandon({ threadId: params.threadId || state.threadId });
        if (result.threadId === state.threadId) await evolution.store.update({ threadId: null });
        return result;
      }),
      feedbackRequest: () => evolution.operation("planning", () => acceptanceRequests.feedback(params)),
      completeCase: () => evolution.operation("recording", () => acceptance.complete(params.id, params.note)),
      cancelCase: () => evolution.operation("recording", () => acceptance.cancel(params.id)),
      continueCaseRequest: () => evolution.operation("planning", () => acceptanceRequests.continueCase(params)),
      repairRequest: () => evolution.operation("planning", () => acceptanceRequests.repair(params)),
      reviseRequest: () => evolution.operation("planning", () => acceptanceRequests.revise(params)),
      requestPrompt: () => acceptanceRequests.editingPrompt(params.id),
      archiveCase: () => evolution.operation("recording", () => acceptance.archive(params.id)),
      compareCases: () => evolution.operation("comparing", async () => {
        const state = await evolution.store.read();
        return acceptance.compare(state.candidate || state.active);
      }),
      reviewCase: () => evolution.operation("recording", () => reviewApplied(acceptance, params.id, params.note)),
      casePrompt: () => acceptance.prompt(params.id),
      repairPrompt: () => evolution.repairPrompt(),
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
    if (["startRelease", "retryRelease", "cancelRelease", "cancelLogin", "openGithubLogin", "requestPrompt", "casePrompt"].includes(action)) return actions[action]();
    return programUpdates.run(actions[action], {
      allowRunning: ["releases", "download", "pullRequest", "releasePermission", "previewMergedRelease", "contributionBranches", "checkContribution", "mergeAssistance"].includes(action),
    });
  });
  if (!app.isPackaged) ipcMain.handle("cleo:evolution:healthy", () => {});
  // Downloaded updates never authorize installation. Selection is explicit and recoverable.
  backend.runtime = await dependencies.prepare();
  void releaseJobs.resume().catch(error => console.error("Release resume:", error.message));
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
  close: [() => releaseJobs.close(), () => programUpdates.close(), () => backend.shutdown(), () => dependencies.close(),
    () => releaseDownloads.close(), () => evolution.close(), () => evolution.cancelLogin()],
  onError: error => console.error("Cleo shutdown failed:", error),
  quit: () => app.quit(),
}));
