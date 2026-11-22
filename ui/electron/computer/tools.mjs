import { t as tr } from "../i18n.mjs";
/** Model-facing tool catalogs. The built-in browser, the user's own browser and the desktop are
 * separate families with separate screenshot ids, so a coordinate from one target can never be
 * applied to another. ``computer_mode`` is offered in every mode: the agent picks the target,
 * and the broker decides what a switch needs (nothing, a connected extension, or the user's OK).
 */

const integer = (description, minimum = 0) => ({ type: "integer", minimum, description });
const point = { get x() { return integer(tr("tools.horizontal_coordinate_in_the_screenshot_image_in_pixels")); }, get y() { return integer(tr("tools.vertical_coordinate_in_the_screenshot_image_in_pixels")); } };
const screenshot = { type: "string", get description() { return tr("tools.screenshot_id_returned_by_the_latest_screenshot"); } };
const tab = { type: "string", get description() { return tr("tools.tab_id_from_the_screenshot_it_must_be_the_currently_displayed_tab"); } };
const userTab = { type: "string", get description() { return tr("tools.ub_tab_id"); } };
const fromTo = {
  get from_x() { return integer(tr("tools.starting_horizontal_coordinate")); }, get from_y() { return integer(tr("tools.starting_vertical_coordinate")); },
  get to_x() { return integer(tr("tools.ending_horizontal_coordinate")); }, get to_y() { return integer(tr("tools.ending_vertical_coordinate")); },
};
const button = { type: "string", enum: ["left", "right", "middle"], default: "left" };
const clicks = { type: "integer", enum: [1, 2], default: 1 };
const direction = { type: "string", enum: ["up", "down", "left", "right"] };
const amount = { type: "integer", minimum: 1, maximum: 20, default: 3 };
const seconds = { type: "number", minimum: 0, maximum: 10, default: 1 };

function tool(name, description, properties = {}, required = []) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

export const MODE_TARGETS = ["builtin_browser", "user_browser", "desktop"];
/** Broker modes behind the model-facing targets. */
export const TARGET_MODE = { builtin_browser: "browser", user_browser: "user", desktop: "host" };

const MODE_TOOL = tool("computer_mode", tr("tools.computer_mode"), {
  target: { type: "string", enum: MODE_TARGETS },
  get reason() { return { type: "string", maxLength: 300, description: tr("tools.computer_mode_reason") }; },
}, ["target", "reason"]);

