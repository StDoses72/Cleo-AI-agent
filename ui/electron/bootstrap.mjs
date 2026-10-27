import { t as tr } from "./i18n.mjs";
import { app, dialog, ipcMain } from "electron";
import { join, resolve } from "node:path";
import { EvolutionStore } from "./evolution-store.mjs";
import { desktopDataHome } from "./platform.mjs";
import { configureReleaseChannel } from "./release-channel.mjs";
import { setLanguage } from "./i18n.mjs";
import { readUiLanguage } from "./language.mjs";

configureReleaseChannel(app);
const root = join(app.getPath("userData"), "evolution");
const dataHome = desktopDataHome({ platform: process.platform, environment: process.env,
  home: app.getPath("home"), userData: app.getPath("userData") });
const store = new EvolutionStore(root, dataHome);
const recovery = process.argv.includes("--cleo-recovery");
const parentArgument = process.argv.find((argument) => argument.startsWith("--cleo-apply-parent="));

/** Purpose: Select a version ahead of mutable UI/backend imports. Input: flags. Output: selected app. */
async function boot() {
  setLanguage(await readUiLanguage(dataHome));
  if (!app.isPackaged || process.env.CLEO_DESKTOP_MOCK === "1") { await import("./main.mjs"); return; }
  if (recovery || parentArgument) {
    await app.whenReady();
    const controller = await import("./evolution-recovery.mjs");
    try {
      if (parentArgument) await controller.applyFromController(store, Number(parentArgument.split("=")[1]));
      else await controller.showRecovery(store);
    } catch (error) {
      await dialog.showMessageBox({ type: "error", title: tr("bootstrap.cleo_recovery"), message: tr("evolutionpanel.operation_incomplete"), detail: error.message });
    }
    app.quit(); return;
  }
  if (process.argv.includes("--cleo-import-bundle")) {
    await app.whenReady();
    if (!app.requestSingleInstanceLock()) throw new Error(tr("bootstrap.close_the_current_cleo_instance_before_opening_the_new_version"));
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
    const { EvolutionManager } = await import("./evolution.mjs");
    const manager = new EvolutionManager({ app, root, dataHome });
    const installed = await manager.installedRelease();
    if (installed) {
      await app.whenReady();
      if (!app.requestSingleInstanceLock()) throw new Error(tr("bootstrap.close_the_current_cleo_instance_before_opening_the_new_version"));
      let progress;
      let transaction;
      try {
        const { createRestartWindow } = await import("./evolution-progress.mjs");
        progress = await createRestartWindow();
        await progress.progress(tr("bootstrap.opening_cleo_value", { p0: installed.version }), tr("bootstrap.preparing_the_new_program"));
        transaction = await manager.stageInstalledRelease();
      } catch (error) {
        progress?.finish();
        throw error;
      } finally {
        await manager.close();
        app.releaseSingleInstanceLock();
      }
      if (transaction) {
        const { applyFromController } = await import("./evolution-recovery.mjs");
        try { await applyFromController(store, null, { progress }); }
        finally { progress.finish(); }
        app.quit(); return;
      }
      progress.finish();
    }
    const selected = await store.build((await store.read()).active);
    if (resolve(selected.executable) !== resolve(process.execPath)) {
      const { launchBuild } = await import("./evolution-recovery.mjs");
      await launchBuild(selected, store); app.quit(); return;
    }
  }
  process.env.CLEO_EVOLUTION_WORKSPACE = join(root, "source");
  const transactionId = process.env.CLEO_EVOLUTION_TRANSACTION;
  ipcMain.handle("cleo:evolution:healthy", async () => {
    await store.exclusive(() => store.healthy(transactionId));
    app.emit("cleo:healthy", transactionId);
    if (process.platform === "win32") {
      // The Start Menu entry (Programs\Cleo) must carry the icon and version of the program that actually runs.
      void import("./launcher-refresh.mjs")
        .then(({ refreshInstalledLauncher }) => refreshInstalledLauncher({ store, log: (text) => console.error(text) }))
        .catch((error) => console.error("Launcher refresh:", error.message));
    }
  });
  await import("./main.mjs");
}

// Electron emits ready after evaluating its ESM entry point. Do not await a path that waits for ready here.
void boot().catch(async (error) => {
  await app.whenReady();
  await dialog.showMessageBox({ type: "error", title: tr("bootstrap.cleo_could_not_start"),
    message: tr("bootstrap.use_the_independent_recovery_entry_point_to_switch_back_to_a_working_program"), detail: error.message });
  app.quit();
});
