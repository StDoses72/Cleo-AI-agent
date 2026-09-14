import { BrowserWindow } from "electron";

/** Purpose: Keep an independent visible surface throughout restart and failed recovery.
 * Input: none. Output: progress, failure-choice and explicit completion controls.
 */
export async function createRestartWindow() {
  const window = new BrowserWindow({ width: 480, height: 270, resizable: false, minimizable: false,
    maximizable: false, closable: false, show: false, title: "Cleo · 正在重启", backgroundColor: "#0c1014",
    autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  let finished = false;
  let choose;
  window.on("close", (event) => { if (!finished) event.preventDefault(); });
  window.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (url === "cleo-restart:choose" && choose) { const resolveChoice = choose; choose = null; resolveChoice(); }
  });
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
    body{margin:0;padding:30px;background:#0c1014;color:#e8edef;font:14px 'Segoe UI','Microsoft YaHei',sans-serif}
    .brand{color:#66d9df;font-size:12px;letter-spacing:3px}h1{font-size:21px;font-weight:550;margin:18px 0 10px}
    p{font-size:13px;line-height:1.8;color:#9aa6b1}a{display:inline-block;padding:9px 15px;background:#66d9df;color:#0c1014;border-radius:7px;text-decoration:none}
    [hidden]{display:none}
    </style><span class="brand">CLEO</span><h1 id="title">正在重启 Cleo</h1><p id="detail">正在准备安全切换，当前窗口会一直保留。</p><a id="choose" href="cleo-restart:choose" hidden>选择可用版本</a></html>`;
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  window.show();
  window.focus();
  return {
    window,
    async progress(title, detail, failed = false) {
      if (window.isDestroyed()) throw new Error("重启窗口意外关闭。");
      await window.webContents.executeJavaScript(`document.getElementById("title").textContent=${JSON.stringify(title)};document.getElementById("detail").textContent=${JSON.stringify(detail)};document.getElementById("choose").hidden=${!failed};`);
    },
    waitForChoice() { return new Promise((done) => { choose = done; }); },
    finish() { finished = true; window.destroy(); },
  };
}
