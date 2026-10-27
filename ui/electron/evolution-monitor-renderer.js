import { t as tr, getLanguage, setLanguage } from "./i18n.mjs";

function applyLanguage(language) {
  setLanguage(language);
  document.documentElement.lang = language;
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = tr(node.dataset.i18n);
  for (const attribute of ["title", "aria-label", "placeholder"]) {
    for (const node of document.querySelectorAll(`[data-i18n-${attribute}]`)) node.setAttribute(attribute, tr(node.getAttribute(`data-i18n-${attribute}`)));
  }
}
applyLanguage(window.cleoMonitor.language ?? "zh-CN");
const element = id => document.getElementById(id);
const labels = { get queued() { return tr("evolution_monitor_renderer.saved_waiting_for_the_conversation_to_become_idle"); }, get started() { return tr("evolution_monitor_renderer.submitted"); }, get completed() { return tr("evolution_monitor_renderer.processed"); }, get interrupted() { return tr("evolution_monitor_renderer.execution_interrupted_check_the_conversation_before_continuing"); }, get cancelled() { return tr("timing.cancelled"); } };
let busy = false, refreshing = false, latest = null, questionKey = "";
const nodes = new Map();
const text = (tag, value, className = "") => { const node = document.createElement(tag); node.textContent = value || ""; node.className = className; return node; };
const errorText = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, "");

/** Purpose: Render only data from the existing timeline, preserving expanded tool rows across updates.
 * Input: bounded projected items. Output: text-only DOM, never executable agent HTML.
 */
function renderTimeline(items) {
  const pane = element("timeline");
  const keep = new Set();
  for (const item of items) {
    if (item.type === "question") continue;
    keep.add(item.id);
    const signature = `${getLanguage()}:${JSON.stringify(item)}`;
    const previous = nodes.get(item.id);
    if (previous?.signature === signature) continue;
    let node;
    if (item.type === "tool" || item.type === "thought") {
      node = document.createElement("details"); node.className = `${item.type} ${item.status || ""}`;
      node.open = previous?.node.open || false;
      const result = { running: tr("computerpanel.in_progress"), done: tr("conversation.done"), error: tr("conversation.failed"), interrupted: tr("evolution_monitor_renderer.interrupted") }[item.status] || "";
      node.append(text("summary", item.type === "tool" ? `⌁ ${item.name || tr("memoryview.tool_call")} · ${result}` : tr("evolution_monitor_renderer.progress_details_value", { p0: result })));
      if (item.command) node.append(text("pre", item.command));
      if (item.output || item.content) node.append(text("pre", item.output || item.content));
    } else if (item.type === "message") {
      node = text("article", "", item.role === "user" ? "user" : "assistant");
      node.append(text("span", item.role === "user" ? tr("evolutioncases.you") : "Cleo", "role"), text("div", item.content));
    } else if (item.type === "plan") {
      node = text("article", (item.steps || []).map(step => `${step.status === "done" ? "✓" : "·"} ${step.label || step.title || step.step}`).join("\n"), "plan");
    } else if (item.type === "notice") node = text("article", `${item.title || ""}\n${item.detail || ""}`, "notice");
    else continue;
    if (previous) previous.node.replaceWith(node); else pane.append(node);
    nodes.set(item.id, { node, signature });
  }
  for (const [id, entry] of nodes) if (!keep.has(id)) { entry.node.remove(); nodes.delete(id); }
  let empty = pane.querySelector(".empty");
  if (!nodes.size && !empty) { empty = text("div", tr("evolution_monitor_renderer.no_conversation_yet"), "empty"); pane.append(empty); }
  else if (nodes.size) empty?.remove();
}
function renderQuestions(requests) {
  const pending = requests.filter(request => request.status === "pending");
  const key = pending.map(request => request.id).join("|");
  if (key === questionKey) return;
  questionKey = key; element("questions").replaceChildren();
  for (const request of pending) {
    const form = document.createElement("form"); form.className = "question";
    if (request.questions.some(question => question.secret)) { form.append(text("p", tr("evolution_monitor_renderer.this_question_involves_sensitive_input_answer_it_in_cleo_s_main_window"))); element("questions").append(form); continue; }
    for (const question of request.questions) {
      const field = document.createElement("fieldset"); field.dataset.id = question.id;
      field.append(text("legend", question.question));
      for (const option of question.options || []) {
        const label = document.createElement("label"); const input = document.createElement("input");
        input.type = question.multiple ? "checkbox" : "radio"; input.name = question.id; input.value = option.label;
        label.append(input, document.createTextNode(` ${option.label}`));
        if (option.description) label.append(text("small", option.description)); field.append(label);
      }
      const free = document.createElement("input"); free.type = "text"; free.placeholder = tr("evolution_monitor_renderer.you_can_also_type_your_choice"); free.setAttribute("aria-label", question.question);
      field.append(free); form.append(field);
    }
    const submit = text("button", tr("evolution_monitor_renderer.submit_answer")); submit.type = "submit"; form.append(submit);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const answers = Object.fromEntries([...form.querySelectorAll("fieldset")].map(field => {
        const free = field.querySelector("input[type=text]").value.trim();
        return [field.dataset.id, free ? [free] : [...field.querySelectorAll("input:checked")].map(input => input.value)];
      }));
      if (Object.values(answers).some(values => !values.length)) { element("error").textContent = tr("evolution_monitor_renderer.answer_every_question"); return; }
      submit.disabled = true;
      try { await window.cleoMonitor.control("answer", { questionId: request.id, answers }); }
      catch (error) { element("error").textContent = errorText(error); }
      finally { submit.disabled = false; }
    });
    element("questions").append(form);
  }
}
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    const state = await window.cleoMonitor.status(); latest = state;
    if (state.uiLanguage && state.uiLanguage !== getLanguage()) applyLanguage(state.uiLanguage);
    const scroll = element("conversation"); const follow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
    element("phase").textContent = state.phase; element("detail").textContent = state.detail;
    document.body.classList.toggle("offline", !state.connected);
    element("logs").textContent = state.logs;
    element("send").disabled = busy || !state.threadId;
    element("stop").disabled = !state.connected;
    element("discard").disabled = !state.connected || !state.canDiscard;
    element("resume").hidden = !state.paused;
    element("hint").textContent = state.paused ? tr("evolution_monitor_renderer.paused_click_continue_messages_to_execute") : "";
    renderTimeline(state.thread?.items || []);
    renderQuestions(state.connected ? state.thread?.pendingQuestions || [] : []);
    element("messages").replaceChildren(...state.messages.filter(message => ["queued", "interrupted", "cancelled"].includes(message.status)).slice(-5).map(message => {
      const row = text("div", message.body, "queued"); row.append(text("small", labels[message.status])); return row;
    }));
    renderActions(state);
    const command = state.commands?.at(-1);
    element("control-status").textContent = command ? command.status === "error" ? command.detail : command.status === "completed" ? tr("evolution_monitor_renderer.operation_completed") : tr("evolution_monitor_renderer.processing_operation") : "";
    if (follow) scroll.scrollTop = scroll.scrollHeight;
  } catch (error) { element("error").textContent = errorText(error); }
  finally { refreshing = false; }
}
/** Purpose: Offer check -> apply -> save here, next to version recovery, using the main
 * program's own readiness. Input: status snapshot. Output: at most one primary action visible.
 */
