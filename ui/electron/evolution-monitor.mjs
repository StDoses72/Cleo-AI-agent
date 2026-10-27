import { t as tr, getLanguage, setLanguage } from "./i18n.mjs";
import { readUiLanguage } from "./language.mjs";
import { desktopDataHome } from "./platform.mjs";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJson } from "./evolution-store.mjs";
import { EvolutionMonitorStore } from "./evolution-monitor-store.mjs";
import { launchDesktop } from "./evolution-launch.mjs";

/** Purpose: Keep a small native progress and message window alive across Cleo restarts.
 * Input: standard userData path. Output: read-only progress plus durable supplemental messages.
 * This process never edits the version registry or launches a model.
 */
export async function startEvolutionMonitor() {
  const dataHome = desktopDataHome({ platform: process.platform, environment: process.env,
    home: app.getPath("home"), userData: app.getPath("userData") });
  setLanguage(await readUiLanguage(dataHome));
  const root = join(app.getPath("userData"), "evolution");
  const store = new EvolutionMonitorStore(root);
  await app.whenReady();
  const window = new BrowserWindow({ width: 680, height: 780, minWidth: 460, minHeight: 480,
    title: tr("evolution_monitor.cleo_evolution_companion"), autoHideMenuBar: true, backgroundColor: "#101417",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "cleo-companion",
      preload: join(dirname(fileURLToPath(import.meta.url)), "evolution-monitor-preload.cjs"),
      additionalArguments: [`--cleo-ui-language=${getLanguage()}`] } });
  const trusted = event => { if (event.sender !== window.webContents) throw new Error(tr("evolution_monitor.invalid_evolution_window")); };
  ipcMain.handle("cleo:monitor:status", async event => {
    trusted(event);
    await writeJson(join(store.root, "presence.json"), { pid: process.pid, version: app.getVersion(), updatedAt: Date.now() });
    const [runtime, state, messages] = await Promise.all([store.runtime(), readJson(join(root, "state.json"), {}), store.messages()]);
    if (runtime.uiLanguage === "en" || runtime.uiLanguage === "zh-CN") setLanguage(runtime.uiLanguage);
    const tx = state.transaction;
    let phase = runtime.phase || tr("evolution_monitor.waiting_for_a_conversation");
    let detail = runtime.detail || tr("evolution_monitor.describe_your_improvement_request_in_cleo_s_evolution_workspace");
    if (tx) {
      phase = tx.phase === "staged" ? tr("evolution_monitor.backing_up_and_preparing_to_switch") : tr("evolution_handoff.starting_the_modified_cleo");
      detail = tr("evolution_monitor.this_window_stays_open_additional_requirements_are_saved_and_will_continue_in_the_ori");
    } else if (state.lastRestartError) { phase = tr("evolution_monitor.working_version_restored"); detail = state.lastRestartError; }
    else if (Date.now() - (runtime.updatedAt || 0) > 15000) {
      phase = tr("evolution_monitor.waiting_for_cleo_to_connect"); detail = tr("evolution_monitor.the_main_program_is_not_connected_additional_requirements_will_still_be_saved_open_cl");
    }
    const threadId = state.threadId || null;
    const connected = runtime.protocol === 2 && Date.now() - (runtime.updatedAt || 0) < 15000 && !tx;
    return { phase, detail, uiLanguage: getLanguage(), logs: runtime.logs || "", threadId, connected,
      thread: runtime.thread?.id === threadId ? runtime.thread : null,
      running: runtime.running, paused: await store.paused(), canDiscard: Boolean(state.iteration),
      actions: connected ? runtime.actions || null : null,
      commands: (await store.commands()).slice(-10), messages: messages.filter(m => m.threadId === threadId).slice(-30) };
  });
  ipcMain.handle("cleo:monitor:send", async (event, body) => {
    trusted(event);
    const state = await readJson(join(root, "state.json"), {});
    return store.enqueue(state.threadId, body);
  });
  ipcMain.handle("cleo:monitor:control", async (event, action, params = {}) => {
    trusted(event);
    const state = await readJson(join(root, "state.json"), {});
    const runtime = await store.runtime();
    const connected = runtime.protocol === 2 && Date.now() - (runtime.updatedAt || 0) < 15000;
    if (action === "emergency" || (action === "recovery" && !connected)) {
      const target = state.builds?.find(build => build.id === state.baseline) || state.builds?.find(build => build.id === state.active);
      if (!target?.executable) throw new Error(tr("evolution_monitor.no_recovery_version_is_available_prepare_the_evolution_workspace_in_the_main_window_f"));
      await launchDesktop(target.executable, ["--cleo-recovery", `--user-data-dir=${app.getPath("userData")}`], { ...process.env, CLEO_EVOLUTION_CHILD: "1" });
      return;
    }
    if (!connected) throw new Error(tr("evolution_monitor.the_main_program_is_not_connected_messages_will_be_saved_use_versions_and_recovery_to"));
    if (action === "discard" || action === "recovery") {
      if (state.transaction) throw new Error(tr("evolution_monitor.switching_versions_wait_for_the_current_recovery_process_to_finish"));
      let targetId;
      if (action === "recovery") {
        const targets = (state.builds || []).filter(build => build.savedAt || build.kind === "official" || build.baseline || build.id === state.iteration?.base).reverse();
        if (!targets.length) throw new Error(tr("evolution_monitor.no_recoverable_version_is_available"));
        const selected = await dialog.showMessageBox(window, { type: "question", title: tr("evolution_monitor.return_to_a_working_version"), message: tr("evolution_monitor.choose_recovery_target"),
          detail: tr("evolution_monitor.the_evolution_task_will_stop_and_this_iteration_s_source_changes_will_be_archived_bef"),
          buttons: [...targets.map(build => build.name || build.version || tr("evolution_monitor.version_at_the_start_of_this_iteration")), tr("computerpanel.cancel")], cancelId: targets.length, defaultId: targets.length, noLink: true });
        if (selected.response === targets.length) return;
        targetId = targets[selected.response].id;
      } else {
        const choice = await dialog.showMessageBox(window, { type: "warning", title: tr("evolution_monitor.discard_this_iteration_s_changes"), message: tr("evolution_monitor.stop_evolution_and_return_to_the_version_from_before_this_iteration"),
          detail: tr("evolution_monitor.this_iteration_s_source_will_be_archived_and_unsent_additional_requirements_will_be_c"),
          buttons: [tr("computerpanel.cancel"), tr("evolution_monitor.discard_and_restore")], defaultId: 0, cancelId: 0, noLink: true });
        if (choice.response !== 1) return;
      }
      return store.command(action === "recovery" ? "rollback" : action, state.threadId,
        { active: state.active, iteration: state.iteration?.id || null, targetId });
    }
    if (["build", "apply", "save"].includes(action)) {
      if (state.transaction) throw new Error(tr("evolution_monitor.switching_versions_wait_for_the_current_process_to_finish"));
      if (action === "apply") {
        const choice = await dialog.showMessageBox(window, { type: "question", title: tr("evolution_monitor.apply_changes"), message: tr("evolution_monitor.checks_passed_apply_now"),
          detail: tr("evolution_monitor.cleo_will_restart_using_the_modified_version_chats_memories_and_configuration_are_pre"),
          buttons: [tr("evolution_monitor.later"), tr("evolution_monitor.apply_and_restart")], defaultId: 1, cancelId: 0, noLink: true });
        if (choice.response !== 1) return;
      }
      const name = typeof params.name === "string" ? params.name.trim().slice(0, 80) : "";
      return store.command(action, state.threadId, action === "save" ? { name } : {});
    }
    if (!["stop", "resume", "answer"].includes(action)) throw new Error(tr("evolution_monitor.unsupported_operation"));
    if (action === "answer" && JSON.stringify(params).length > 30000) throw new Error(tr("evolution_monitor.the_answer_is_too_long"));
    return store.command(action, state.threadId, action === "answer" ? { questionId: params.questionId, answers: params.answers } : {});
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  await window.loadFile(join(dirname(fileURLToPath(import.meta.url)), "evolution-monitor.html"));
  window.show();
  app.on("window-all-closed", () => app.quit());
}
