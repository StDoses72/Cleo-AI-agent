import { t as tr } from "./i18n.mjs";

const reloads = new WeakMap();

/** Opening Cleo again asks for a workspace that failed to show; one that is showing stays as it is. */
export function reopenWorkspaceWindow(window) {
  reloads.get(window)?.();
}

/** Reload the local workspace only on request; repeated failures must not start a crash loop. */
export function loadWorkspaceWindow(window, { index, dialog, isQuitting }) {
  let prompting = false;
  // Set from a failure until the next load starts: a dismissed message leaves the window empty.
  let failed = false;
  const canRecover = () => !isQuitting() && !window.isDestroyed();
  const load = () => {
    failed = false;
    return window.loadFile(index).catch(error => {
      if (error.code !== "ERR_ABORTED") return recover(error.message);
    });
  };
  reloads.set(window, () => {
    if (failed && !prompting && canRecover()) void load();
  });
  async function recover(detail) {
    failed = true;
    if (!canRecover() || prompting) return;
    prompting = true;
    console.error("Workspace window:", detail);
    const { response } = await dialog.showMessageBox(window, {
      type: "error", title: "Cleo", message: tr("main.workspace_display_failed"), detail,
      buttons: [tr("computerpanel.reload"), tr("main.dismiss_window_error")], defaultId: 0, cancelId: 1,
    });
    prompting = false;
    if (response === 0 && canRecover()) await load();
  }
  window.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") void recover(details.reason);
  });
  return load();
}
