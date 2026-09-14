import { app, dialog, ipcMain } from "electron";
import { join, resolve } from "node:path";
import { EvolutionStore } from "./evolution-store.mjs";
import { desktopDataHome } from "./platform.mjs";

app.setName("Cleo");
const root = join(app.getPath("userData"), "evolution");
const dataHome = desktopDataHome({ platform: process.platform, environment: process.env,
  home: app.getPath("home"), userData: app.getPath("userData") });
const store = new EvolutionStore(root, dataHome);
const recovery = process.argv.includes("--cleo-recovery");
const parentArgument = process.argv.find((argument) => argument.startsWith("--cleo-apply-parent="));

/** Purpose: Select a version ahead of mutable UI/backend imports. Input: flags. Output: selected app. */
async function boot() {
  if (!app.isPackaged || process.env.CLEO_DESKTOP_MOCK === "1") { await import("./main.mjs"); return; }
  if (recovery || parentArgument) {
    await app.whenReady();
    const controller = await import("./evolution-recovery.mjs");
    try {
      if (parentArgument) await controller.applyFromController(store, Number(parentArgument.split("=")[1]));
      else await controller.showRecovery(store);
    } catch (error) {
      await dialog.showMessageBox({ type: "error", title: "Cleo 恢复", message: "操作未完成", detail: error.message });
    }
    app.quit(); return;
  }
  if (process.argv.includes("--cleo-import-bundle")) {
    await app.whenReady();
    if (!app.requestSingleInstanceLock()) throw new Error("请先关闭当前 Cleo，再打开新版程序。");
    try {
      const { EvolutionManager } = await import("./evolution.mjs");
      await new EvolutionManager({ app, root, dataHome }).importBundle();
    } finally { app.releaseSingleInstanceLock(); }
  }
  const state = await store.read();
  if (state.active && process.env.CLEO_EVOLUTION_CHILD !== "1") {
    if (state.transaction) {
      await app.whenReady();
      const { showRecovery } = await import("./evolution-recovery.mjs");
      await showRecovery(store); app.quit(); return;
    }
    const selected = await store.build(state.active);
    if (resolve(selected.executable) !== resolve(process.execPath)) {
      const { launchBuild } = await import("./evolution-recovery.mjs");
      await launchBuild(selected, store); app.quit(); return;
    }
  }
  process.env.CLEO_EVOLUTION_WORKSPACE = join(root, "source");
  const transactionId = process.env.CLEO_EVOLUTION_TRANSACTION;
  ipcMain.handle("cleo:evolution:healthy", async () => {
    await store.exclusive(() => store.healthy(transactionId));
  });
  await import("./main.mjs");
}

// Electron emits ready after evaluating its ESM entry point. Do not await a path that waits for ready here.
void boot().catch(async (error) => {
  await app.whenReady();
  await dialog.showMessageBox({ type: "error", title: "Cleo 启动失败",
    message: "可以通过独立恢复入口切回可用程序。", detail: error.message });
  app.quit();
});
