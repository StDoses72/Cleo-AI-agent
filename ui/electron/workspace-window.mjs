import { t as tr } from "./i18n.mjs";

/** Reload the local workspace only on request; repeated failures must not start a crash loop. */
export function loadWorkspaceWindow(window, { index, dialog, isQuitting }) {
  let prompting = false;
  const canRecover = () => !isQuitting() && !window.isDestroyed();
  const load = () => window.loadFile(index).catch(error => {
    if (error.code !== "ERR_ABORTED") return recover(error.message);
  });
  async function recover(detail) {
    if (!canRecover() || prompting) return;
    prompting = true;
    console.error("Workspace window:", detail);
    let retry;
    try {
      const answer = await dialog.showMessageBox(window, {
        type: "error", title: "Cleo", message: tr("main.workspace_display_failed"), detail,
        buttons: [tr("computerpanel.reload"), tr("main.dismiss_window_error")], defaultId: 0, cancelId: 1,
      });
      retry = answer.response === 0;
    } finally {
      prompting = false;
    }
    if (retry && canRecover()) await load();
  }
  window.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") void recover(details.reason);
  });
  return load();
}
