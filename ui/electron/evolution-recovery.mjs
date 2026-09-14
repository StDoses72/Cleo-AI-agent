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
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error("无效的应用进程。");
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await cancelled()) return false;
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return true; throw error; }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("Cleo 尚未退出。请关闭当前程序，再打开恢复入口。");
}

/** Purpose: Verify that a separate restart surface is visible before the old app exits.
 * Input: store, activation id and spawned controller. Output: ready signal or an error while the old app still runs.
 */
export async function waitForControllerReady(store, id, child) {
  const path = ownedPath(store.root, "handoffs", `${id}.json`);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("重启控制器未能启动，当前 Cleo 已保留。");
    const ready = await readJson(path);
    if (ready?.id === id && ready.pid === child.pid) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("重启窗口尚未就绪，当前 Cleo 已保留。");
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
  if (child.exitCode === null && child.signalCode === null) throw new Error("程序仍在退出。");
}

/** Purpose: Own restart visibility and automatic rollback outside mutable app code.
 * Input: store and original process id. Output: closes only after a working app is confirmed; failed recovery remains interactive.
 */
export async function applyFromController(store, parent) {
  const initial = await store.read();
  if (!initial.transaction) throw new Error("没有待应用的改动。");
  const progress = await createRestartWindow();
  const readyPath = ownedPath(store.root, "handoffs", `${initial.transaction.id}.json`);
  await writeJson(readyPath, { id: initial.transaction.id, pid: process.pid });
  let parentClosed = false;
  const hooks = {
    async withLock(action) {
      if (!app.requestSingleInstanceLock()) throw new Error("另一个 Cleo 仍在运行，请先关闭它后重试。");
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
        await progress.progress("Cleo 需要恢复", result.error, true);
        await progress.waitForChoice();
        if (!parentClosed) break;
        selected = await showRecovery(store, { selectOnly: true, parentWindow: progress.window });
      } while (!selected);
      if (selected) {
        try {
          await hooks.withLock(async () => { await store.recover(selected); await store.stage(selected); });
        } catch (error) { await progress.progress("暂时无法切换", error.message, true); }
      }
    }
  } finally { await rm(readyPath, { force: true }); }
}

/** Purpose: Recover without importing mutable UI/backend. Input: registry. Output: selected program using the same current user data. */
export async function showRecovery(store, { selectOnly = false, parentWindow = null } = {}) {
  const state = await store.read();
  if (!state.baseline) {
    await dialog.showMessageBox({ type: "info", message: "尚未创建恢复点", detail: "首次准备本地迭代时会保存可用版本。" });
    return;
  }
  const choices = [state.baseline, state.workspaceBase, state.latestSaved, state.iteration?.base,
    state.lastApplication?.from, state.transaction?.from, state.active]
    .filter((id, index, all) => id && all.indexOf(id) === index)
    .map((id) => state.builds.find((build) => build.id === id)).filter(Boolean);
  const options = { title: "Cleo · 版本与恢复", type: "question",
    message: "选择一个可用状态", detail: selectOnly
      ? "选择后由 Cleo 自动完成重启。这里只切换程序，聊天、记忆和配置始终保留。"
      : "请先关闭正在运行的 Cleo。这里只切换程序版本，聊天、记忆和配置等用户数据始终保留。",
    buttons: [...choices.map((build) => build.baseline ? `保底正式版 ${build.version}`
      : build.kind === "official" ? `正式版 ${build.version}` : build.name || "本地修改"), "取消"],
    cancelId: choices.length, noLink: true };
  const result = await dialog.showMessageBox(...(parentWindow ? [parentWindow, options] : [options]));
  if (result.response === choices.length) return;
  const selected = choices[result.response];
  if (selectOnly) return selected.id;
  if (!app.requestSingleInstanceLock()) throw new Error("请先关闭正在运行的 Cleo，再执行恢复。");
  let build;
  try { build = await store.recover(selected.id); }
  finally { app.releaseSingleInstanceLock(); }
  await launchBuild(build, store);
}
