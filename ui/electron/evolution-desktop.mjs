import { sourceText, t as tr, getLanguage } from "./i18n.mjs";
import { app, BrowserWindow, nativeTheme, shell } from "electron";
import { join } from "node:path";
import { configureReleaseChannel } from "./release-channel.mjs";
import { launchDesktop } from "./program-launch.mjs";
import { showRecovery } from "./program-recovery.mjs";
import { readJson } from "./program-store.mjs";
import { prepareSelectedRelease } from "./selectable-updates.mjs";
import { EvolutionManager } from "./evolution.mjs";
import { listContributionBranches, requestTargetBranch, refreshTargetBranch } from "./evolution-contributions.mjs";
import { checkContribution, submitContribution, inspectPullRequest, contributionRepairPrompt } from "./evolution-merge-assistance.mjs";
import { runEvolutionTurn } from "./evolution-editing.mjs";
import { checkReleasePermission, previewRelease, publishRelease, publishMergedRelease, previewMergedRelease } from "./github-releases.mjs";
import { releaseBuilds, publishReleasePackages, releasePackageStatus } from "./release-packages.mjs";
import { ReleaseJobs } from "./release-jobs.mjs";
import { GithubReleaseDriver } from "./release-driver.mjs";
import { runReleaseRepair } from "./release-repair.mjs";
import { startEvolutionMonitor } from "./evolution-monitor.mjs";
import { EvolutionMonitorStore } from "./evolution-monitor-store.mjs";
import { needsEvolutionMonitor } from "./evolution-monitor-lifecycle.mjs";
import { EvolutionCompanion } from "./evolution-companion.mjs";
import { evolutionActions, nextVersionName } from "./evolution-actions.mjs";

/** Purpose: Run the companion window in its own process, wearing the theme the main window handed over. */
export async function runEvolutionMonitorProcess() {
  configureReleaseChannel(app);
  const theme = process.argv.find((argument) => argument.startsWith("--cleo-theme="))?.slice("--cleo-theme=".length);
  if (theme === "light" || theme === "dark") nativeTheme.themeSource = theme;
  await startEvolutionMonitor();
}

/** Purpose: Own everything local evolution adds to the main process, behind one seam.
 * Input: the control directory, shared desktop services and the version-switch entry point.
 * Output: the version manager plus the hooks the main process calls; removing evolution removes this module.
 */