export const BROWSER_TOOLS = [
  tool("browser_screenshot", tr("tools.capture_the_tab_currently_displayed_in_cleo_s_built_in_browser_returns_the_image_tab_"), { tab_id: tab }),
  tool("browser_click", tr("tools.click_at_coordinates_in_a_built_in_browser_screenshot_affects_only_that_browser_and_d"), {
    tab_id: tab, screenshot_id: screenshot, ...point, button, clicks,
  }, ["tab_id", "screenshot_id", "x", "y"]),
  tool("browser_move", tr("tools.move_the_built_in_browser_pointer_to_screenshot_coordinates_to_hover"), { tab_id: tab, screenshot_id: screenshot, ...point }, ["tab_id", "screenshot_id", "x", "y"]),
  tool("browser_drag", tr("tools.hold_the_left_mouse_button_and_drag_between_screenshot_coordinates_in_the_built_in_br"), {
    tab_id: tab, screenshot_id: screenshot, ...fromTo,
  }, ["tab_id", "screenshot_id", "from_x", "from_y", "to_x", "to_y"]),
  tool("browser_scroll", tr("tools.scroll_the_mouse_wheel_at_coordinates_in_a_built_in_browser_screenshot"), {
    tab_id: tab, screenshot_id: screenshot, ...point, direction, amount,
  }, ["tab_id", "screenshot_id", "x", "y", "direction"]),
  tool("browser_type", tr("tools.type_text_including_chinese_at_the_currently_focused_input_in_the_built_in_browser_cl"), {
    tab_id: tab, screenshot_id: screenshot,
    text: { type: "string", maxLength: 20000 }, submit: { type: "boolean", default: false },
  }, ["tab_id", "screenshot_id", "text"]),
  tool("browser_key", tr("tools.press_a_key_or_shortcut_in_the_built_in_browser_such_as_enter_tab_escape_ctrl_a_ctrl_"), {
    tab_id: tab, screenshot_id: screenshot, keys: { type: "string", maxLength: 60 },
  }, ["tab_id", "screenshot_id", "keys"]),
  tool("browser_navigate", tr("tools.open_a_url_in_a_built_in_browser_tab_http_https_a_localhost_development_server_or_a_w"), {
    tab_id: tab, url: { type: "string", maxLength: 8192 },
  }, ["url"]),
  tool("browser_history", tr("tools.navigate_back_or_forward_reload_or_stop_loading_in_a_built_in_browser_tab"), {
    tab_id: tab, action: { type: "string", enum: ["back", "forward", "reload", "stop"] },
  }, ["tab_id", "action"]),
  tool("browser_tabs", tr("tools.list_create_switch_or_close_built_in_browser_tabs_switching_changes_the_displayed_tab"), {
    action: { type: "string", enum: ["list", "new", "switch", "close"] },
    tab_id: tab, url: { type: "string", maxLength: 8192 },
  }, ["action"]),
  tool("browser_read", tr("tools.read_the_active_tab_s_visible_text_and_interactive_elements_dom_assistance_coordinate"), {
    tab_id: tab, max_chars: { type: "integer", minimum: 500, maximum: 20000, default: 6000 },
  }, ["tab_id"]),
  tool("browser_dialog", tr("tools.handle_a_page_s_alert_confirm_prompt_or_beforeunload_dialog"), {
    tab_id: tab, accept: { type: "boolean" }, text: { type: "string", maxLength: 2000 },
  }, ["tab_id", "accept"]),
  tool("browser_upload", tr("tools.after_a_page_opens_a_file_chooser_upload_files_from_the_current_task_s_working_direct"), {
    tab_id: tab, paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
  }, ["tab_id", "paths"]),
  tool("browser_wait", tr("tools.wait_up_to_10_seconds_for_page_loading_or_animation_then_take_a_new_screenshot"), { seconds }),
  MODE_TOOL,
];

/** The user's own Chrome or Edge, reached through the Cleo extension. Every action is a
 * browser-level event on one tab; nothing here moves the real pointer or focuses a window.
 */
export const USER_BROWSER_TOOLS = [
  tool("user_browser_tabs", tr("tools.ub_tabs"), {
    action: { type: "string", enum: ["list", "open", "close"] },
    tab_id: userTab, url: { type: "string", maxLength: 8192 },
  }, ["action"]),
  tool("user_browser_screenshot", tr("tools.ub_screenshot"), { tab_id: userTab }, ["tab_id"]),
  tool("user_browser_click", tr("tools.ub_click"), { tab_id: userTab, screenshot_id: screenshot, ...point, button, clicks }, ["tab_id", "screenshot_id", "x", "y"]),
  tool("user_browser_move", tr("tools.ub_move"), { tab_id: userTab, screenshot_id: screenshot, ...point }, ["tab_id", "screenshot_id", "x", "y"]),
  tool("user_browser_drag", tr("tools.ub_drag"), { tab_id: userTab, screenshot_id: screenshot, ...fromTo }, ["tab_id", "screenshot_id", "from_x", "from_y", "to_x", "to_y"]),
  tool("user_browser_scroll", tr("tools.ub_scroll"), { tab_id: userTab, screenshot_id: screenshot, ...point, direction, amount }, ["tab_id", "screenshot_id", "x", "y", "direction"]),
  tool("user_browser_type", tr("tools.ub_type"), {
    tab_id: userTab, screenshot_id: screenshot, text: { type: "string", maxLength: 20000 }, submit: { type: "boolean", default: false },
  }, ["tab_id", "screenshot_id", "text"]),
  tool("user_browser_key", tr("tools.ub_key"), { tab_id: userTab, screenshot_id: screenshot, keys: { type: "string", maxLength: 60 } }, ["tab_id", "screenshot_id", "keys"]),
  tool("user_browser_navigate", tr("tools.ub_navigate"), { tab_id: userTab, url: { type: "string", maxLength: 8192 } }, ["tab_id", "url"]),
  tool("user_browser_history", tr("tools.ub_history"), { tab_id: userTab, action: { type: "string", enum: ["back", "forward", "reload", "stop"] } }, ["tab_id", "action"]),
  tool("user_browser_read", tr("tools.ub_read"), { tab_id: userTab, max_chars: { type: "integer", minimum: 500, maximum: 20000, default: 6000 } }, ["tab_id"]),
  tool("user_browser_dialog", tr("tools.ub_dialog"), { tab_id: userTab, accept: { type: "boolean" }, text: { type: "string", maxLength: 2000 } }, ["tab_id", "accept"]),
  tool("user_browser_wait", tr("tools.wait_up_to_10_seconds_for_page_loading_or_animation_then_take_a_new_screenshot"), { seconds }),
  MODE_TOOL,
];

