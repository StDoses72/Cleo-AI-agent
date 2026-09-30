import { evolutionActions } from "./evolution-actions.mjs";

/** Purpose: Project the existing agent stream into a durable companion view and route user controls.
 * Input: the same backend, version manager and append-only monitor store.
 * Output: bounded chat/tool snapshots and serialized controls; no second agent or version registry.
 */
export class EvolutionCompanion {
  constructor({ store, backend, evolution, ready, turn, stop, discard, rollback, build, apply, save, notify = () => {} }) {
    Object.assign(this, { store, backend, evolution, ready, turn, stop, discard, rollback, build, apply, save, notify });
    this.thread = null; this.controlling = false; this.turnTask = null; this.loading = false;
    this.commandGate = false;
  }
  async load(threadId) {
    if (!threadId || this.loading) return;
    this.loading = true;
    try { this.thread = await this.backend.request("load_thread", { thread_id: threadId, activate: false }); this.notify(this.thread); }
    finally { this.loading = false; }
  }
  event(threadId, event) {
    if (this.thread?.id !== threadId) this.thread = { id: threadId, items: [], pendingQuestions: [] };
    const thread = this.thread;
    if (event.type === "turn-started" || event.type === "upsert-item") {
      const index = thread.items.findIndex(item => item.id === event.item.id);
      if (index < 0) thread.items.push(event.item); else thread.items[index] = event.item;
      thread.items = thread.items.slice(-80);
      if (event.type === "turn-started") { thread.status = "running"; thread.steerReady = true; }
    } else if (event.type === "question-request") {
      thread.pendingQuestions = [...(thread.pendingQuestions || []).filter(q => q.id !== event.request.id), event.request];
    } else if (event.type === "question-resolved") {
      thread.pendingQuestions = (thread.pendingQuestions || []).filter(q => q.id !== event.request.id);
    } else if (event.type === "changes") thread.changes = event.changes;
    else if (event.type === "runtime") thread.runtime = event.runtime;
    else if (event.type === "error") {
      thread.status = "attention";
      thread.items.push({ id: `error-${Date.now()}`, type: "notice", title: "运行需要查看", detail: event.message });
    } else if (event.type === "done") { thread.status = "completed"; thread.activeRunId = null; }
  }
  snapshot() {
    if (!this.thread) return null;
    // Bounded copies preserve the original full transcript in the normal task history.
    return { ...this.thread, terminal: [], changeHistory: [], skills: [],
      items: this.thread.items.slice(-80).map(item => Object.fromEntries(Object.entries(item).map(([key, value]) =>
        [key, typeof value === "string" ? value.slice(-16000) : value]))) };
  }
  async control(command, state) {
    if (command.threadId !== state.threadId) throw new Error("进化会话已改变，请重新选择操作。");
    const { action, params } = command;
    if (action === "answer") {
      const pending = await this.backend.request("get_pending_questions", { thread_id: command.threadId });
      const question = pending.find(q => q.id === params.questionId);
      if (!question) throw new Error("问题已结束或连接已恢复，请等待 agent 重新提问。");
      if (question.questions.some(q => q.secret)) throw new Error("敏感输入请在主窗口回答。");
      if (!params.answers || question.questions.some(q => !Array.isArray(params.answers[q.id]) || !params.answers[q.id].length)) throw new Error("请回答每个问题。");
      await this.backend.request("resolve_question", { thread_id: command.threadId, question_id: params.questionId, answers: params.answers });
      this.event(command.threadId, { type: "question-resolved", request: { id: params.questionId } });
      return;
    }
    if (action === "resume") { await this.store.pause(false); return; }
    if (["build", "apply", "save"].includes(action)) {
      if (state.transaction) throw new Error("版本正在切换，请等待当前流程结束。");
      if (!this.ready()) throw new Error("Cleo 正在修改或检查，请等当前步骤结束后再操作。");
      const actions = evolutionActions(await this.evolution.status());
      if (action === "build") {
        if (!actions.needsCheck && !actions.checkFailed) throw new Error("暂无需要检查的改动。");
        await this.build();
      } else if (action === "apply") {
        if (!actions.canApply) throw new Error("检查尚未通过或改动已变化，请重新检查。");
        // Applying restarts Cleo; record the hand-off before this process exits.
        await this.store.commandResult(command.id, "completed", "正在应用并重启 Cleo…");
        await this.apply(actions.candidateId);
      } else {
        if (!actions.canSave) throw new Error("请先应用检查通过的改动，再保存版本。");
        const name = typeof params?.name === "string" ? params.name.trim().slice(0, 80) : "";
        await this.save(name || actions.suggestedName);
      }
      return;
    }
    if (!["stop", "discard", "rollback"].includes(action)) throw new Error("不支持的进化操作。");
    if (state.transaction) throw new Error("版本正在切换，请等待当前恢复流程结束。");
    if (action !== "stop" && (params.active !== state.active || params.iteration !== (state.iteration?.id || null)))
      throw new Error("版本或修改批次已改变，请重新确认恢复目标。");
    await this.store.pause(true);
    await this.stop(command.threadId);
    if (action === "stop") return;
    for (const message of await this.store.messages()) {
      if (message.threadId === command.threadId && message.status === "queued") await this.store.receipt(message.id, "cancelled");
    }
    if (action === "discard") await this.discard();
    else {
      const target = state.builds.find(build => build.id === params.targetId);
      if (!target || !(target.savedAt || target.kind === "official" || target.baseline || target.id === state.iteration?.base))
        throw new Error("请选择已保存或本轮开始时的可用版本。");
      await this.rollback(target.id);
    }
  }
  /** Purpose: Process controls even during an agent turn; queued chat starts only when idle.
   * Input: one timer tick. Output: durable receipts with no automatic replay of claimed work.
   */
  async tick() {
    if (this.commandGate) return;
    this.commandGate = true;
    try {
      const command = (await this.store.commands()).find(item => !item.status);
      if (command) {
        this.controlling = true;
        await this.store.commandResult(command.id, "started");
        try { await this.control(command, await this.evolution.store.read()); await this.store.commandResult(command.id, "completed"); }
        catch (error) { await this.store.commandResult(command.id, "error", error.message); }
        finally { this.controlling = false; }
      }
    } finally { this.commandGate = false; }
    if (this.controlling || this.turnTask || !this.ready() || await this.store.paused()) return;
    const state = await this.evolution.store.read();
    if (state.transaction || !state.threadId) return;
    const message = await this.store.pending(state.threadId);
    if (!message || !this.ready()) return;
    this.turnTask = this.turn({ thread_id: message.threadId, prompt: message.body, attachments: [], run_id: message.id })
      .catch(error => { this.event(message.threadId, { type: "error", message: error.message }); })
      .finally(() => { this.turnTask = null; });
  }
}
