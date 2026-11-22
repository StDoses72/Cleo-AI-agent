import { t as tr } from "../i18n.mjs";
/** Human labels for computer steps and phases, shared by the computer page and the status bar. */

const STEP_KEYS = {
  browser_screenshot: "computerpanel.view_browser", browser_click: "computerpanel.click_on_the_page", browser_move: "computerpanel.move_pointer",
  browser_drag: "computerpanel.drag", browser_scroll: "computerpanel.scroll_the_page", browser_type: "computerpanel.type_text",
  browser_key: "computerpanel.press_keys", browser_navigate: "computerpanel.open_url", browser_history: "computerpanel.back_forward_reload",
  browser_tabs: "computerpanel.manage_tabs", browser_read: "computerpanel.read_page_content", browser_dialog: "computerpanel.handle_browser_dialogs",
  browser_upload: "computerpanel.upload_files", browser_wait: "computerpanel.wait_for_the_page",
  user_browser_screenshot: "computerpanel.view_page", user_browser_click: "computerpanel.click_on_the_page", user_browser_move: "computerpanel.move_pointer",
  user_browser_drag: "computerpanel.drag", user_browser_scroll: "computerpanel.scroll_the_page", user_browser_type: "computerpanel.type_text",
  user_browser_key: "computerpanel.press_keys", user_browser_navigate: "computerpanel.open_url", user_browser_history: "computerpanel.back_forward_reload",
  user_browser_tabs: "computerpanel.manage_tabs", user_browser_read: "computerpanel.read_page_content", user_browser_dialog: "computerpanel.handle_browser_dialogs",
  user_browser_wait: "computerpanel.wait_for_the_page",
  desktop_screenshot: "computerpanel.view_the_local_desktop", desktop_click: "computerpanel.click_on_the_desktop", desktop_move: "computerpanel.move_mouse",
  desktop_drag: "computerpanel.drag", desktop_scroll: "computerpanel.scroll", desktop_type: "computerpanel.type_text", desktop_key: "computerpanel.press_keys",
  desktop_app: "computerpanel.open_or_switch_applications", desktop_wait: "computerpanel.wait_for_an_application",
  computer_mode: "computerpanel.switch_target", request_desktop_control: "computerpanel.switch_target",
};

export function stepLabel(name, detail = "") {
  const key = STEP_KEYS[name];
  const label = key ? tr(key) : tr("computerpanel.computer_use");
  return detail ? `${label} · ${detail}` : label;
}

const PHASE_KEYS = {
  thinking: "computerpanel.phase_thinking", observing: "computerpanel.phase_observing", acting: "computerpanel.phase_acting",
  waiting: "computerpanel.phase_waiting", "waiting-user": "computerpanel.phase_waiting_user", paused: "computerpanel.phase_paused",
  failed: "computerpanel.phase_failed", idle: "computerpanel.idle",
};

/** Purpose: One line for what the agent is doing. Input: phase, current tool, its detail. */
export function phaseLabel(phase, current = null, detail = "") {
  const base = tr(PHASE_KEYS[phase] || PHASE_KEYS.idle);
  if ((phase === "acting" || phase === "observing" || phase === "waiting") && current) return stepLabel(current, detail);
  return base;
}

export const MODE_LABEL_KEYS = { browser: "computerpanel.built_in_browser", user: "computerpanel.user_browser", host: "computerpanel.local_computer" };