export const DESKTOP_TOOLS = [
  tool("desktop_screenshot", tr("tools.capture_the_local_windows_desktop_returns_the_image_screenshot_id_and_display_and_win"), {
    display: { anyOf: [{ type: "integer", minimum: 0 }, { type: "string", enum: ["all"] }] },
  }),
  tool("desktop_click", tr("tools.use_the_real_mouse_to_click_at_local_screenshot_coordinates"), {
    screenshot_id: screenshot, ...point, button, clicks,
  }, ["screenshot_id", "x", "y"]),
  tool("desktop_move", tr("tools.move_the_real_mouse_to_local_screenshot_coordinates_to_hover"), { screenshot_id: screenshot, ...point }, ["screenshot_id", "x", "y"]),
  tool("desktop_drag", tr("tools.hold_the_left_mouse_button_and_drag_between_local_screenshot_coordinates"), {
    screenshot_id: screenshot, ...fromTo,
  }, ["screenshot_id", "from_x", "from_y", "to_x", "to_y"]),
  tool("desktop_scroll", tr("tools.scroll_the_mouse_wheel_at_local_screenshot_coordinates"), {
    screenshot_id: screenshot, ...point, direction, amount,
  }, ["screenshot_id", "x", "y", "direction"]),
  tool("desktop_type", tr("tools.use_the_real_keyboard_to_type_text_including_chinese_into_the_foreground_window_click"), {
    screenshot_id: screenshot, text: { type: "string", maxLength: 20000 },
  }, ["screenshot_id", "text"]),
  tool("desktop_key", tr("tools.press_a_key_or_shortcut_on_the_local_computer_such_as_enter_alt_tab_ctrl_s_or_win"), {
    screenshot_id: screenshot, keys: { type: "string", maxLength: 60 },
  }, ["screenshot_id", "keys"]),
  tool("desktop_app", tr("tools.launch_an_application_by_searching_its_name_in_the_start_menu_or_switch_to_a_window_w"), {
    screenshot_id: screenshot,
    action: { type: "string", enum: ["launch", "switch"] }, name: { type: "string", minLength: 1, maxLength: 120 },
  }, ["screenshot_id", "action", "name"]),
  tool("desktop_wait", tr("tools.wait_up_to_10_seconds_for_a_local_application_to_load_then_take_a_new_screenshot"), { seconds }),
  MODE_TOOL,
];

export const INPUT_TOOLS = new Set([
  "browser_click", "browser_move", "browser_drag", "browser_scroll", "browser_type", "browser_key",
  "user_browser_click", "user_browser_move", "user_browser_drag", "user_browser_scroll", "user_browser_type", "user_browser_key",
  "desktop_click", "desktop_move", "desktop_drag", "desktop_scroll", "desktop_type", "desktop_key", "desktop_app",
]);

/** Waiting tools: time spent in them counts as waiting for the page or app, not as work. */
export const WAIT_TOOLS = new Set(["browser_wait", "user_browser_wait", "desktop_wait"]);

/** The control target a tool acts on: browser, user, desktop, or "mode" for a mode switch.
 * ``request_desktop_control`` is the pre-#160 name; it is still understood as a desktop switch.
 */
export function family(name) {
  if (name === "computer_mode" || name === "request_desktop_control") return "mode";
  if (/^user_browser_/.test(name)) return "user";
  if (/^browser_/.test(name)) return "browser";
  if (/^desktop_/.test(name)) return "desktop";
  return null;
}

/** The broker mode a target family belongs to. */
export const FAMILY_MODE = { browser: "browser", user: "user", desktop: "host" };
export const MODE_FAMILY = { browser: "browser", user: "user", host: "desktop" };

export function catalogFor(mode) {
  return mode === "host" ? DESKTOP_TOOLS : mode === "user" ? USER_BROWSER_TOOLS : BROWSER_TOOLS;
}
