import { t as tr, getLanguage } from "./i18n.mjs";
import { BrowserWindow, nativeTheme } from "electron";

/** Purpose: Keep an independent visible surface throughout restart and failed recovery.
 * Input: none. Output: progress, failure-choice and explicit completion controls.
 */
export async function createRestartWindow() {
  const window = new BrowserWindow({ width: 480, height: 270, resizable: false, minimizable: false,
    maximizable: false, closable: false, show: false, title: tr("evolution_progress.cleo_restarting"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#161618" : "#ffffff",
    autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  let finished = false;
  let choose;
  window.on("close", (event) => { if (!finished) event.preventDefault(); });
  window.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (url === "cleo-restart:choose" && choose) { const resolveChoice = choose; choose = null; resolveChoice(); }
  });
  const html = `<!doctype html><html lang="${getLanguage()}"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
    :root{color-scheme:light;--canvas:#fff;--text:#27272a;--muted:#6b6b70;--accent:#45454a;--accent-ink:#fff;--border:rgba(24,24,27,.15)}
    @media (prefers-color-scheme:dark){:root{color-scheme:dark;--canvas:#161618;--text:#ececea;--muted:#a2a2a8;--accent:#e2e2e0;--accent-ink:#1f1f22;--border:rgba(236,236,234,.15)}}
    body{margin:0;padding:24px 26px;background:var(--canvas);color:var(--text);font:14px 'Segoe UI','Microsoft YaHei',sans-serif}
    .brand{display:inline-flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;font-weight:600}.brand i{display:grid;place-items:center;width:20px;height:20px;border-radius:5px;background:var(--accent);color:var(--accent-ink)}h1{font-size:17px;font-weight:650;margin:16px 0 8px}
    p{font-size:13px;line-height:1.7;color:var(--muted)}a{display:inline-flex;align-items:center;height:30px;padding:0 12px;background:var(--accent);color:var(--accent-ink);border-radius:6px;font-size:13px;font-weight:600;text-decoration:none}
    [hidden]{display:none}
    </style><span class="brand"><i aria-hidden="true"><svg viewBox="0 0 1024 1024" width="13" height="13"><path d="M701.5 322.5A268 268 0 1 0 701.5 701.5" fill="none" stroke="currentColor" stroke-width="120" stroke-linecap="round"/><circle cx="712" cy="512" r="68" fill="currentColor"/></svg></i>CLEO</span><h1 id="title">${tr("progress.restarting")}</h1><p id="detail">${tr("progress.preparing")}</p><a id="choose" href="cleo-restart:choose" hidden>${tr("progress.choose")}</a></html>`;
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  window.show();
  window.focus();
  return {
    window,
    async progress(title, detail, failed = false) {
      if (window.isDestroyed()) throw new Error(tr("evolution_progress.the_restart_window_closed_unexpectedly"));
      await window.webContents.executeJavaScript(`document.getElementById("title").textContent=${JSON.stringify(title)};document.getElementById("detail").textContent=${JSON.stringify(detail)};document.getElementById("choose").hidden=${!failed};`);
    },
    waitForChoice() { return new Promise((done) => { choose = done; }); },
    finish() { finished = true; window.destroy(); },
  };
}
