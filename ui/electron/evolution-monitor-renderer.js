const element = id => document.getElementById(id);
const labels = { queued: "已保存 · 等待会话空闲", started: "已提交", completed: "已处理", interrupted: "执行中断，请核对会话后继续", cancelled: "已取消" };
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
    const signature = JSON.stringify(item);
    const previous = nodes.get(item.id);
    if (previous?.signature === signature) continue;
    let node;
    if (item.type === "tool" || item.type === "thought") {
      node = document.createElement("details"); node.className = `${item.type} ${item.status || ""}`;
      node.open = previous?.node.open || false;
      const result = { running: "进行中", done: "完成", error: "失败", interrupted: "中断" }[item.status] || "";
      node.append(text("summary", item.type === "tool" ? `⌁ ${item.name || "工具调用"} · ${result}` : `过程说明 · ${result}`));
      if (item.command) node.append(text("pre", item.command));
      if (item.output || item.content) node.append(text("pre", item.output || item.content));
    } else if (item.type === "message") {
      node = text("article", "", item.role === "user" ? "user" : "assistant");
      node.append(text("span", item.role === "user" ? "你" : "Cleo", "role"), text("div", item.content));
    } else if (item.type === "plan") {
      node = text("article", (item.steps || []).map(step => `${step.status === "done" ? "✓" : "·"} ${step.label || step.title || step.step}`).join("\n"), "plan");
    } else if (item.type === "notice") node = text("article", `${item.title || ""}\n${item.detail || ""}`, "notice");
    else continue;
    if (previous) previous.node.replaceWith(node); else pane.append(node);
    nodes.set(item.id, { node, signature });
  }
  for (const [id, entry] of nodes) if (!keep.has(id)) { entry.node.remove(); nodes.delete(id); }
  let empty = pane.querySelector(".empty");
  if (!nodes.size && !empty) { empty = text("div", "在主窗口选择 harness 并开始进化。\n这里同步展示对话和工具过程。", "empty"); pane.append(empty); }
  else if (nodes.size) empty?.remove();
}
function renderQuestions(requests) {
  const pending = requests.filter(request => request.status === "pending");
  const key = pending.map(request => request.id).join("|");
  if (key === questionKey) return;
  questionKey = key; element("questions").replaceChildren();
  for (const request of pending) {
    const form = document.createElement("form"); form.className = "question";
    if (request.questions.some(question => question.secret)) { form.append(text("p", "此问题涉及敏感输入，请在 Cleo 主窗口回答。")); element("questions").append(form); continue; }
    for (const question of request.questions) {
      const field = document.createElement("fieldset"); field.dataset.id = question.id;
      field.append(text("legend", question.question));
      for (const option of question.options || []) {
        const label = document.createElement("label"); const input = document.createElement("input");
        input.type = question.multiple ? "checkbox" : "radio"; input.name = question.id; input.value = option.label;
        label.append(input, document.createTextNode(` ${option.label}`));
        if (option.description) label.append(text("small", option.description)); field.append(label);
      }
      const free = document.createElement("input"); free.type = "text"; free.placeholder = "也可以直接输入你的选择"; free.setAttribute("aria-label", question.question);
      field.append(free); form.append(field);
    }
    const submit = text("button", "提交回答"); submit.type = "submit"; form.append(submit);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const answers = Object.fromEntries([...form.querySelectorAll("fieldset")].map(field => {
        const free = field.querySelector("input[type=text]").value.trim();
        return [field.dataset.id, free ? [free] : [...field.querySelectorAll("input:checked")].map(input => input.value)];
      }));
      if (Object.values(answers).some(values => !values.length)) { element("error").textContent = "请回答每一个问题。"; return; }
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
    const scroll = element("conversation"); const follow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
    element("phase").textContent = state.phase; element("detail").textContent = state.detail;
    document.body.classList.toggle("offline", !state.connected);
    element("logs").textContent = state.logs;
    element("send").disabled = busy || !state.threadId;
    element("stop").disabled = !state.connected;
    element("discard").disabled = !state.connected || !state.canDiscard;
    element("resume").hidden = !state.paused;
    element("hint").textContent = state.paused ? "已暂停自动继续。补充需求会保留，点击继续处理消息后执行。" : "同一会话 · 回复与工具实时同步 · 重启期间消息保留";
    renderTimeline(state.thread?.items || []);
    renderQuestions(state.connected ? state.thread?.pendingQuestions || [] : []);
    element("messages").replaceChildren(...state.messages.filter(message => ["queued", "interrupted", "cancelled"].includes(message.status)).slice(-5).map(message => {
      const row = text("div", message.body, "queued"); row.append(text("small", labels[message.status])); return row;
    }));
    renderActions(state);
    const command = state.commands?.at(-1);
    element("control-status").textContent = command ? command.status === "error" ? command.detail : command.status === "completed" ? "操作已完成" : "正在处理操作…" : "";
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
  check.textContent = actions?.checkFailed ? "重新检查" : "检查改动";
  check.disabled = !idle || !canCheck;
  check.title = !state.connected ? "主程序尚未连接" : state.running ? "agent 正在修改，完成后再检查"
    : actions?.unchanged ? "暂无程序改动" : !canCheck ? "暂无需要检查的改动" : "检查并构建本轮改动";
  element("apply").hidden = !actions?.canApply;
  element("apply").disabled = !idle;
  element("save").hidden = !actions?.canSave;
  element("save").disabled = !idle;
  if (!actions?.canSave) element("save-form").hidden = true;
  element("version-name").placeholder = actions?.suggestedName ? `默认：${actions.suggestedName}` : "版本名称";
  element("save-hint").textContent = actions?.suggestedName
    ? `留空则使用 ${actions.suggestedName}（上一个版本号末位加 1）。` : "留空则使用默认名称。";
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
