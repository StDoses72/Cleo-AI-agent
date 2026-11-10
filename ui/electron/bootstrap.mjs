import { t as tr } from "./i18n.mjs";
import { app, dialog, ipcMain, nativeTheme } from "electron";
import { join, resolve } from "node:path";
import { ProgramStore } from "./program-store.mjs";
import { desktopDataHome } from "./platform.mjs";
import { configureReleaseChannel } from "./release-channel.mjs";
import { setLanguage } from "./i18n.mjs";
import { readUiLanguage } from "./language.mjs";

configureReleaseChannel(app);
// The control directory keeps its original name: it is an on-disk format shared with every retained program.
const root = join(app.getPath("userData"), "evolution");
const dataHome = desktopDataHome({ platform: process.platform, environment: process.env,
  home: app.getPath("home"), userData: app.getPath("userData") });
const store = new ProgramStore(root, dataHome);
const recovery = process.argv.includes("--cleo-recovery");
const parentArgument = process.argv.find((argument) => argument.startsWith("--cleo-apply-parent="));
// The restart and recovery windows wear the theme the main window handed over.
const themeArgument = process.argv.find((argument) => argument.startsWith("--cleo-theme="))?.slice("--cleo-theme=".length);
if (themeArgument === "light" || themeArgument === "dark") nativeTheme.themeSource = themeArgument;

/** Purpose: Select a version ahead of mutable UI/backend imports. Input: flags. Output: selected app. */
async function boot() {
  setLanguage(await readUiLanguage(dataHome));
  if (!app.isPackaged || process.env.CLEO_DESKTOP_MOCK === "1") { await import("./main.mjs"); return; }
  if (recovery || parentArgument) {
    await app.whenReady();
    const controller = await import("./program-recovery.mjs");
    try {
      if (parentArgument) await controller.applyFromController(store, Number(parentArgument.split("=")[1]));
      else await controller.showRecovery(store);
    } catch (error) {
      await dialog.showMessageBox({ type: "error", title: tr("bootstrap.cleo_recovery"), message: tr("bootstrap.operation_incomplete"), detail: error.message });
    }
    app.quit(); return;
  }
  const state = await store.read();
  // CLEO_EVOLUTION_CHILD and CLEO_EVOLUTION_TRANSACTION are the launch protocol shared with every
  // retained program, including ones older than this one; their names are part of that protocol.
  if (state.active && process.env.CLEO_EVOLUTION_CHILD !== "1") {
    if (state.transaction) {
      await app.whenReady();
      const { showRecovery } = await import("./program-recovery.mjs");
      await showRecovery(store); app.quit(); return;
    }
    const { ProgramVersions } = await import("./program-versions.mjs");
    const manager = new ProgramVersions({ app, root, dataHome });
    const installed = await manager.installedRelease();
    if (installed) {
      await app.whenReady();
      if (!app.requestSingleInstanceLock()) throw new Error(tr("bootstrap.close_the_current_cleo_instance_before_opening_the_new_version"));
      let progress;
      let transaction;
      try {
        const { createRestartWindow } = await import("./restart-window.mjs");
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
        const { applyFromController } = await import("./program-recovery.mjs");
        try { await applyFromController(store, null, { progress }); }
        finally { progress.finish(); }
        app.quit(); return;
      }
      progress.finish();
    }
    const selected = await store.build((await store.read()).active);
    if (resolve(selected.executable) !== resolve(process.execPath)) {
      const { launchBuild } = await import("./program-recovery.mjs");
      await launchBuild(selected, store); app.quit(); return;
    }
  }
  const transactionId = process.env.CLEO_EVOLUTION_TRANSACTION;
  ipcMain.handle("cleo:program:healthy", async () => {
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