export function createEvolutionDesktop({ controlRoot, backend, computer, downloads, updater, onVersionsState,
  programUpdates, setup, applyVersion, windowTheme, mainInteractive }) {
  const broadcast = (channel, payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  };
  const evolution = new EvolutionManager({
    app, root: controlRoot, dataHome: backend.runtimePaths().cleoHome,
    downloads,
    openExternal: (url) => shell.openExternal(url),
    onState: () => {
      onVersionsState();
      void evolutionState().then((state) => broadcast("cleo:evolution:state", state))
        .catch((error) => console.error("Evolution status:", error.message));
    },
  });
  process.env.CLEO_EVOLUTION_WORKSPACE = evolution.source;

  const monitorStore = new EvolutionMonitorStore(controlRoot);
  let monitorLaunching = null;
  let editingThread = null;
  let editingDetail = "";
  const companion = new EvolutionCompanion({ store: monitorStore, backend, evolution,
    ready: () => !editingThread && !backend.pending.size && !setup().busy && !programUpdates().busy && !programUpdates().closed && evolution.phase === "idle",
    turn: params => monitoredEvolutionTurn(params, () => {}),
    stop: async threadId => {
      if (evolution.operationAbort) evolution.operationAbort.abort(new Error(tr("main.the_user_stopped_evolution_checks")));
      if (threadId) await backend.request("cancel_run", { thread_id: threadId });
      for (let attempt = 0; attempt < 100 && (editingThread || evolution.phase !== "idle"); attempt++)
        await new Promise(resolve => setTimeout(resolve, 100));
      if (editingThread || evolution.phase !== "idle") throw new Error(tr("main.the_task_has_not_stopped_yet_retry_recovery_later"));
    },
    discard: () => programUpdates().run(() => changeEvolutionBase(null, true)),
    rollback: id => programUpdates().run(() => changeEvolutionBase(id, true)),
    build: () => programUpdates().run(() => evolution.build()),
    apply: id => programUpdates().run(() => applyVersion(id)),
    save: name => programUpdates().run(() => evolution.saveVersion(name)),
    notify: thread => broadcast("cleo:companion-thread", thread),
  });

  /** Purpose: Reuse a companion only while an Evolution restart makes the main UI unavailable.
   * Input: durable handoff state. Output: one monitor or no window during normal work.
   */
  async function openEvolutionMonitor() {
    if (!needsEvolutionMonitor(await evolution.store.read())) return;
    if (monitorLaunching) return monitorLaunching;
    monitorLaunching = (async () => {
      const presence = await readJson(join(monitorStore.root, "presence.json"), {});
      if (presence.version === app.getVersion() && Date.now() - (presence.updatedAt || 0) < 7000) return;
      await launchDesktop(process.execPath, ["--cleo-evolution-monitor", `--user-data-dir=${app.getPath("userData")}`,
        ...(windowTheme() ? [`--cleo-theme=${windowTheme()}`] : [])],
        { ...process.env, CLEO_HOME: evolution.store.dataHome, CLEO_EVOLUTION_CHILD: "1" });
    })();
    try { await monitorLaunching; } finally { monitorLaunching = null; }
  }

  /** Purpose: Publish progress without giving the monitor write access to version state.
   * Input: current app state. Output: a bounded, restart-independent status record.
   */
  async function publishMonitor() {
    const state = await evolution.status();
    await monitorStore.publish({ version: app.getVersion(), protocol: 2, uiLanguage: getLanguage(), active: state.active, mainInteractive: mainInteractive(), threadId: editingThread || state.threadId,
      phase: editingThread ? tr("main.the_agent_is_editing") : state.phase === "idle" ? tr("main.conversation_ready") : tr("main.checking_or_preparing_a_version"),
      detail: editingDetail || state.validation?.message || tr("main.you_can_continue_chatting_click_check_changes_when_you_are_ready_to_try_them"),
      logs: (state.logs || "").slice(-12000), thread: companion.snapshot(),
      actions: { ...evolutionActions(state), running: Boolean(editingThread) },
      paused: await monitorStore.paused(), running: Boolean(editingThread) });
    if (companion.thread && companion.turnTask) companion.notify(companion.thread);
  }

  const releaseJobs = new ReleaseJobs(controlRoot, new GithubReleaseDriver(evolution, {
    runtime: async () => backend.request("release_runtime", { thread_id: (await evolution.store.read()).threadId }),
    repair: (request, signal) => runReleaseRepair(backend, request, signal),
  }), { onChange: () => {
    void evolutionState().then(state => broadcast("cleo:evolution:state", state))
      .catch(error => console.error("Release progress:", error.message));
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
      return await applyVersion(target);
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

  /** Purpose: Route one renderer-requested evolution action.
   * Input: IPC event and `{ action, ...params }`. Output: the action's result, serialized with version operations.
   */
  async function evolutionAction(event, payload) {
    const { action, ...params } = payload || {};
    if (setup().busy && !["monitor", "nextMessage"].includes(action)) throw new Error(tr("main.wait_for_dependency_installation_to_finish"));
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
      build: () => evolution.build(),
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
      apply: () => applyVersion(params.id),
      thread: () => evolution.operation("preparing", () => evolution.store.update({ threadId: String(params.id || "") })),
      recovery: async () => {
        await evolution.operation("preparing", () => evolution.ensureBaseline());
        const selected = await showRecovery(evolution.store, { selectOnly: true, parentWindow: BrowserWindow.fromWebContents(event.sender) });
        if (selected) return applyVersion(selected);
      },
    };
    if (!Object.hasOwn(actions, action)) throw new Error(tr("evolution_companion.unsupported_evolution_action"));
    if (programUpdates().closed) throw new Error(tr("main.cleo_is_shutting_down_try_again_later"));
    if (["startRelease", "retryRelease", "cancelRelease", "cancelLogin", "openGithubLogin", "monitor", "nextMessage"].includes(action)) return actions[action]();
    return programUpdates().run(actions[action], {
      allowRunning: ["releases", "download", "pullRequest", "releasePermission", "previewMergedRelease", "contributionBranches", "checkContribution", "mergeAssistance"].includes(action),
    });
  }

  return {
    /** The version manager; evolution extends it with editing, checks and contributions. */
    versions: evolution,
    /** True while an evolution turn is editing the managed source. */
    get editing() { return Boolean(editingThread); },
    /** True while the companion window is executing a control. */
    get controlling() { return companion.controlling; },
    /** Input: thread id. Output: whether its turns belong to the managed source workspace. */
    ownsThread: threadId => backend.request("is_evolution_thread", { thread_id: threadId }),
    turn: monitoredEvolutionTurn,
    openMonitor: openEvolutionMonitor,
    state: evolutionState,
    action: evolutionAction,
    /** Purpose: Resume durable work once the main window exists. Output: a timer the caller clears at quit. */
    start() {
      void releaseJobs.resume().catch(error => console.error("Release resume:", error.message));
      void evolution.store.read().then(state => companion.load(state.threadId)).catch(error => console.error("Companion history:", error.message));
      return setInterval(() => {
        void publishMonitor().catch(error => console.error("Evolution monitor:", error.message));
        void companion.tick().catch(error => console.error("Companion delivery:", error.message));
      }, 1000);
    },
    closeReleases: () => releaseJobs.close(),
    cancelLogin: () => evolution.cancelLogin(),
  };
}
