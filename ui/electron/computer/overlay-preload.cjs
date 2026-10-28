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
  ipcRenderer.on("cleo:computer:labels", (_event, labels) => {
    document.documentElement.lang = labels.language;
    if (surface) surface.title = labels.takeover;
    const browserLabel = document.querySelector("[data-browser-label]");
    if (browserLabel) browserLabel.textContent = labels.active;
  });
  ipcRenderer.on("cleo:computer:status", (_event, status) => {
    const label = document.querySelector("[data-label]");
    const shortcut = document.querySelector("[data-shortcut]");
    const takeover = document.querySelector("[data-action='takeover-desktop']");
    const handback = document.querySelector("[data-action='handback-desktop']");
    document.documentElement.lang = status.language;
    if (label) label.textContent = status.label;
    if (shortcut) shortcut.textContent = status.shortcutLabel;
    for (const button of document.querySelectorAll("[data-action]")) {
      if (status.buttons[button.dataset.action]) button.textContent = status.buttons[button.dataset.action];
    }
    if (takeover) takeover.hidden = status.control === "user";
    if (handback) {
      handback.hidden = status.stopping || status.control !== "user";
      handback.disabled = Boolean(status.stopping);
    }
  });
});