function renderActions(state) {
  const actions = state.connected ? state.actions : null;
  // Apply/rollback restart Cleo, so an old "started" receipt must not lock the buttons forever.
  const pending = (state.commands || []).some(command => (!command.status || command.status === "started")
    && Date.now() - (command.createdAt || 0) < 5 * 60 * 1000);
  const idle = state.connected && !state.running && !actions?.busy && !pending;
  const canCheck = Boolean(actions && (actions.needsCheck || actions.checkFailed));
  const check = element("check");
  check.hidden = Boolean(actions?.canApply || actions?.canSave);
  check.textContent = actions?.checkFailed ? tr("dependencysetup.check_again") : tr("evolutionpanel.check_changes");
  check.disabled = !idle || !canCheck;
  check.title = !state.connected ? tr("evolution_monitor_renderer.main_program_not_connected") : state.running ? tr("evolution_monitor_renderer.the_agent_is_editing_run_checks_after_it_finishes")
    : actions?.unchanged ? tr("evolutionpanel.no_program_changes") : !canCheck ? tr("evolution_monitor_renderer.no_changes_need_checking") : tr("evolution_monitor_renderer.check_and_build_this_iteration_s_changes");
  element("apply").hidden = !actions?.canApply;
  element("apply").disabled = !idle;
  element("save").hidden = !actions?.canSave;
  element("save").disabled = !idle;
  if (!actions?.canSave) element("save-form").hidden = true;
  element("version-name").placeholder = actions?.suggestedName ? tr("evolution_monitor_renderer.default_value", { p0: actions.suggestedName }) : tr("evolution_monitor_renderer.version_name");
}
const actionNames = { check: "build", apply: "apply", stop: "stop", discard: "discard", recovery: "recovery", resume: "resume", emergency: "emergency" };
for (const [id, action] of Object.entries(actionNames)) element(id).addEventListener("click", async () => {
  element(id).disabled = true; element("error").textContent = "";
  try { await window.cleoMonitor.control(action); }
  catch (error) { element("error").textContent = errorText(error); }
  finally { element(id).disabled = false; await refresh(); }
});
element("save").addEventListener("click", () => {
  element("save-form").hidden = false; element("version-name").value = ""; element("version-name").focus();
});
element("save-cancel").addEventListener("click", () => { element("save-form").hidden = true; });
element("save-form").addEventListener("submit", async event => {
  event.preventDefault(); element("error").textContent = "";
  const submit = element("save-form").querySelector("button[type=submit]"); submit.disabled = true;
  try {
    await window.cleoMonitor.control("save", { name: element("version-name").value.trim() });
    element("save-form").hidden = true;
  } catch (error) { element("error").textContent = errorText(error); }
  finally { submit.disabled = false; await refresh(); }
});
element("form").addEventListener("submit", async event => {
  event.preventDefault(); if (busy || !element("body").value.trim()) return;
  busy = true; element("send").disabled = true;
  try { await window.cleoMonitor.send(element("body").value); element("body").value = ""; element("error").textContent = ""; }
  catch (error) { element("error").textContent = errorText(error); }
  finally { busy = false; await refresh(); }
});
element("body").addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); element("form").requestSubmit(); } });
void refresh(); setInterval(() => void refresh(), 1000);
