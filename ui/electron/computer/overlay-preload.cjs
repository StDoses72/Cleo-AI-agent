// Minimal bridge for Cleo's own overlay pages: they can only report take-over or stop clicks.
const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  const send = action => ipcRenderer.send("cleo:computer:overlay", action);
  const surface = document.querySelector("[data-surface]");
  if (surface) {
    surface.addEventListener("mousedown", event => { event.preventDefault(); send("takeover-browser"); });
  }
  for (const button of document.querySelectorAll("[data-action]")) {
    button.addEventListener("click", event => { event.preventDefault(); if (!button.disabled) send(button.dataset.action); });
  }
  ipcRenderer.on("cleo:computer:status", (_event, status) => {
    const label = document.querySelector("[data-label]");
    const shortcut = document.querySelector("[data-shortcut]");
    const takeover = document.querySelector("[data-action='takeover-desktop']");
    const handback = document.querySelector("[data-action='handback-desktop']");
    if (label) label.textContent = status.stopping ? "正在停止…" : status.control === "user" ? "你正在操作 · AI 已暂停" : "Cleo 正在控制本机鼠标键盘";
    if (shortcut) shortcut.textContent = status.shortcut ? `${status.shortcut} 紧急停止` : "快捷键不可用";
    if (takeover) takeover.hidden = status.control === "user";
    if (handback) {
      handback.hidden = status.stopping || status.control !== "user";
      handback.disabled = Boolean(status.stopping);
    }
  });
});
