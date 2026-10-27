import { t as tr } from "../i18n.mjs";
/** Model-facing tool catalogs. Browser and desktop tools are separate families with separate
 * screenshot ids, so a coordinate from one target can never be applied to the other.
 */

const integer = (description, minimum = 0) => ({ type: "integer", minimum, description });
const point = { get x() { return integer(tr("tools.horizontal_coordinate_in_the_screenshot_image_in_pixels")); }, get y() { return integer(tr("tools.vertical_coordinate_in_the_screenshot_image_in_pixels")); } };
const screenshot = { type: "string", get description() { return tr("tools.screenshot_id_returned_by_the_latest_screenshot"); } };
const tab = { type: "string", get description() { return tr("tools.tab_id_from_the_screenshot_it_must_be_the_currently_displayed_tab"); } };

function tool(name, description, properties = {}, required = []) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

export const BROWSER_TOOLS = [
  tool("browser_screenshot", tr("tools.capture_the_tab_currently_displayed_in_cleo_s_built_in_browser_returns_the_image_tab_"), { tab_id: tab }),
  tool("browser_click", tr("tools.click_at_coordinates_in_a_built_in_browser_screenshot_affects_only_that_browser_and_d"), {
    tab_id: tab, screenshot_id: screenshot, ...point,
    button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
    clicks: { type: "integer", enum: [1, 2], default: 1 },
  }, ["tab_id", "screenshot_id", "x", "y"]),
  tool("browser_move", tr("tools.move_the_built_in_browser_pointer_to_screenshot_coordinates_to_hover"), { tab_id: tab, screenshot_id: screenshot, ...point }, ["tab_id", "screenshot_id", "x", "y"]),
  tool("browser_drag", tr("tools.hold_the_left_mouse_button_and_drag_between_screenshot_coordinates_in_the_built_in_br"), {
    tab_id: tab, screenshot_id: screenshot,
    get from_x() { return integer(tr("tools.starting_horizontal_coordinate")); }, get from_y() { return integer(tr("tools.starting_vertical_coordinate")); }, get to_x() { return integer(tr("tools.ending_horizontal_coordinate")); }, get to_y() { return integer(tr("tools.ending_vertical_coordinate")); },
  }, ["tab_id", "screenshot_id", "from_x", "from_y", "to_x", "to_y"]),
  tool("browser_scroll", tr("tools.scroll_the_mouse_wheel_at_coordinates_in_a_built_in_browser_screenshot"), {
    tab_id: tab, screenshot_id: screenshot, ...point,
    direction: { type: "string", enum: ["up", "down", "left", "right"] },
    amount: { type: "integer", minimum: 1, maximum: 20, default: 3 },
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
  tool("browser_wait", tr("tools.wait_up_to_10_seconds_for_page_loading_or_animation_then_take_a_new_screenshot"), {
    seconds: { type: "number", minimum: 0, maximum: 10, default: 1 },
  }),
  tool("request_desktop_control", tr("tools.request_user_authorization_to_switch_to_local_computer_mode_which_uses_the_real_mouse"), {
    get reason() { return { type: "string", maxLength: 300, description: tr("tools.explain_to_the_user_why_local_computer_control_is_needed") }; },
  }, ["reason"]),
];

export const DESKTOP_TOOLS = [
  tool("desktop_screenshot", tr("tools.capture_the_local_windows_desktop_returns_the_image_screenshot_id_and_display_and_win"), {
    display: { anyOf: [{ type: "integer", minimum: 0 }, { type: "string", enum: ["all"] }] },
  }),
  tool("desktop_click", tr("tools.use_the_real_mouse_to_click_at_local_screenshot_coordinates"), {
    screenshot_id: screenshot, ...point,
    button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
    clicks: { type: "integer", enum: [1, 2], default: 1 },
  }, ["screenshot_id", "x", "y"]),
  tool("desktop_move", tr("tools.move_the_real_mouse_to_local_screenshot_coordinates_to_hover"), { screenshot_id: screenshot, ...point }, ["screenshot_id", "x", "y"]),
  tool("desktop_drag", tr("tools.hold_the_left_mouse_button_and_drag_between_local_screenshot_coordinates"), {
    screenshot_id: screenshot,
    get from_x() { return integer(tr("tools.starting_horizontal_coordinate")); }, get from_y() { return integer(tr("tools.starting_vertical_coordinate")); }, get to_x() { return integer(tr("tools.ending_horizontal_coordinate")); }, get to_y() { return integer(tr("tools.ending_vertical_coordinate")); },
  }, ["screenshot_id", "from_x", "from_y", "to_x", "to_y"]),
  tool("desktop_scroll", tr("tools.scroll_the_mouse_wheel_at_local_screenshot_coordinates"), {
    screenshot_id: screenshot, ...point,
    direction: { type: "string", enum: ["up", "down", "left", "right"] },
    amount: { type: "integer", minimum: 1, maximum: 20, default: 3 },
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
  tool("desktop_wait", tr("tools.wait_up_to_10_seconds_for_a_local_application_to_load_then_take_a_new_screenshot"), {
    seconds: { type: "number", minimum: 0, maximum: 10, default: 1 },
  }),
];

export const INPUT_TOOLS = new Set([
  "browser_click", "browser_move", "browser_drag", "browser_scroll", "browser_type", "browser_key",
  "desktop_click", "desktop_move", "desktop_drag", "desktop_scroll", "desktop_type", "desktop_key", "desktop_app",
]);

export function family(name) {
  if (name === "request_desktop_control" || /^browser_/.test(name)) return "browser";
  if (/^desktop_/.test(name)) return "desktop";
  return null;
}

export function catalogFor(mode) {
  return mode === "host" ? DESKTOP_TOOLS : BROWSER_TOOLS;
}
