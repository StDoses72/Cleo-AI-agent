import { t as tr } from "./i18n.mjs";
import { launchDesktop } from "./evolution-launch.mjs";
import { app, dialog } from "electron";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import { readJson, writeJson, ownedPath } from "./evolution-store.mjs";
import { createRestartWindow } from "./evolution-progress.mjs";
import { runHandoff } from "./evolution-handoff.mjs";

/** Purpose: Launch a retained build with visible UI. Input: validated build/store. Output: detached child process. */
export async function launchBuild(build, store, transactionId = null) {
  const child = await launchDesktop(build.executable, [`--user-data-dir=${app.getPath("userData")}`],
    { ...process.env, CLEO_HOME: store.dataHome, CLEO_EVOLUTION_CHILD: "1",
      CLEO_EVOLUTION_TRANSACTION: transactionId || "", CLEO_EVOLUTION_WORKSPACE: resolve(store.root, "source") });
  return child;
}

/** Purpose: Wait for the old app to release data. Input: parent pid. Output: termination or bounded error. */
async function waitForExit(pid, cancelled = async () => false) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error(tr("evolution_recovery.invalid_application_process"));
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await cancelled()) return false;
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return true; throw error; }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(tr("evolution_recovery.cleo_has_not_exited_close_the_current_program_before_opening_recovery"));
}

/** Purpose: Verify that a separate restart surface is visible before the old app exits.
 * Input: store, activation id and spawned controller. Output: ready signal or an error while the old app still runs.
 */
export async function waitForControllerReady(store, id, child) {
  const path = ownedPath(store.root, "handoffs", `${id}.json`);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(tr("evolution_recovery.the_restart_controller_could_not_start_the_current_cleo_instance_was_kept"));
    const ready = await readJson(path);
    if (ready?.id === id && ready.pid === child.pid) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(tr("evolution_recovery.the_restart_window_is_not_ready_the_current_cleo_instance_was_kept"));
}

/** Purpose: Wait for a real UI/backend startup acknowledgment, not merely process creation.
 * Input: store, child, transaction and selected build. Output: whether the program became usable.
 */
async function waitHealthy(store, child, transaction, selected) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    const state = await store.read();
    if (!state.transaction && state.lastApplication?.id === transaction && state.active === selected) return true;
    await new Promise((done) => setTimeout(done, 250));
  }
  return false;
}

/** Purpose: Release a failed launched program before starting a fallback with shared data.
 * Input: child owned by this controller. Output: process termination or an error that keeps recovery open.
 */
async function stopFailedBuild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    try { await promisify(execFile)("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10000 }); }
    catch (error) { if (child.exitCode === null && child.signalCode === null) throw error; }
  } else {
    try { process.kill(-child.pid, "SIGTERM"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  const deadline = Date.now() + 10000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  if (child.exitCode === null && child.signalCode === null) throw new Error(tr("evolution_recovery.the_program_is_still_exiting"));
}

/** Purpose: Own restart visibility and automatic rollback outside mutable app code.
 * Input: store and original process id (null for an installation opened with no old app running).
 * Output: closes only after a working app is confirmed; failed recovery remains interactive.
 */
export async function applyFromController(store, parent, { progress: existingProgress } = {}) {
  const initial = await store.read();
  if (!initial.transaction) throw new Error(tr("evolution_recovery.there_are_no_changes_to_apply"));
  const progress = existingProgress || await createRestartWindow();
  const readyPath = ownedPath(store.root, "handoffs", `${initial.transaction.id}.json`);
  await writeJson(readyPath, { id: initial.transaction.id, pid: process.pid });
  let parentClosed = parent === null;
  const hooks = {
    async withLock(action) {
      if (!app.requestSingleInstanceLock()) throw new Error(tr("evolution_recovery.another_cleo_instance_is_running_close_it_and_retry"));
      try { return await action(); } finally { app.releaseSingleInstanceLock(); }
    },
    launch: (build, transaction) => launchBuild(build, store, transaction),
    waitHealthy: (child, transaction, selected) => waitHealthy(store, child, transaction, selected),
    stop: stopFailedBuild,
    progress: progress.progress,
  };
  try {
    while (true) {
      let result;
      try {
        if (!parentClosed) {
          parentClosed = await waitForExit(parent, async () => !(await store.read()).transaction);
          if (!parentClosed) { progress.finish(); return; } // Original app cancelled before exiting.
        }
        result = await runHandoff(store, hooks);
        if (result.ok) { progress.finish(); return; }
      } catch (error) { result = { ok: false, error: error.message }; }
      let selected;
      do {
        await progress.progress(tr("evolution_recovery.cleo_needs_recovery"), result.error, true);
        await progress.waitForChoice();
        if (!parentClosed) break;
        selected = await showRecovery(store, { selectOnly: true, parentWindow: progress.window });
      } while (!selected);
      if (selected) {
        try {
          await hooks.withLock(async () => { await store.recover(selected); await store.stage(selected); });
        } catch (error) { await progress.progress(tr("evolution_recovery.cannot_switch_yet"), error.message, true); }
      }
    }
  } finally { await rm(readyPath, { force: true }); }
}

/** Purpose: Recover without importing mutable UI/backend. Input: registry. Output: selected program using the same current user data. */
export async function showRecovery(store, { selectOnly = false, parentWindow = null } = {}) {
  const state = await store.read();
  if (!state.baseline) {
    await dialog.showMessageBox({ type: "info", message: tr("evolution_recovery.no_recovery_point_has_been_created"), detail: tr("evolution_recovery.a_working_version_is_saved_when_local_iteration_is_prepared_for_the_first_time") });
    return;
  }
  const choices = [state.baseline, state.workspaceBase, state.latestSaved, state.iteration?.base,
    state.lastApplication?.from, state.transaction?.from, state.active]
    .filter((id, index, all) => id && all.indexOf(id) === index)
    .map((id) => state.builds.find((build) => build.id === id)).filter(Boolean);
  const options = { title: tr("evolution_recovery.cleo_versions_and_recovery"), type: "question",
    message: tr("evolution_recovery.choose_an_available_state"), detail: selectOnly
      ? tr("evolution_recovery.cleo_restarts_automatically_after_selection_only_the_program_changes_chats_memories_a")
      : tr("evolution_recovery.close_the_running_cleo_instance_first_only_the_program_version_changes_user_data_incl"),
    buttons: [...choices.map((build) => build.baseline ? tr("evolution_recovery.fallback_stable_release_value", { p0: build.version })
      : build.kind === "official" ? tr("evolution_recovery.stable_release_value", { p0: build.version }) : build.name || tr("evolution_recovery.local_changes")), tr("computerpanel.cancel")],
    cancelId: choices.length, noLink: true };
  const result = await dialog.showMessageBox(...(parentWindow ? [parentWindow, options] : [options]));
  if (result.response === choices.length) return;
  const selected = choices[result.response];
  if (selectOnly) return selected.id;
  if (!app.requestSingleInstanceLock()) throw new Error(tr("evolution_recovery.close_the_running_cleo_instance_before_recovery"));
  let build;
  try { build = await store.recover(selected.id); }
  finally { app.releaseSingleInstanceLock(); }
  await launchBuild(build, store);
}
