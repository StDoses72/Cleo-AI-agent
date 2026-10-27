import { t as tr, getLanguage } from "../i18n.mjs";
/** Visible local-computer status and an emergency stop that does not depend on the AI.
 *
 * While the AI may drive the real mouse and keyboard, a small always-on-top, non-focusable bar
 * shows the state with take-over and stop buttons, and a global shortcut stops everything even
 * when Cleo is hidden. Preferences live in their own file so shared configuration is unchanged.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { stopAccelerator } from "./keys.mjs";

export const DEFAULT_STOP_SHORTCUT = "Control+Alt+Escape";

function hostStopUnconfirmed(state) {
  return Boolean(state.lastStop?.hostError && !state.lastStop.settled);
}

export function readPreferences(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function writePreferences(path, changes) {
  const next = { ...readPreferences(path), ...changes, version: 1 };
  const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
  return next;
}

export class HostControls {
  constructor({ electron, broker, preferencesPath, files }) {
    Object.assign(this, { electron, broker, preferencesPath, files });
    const saved = readPreferences(preferencesPath).stopShortcut;
    this.shortcut = DEFAULT_STOP_SHORTCUT;
    try { if (saved) this.shortcut = stopAccelerator(saved); } catch { /* Keep the default. */ }
    this.registered = null;
    this.shortcutError = "";
    this.window = null;
  }

  status() {
    return { stopShortcut: this.shortcut, shortcutActive: this.registered === this.shortcut, shortcutError: this.shortcutError };
  }

  setShortcut(value) {
    const accelerator = stopAccelerator(value);
    const previous = this.shortcut;
    this.shortcut = accelerator;
    if (this.registered) {
      this.unregister();
      if (!this.register()) {
        this.shortcut = previous;
        this.register();
        throw new Error(tr("host_ui.shortcut_value_is_used_by_another_application_the_previous_setting_was_preserved", { p0: accelerator }));
      }
    }
    writePreferences(this.preferencesPath, { stopShortcut: accelerator });
    return this.status();
  }

  register() {
    const { globalShortcut } = this.electron;
    if (this.registered === this.shortcut) return true;
    this.unregister();
    let ok = false;
    try { ok = globalShortcut.register(this.shortcut, () => { void this.broker.stop({ source: "shortcut" }); }); } catch { ok = false; }
    this.registered = ok ? this.shortcut : null;
    this.shortcutError = ok ? "" : tr("host_ui.could_not_register_emergency_stop_shortcut_value_another_application_may_be_using_it_", { p0: this.shortcut });
    return ok;
  }

  unregister() {
    if (!this.registered) return;
    try { this.electron.globalShortcut.unregister(this.registered); } catch { /* App shutting down. */ }
    this.registered = null;
  }

  statusWindow() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const { BrowserWindow, screen } = this.electron;
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(760, area.width - 12);
    this.window = new BrowserWindow({
      width, height: 46, x: Math.round(area.x + (area.width - width) / 2), y: area.y + 6,
      frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
      skipTaskbar: true, focusable: false, alwaysOnTop: true, show: false, hasShadow: false,
      ...(process.platform === "win32" ? { type: "toolbar" } : {}),
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: this.files.preload },
    });
    this.window.setAlwaysOnTop(true, "screen-saver");
    this.window.setVisibleOnAllWorkspaces?.(true);
    void this.window.loadFile(this.files.statusHtml);
    this.window.webContents.on("did-finish-load", () => this.pushStatus());
    return this.window;
  }

  isStatusWindow(webContents) {
    return Boolean(this.window) && !this.window.isDestroyed() && webContents === this.window.webContents;
  }

  pushStatus() {
    if (!this.window || this.window.isDestroyed()) return;
    const state = this.broker.state();
    const stopping = state.stopping || hostStopUnconfirmed(state);
    this.window.webContents.send("cleo:computer:status", {
      control: state.control.desktop, stopping, shortcut: this.registered ? this.shortcut : "",
      language: getLanguage(),
      label: stopping ? tr("overlay_preload.stopping") : state.control.desktop === "user"
        ? tr("computerpanel.you_are_in_control_ai_paused") : tr("overlay_preload.cleo_is_controlling_the_local_mouse_and_keyboard"),
      shortcutLabel: this.registered ? tr("overlay_preload.value_emergency_stop", { p0: this.shortcut }) : tr("overlay_preload.shortcut_unavailable"),
      buttons: { "takeover-desktop": tr("computerpanel.take_over"), "handback-desktop": tr("computerpanel.return_control_to_ai"), stop: tr("computerpanel.stop") },
    });
  }

  /** Purpose: Reflect broker state. Input: none. Output: shortcut registration and bar visibility. */
  update() {
    const state = this.broker.state();
    const authorized = Object.values(state.threads).some(entry => entry.hostAuthorized);
    const unconfirmed = hostStopUnconfirmed(state);
    // Revoked authorization alone cannot prove the native controller stopped. Preserve
    // both emergency controls until a later stop acknowledgement confirms settlement.
    if (authorized || unconfirmed) this.register(); else this.unregister();
    const visible = unconfirmed || state.hostEngaged || (authorized && state.control.desktop === "user" && Boolean(state.lease?.running));
    if (visible) {
      const window = this.statusWindow();
      if (!window.isVisible()) window.showInactive();
      this.pushStatus();
    } else if (this.window && !this.window.isDestroyed() && this.window.isVisible()) {
      this.window.hide();
    }
  }

  close() {
    this.unregister();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
  }
}
