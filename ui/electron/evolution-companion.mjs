import { t as tr } from "./i18n.mjs";
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
      thread.items.push({ id: `error-${Date.now()}`, type: "notice", title: tr("usecleoworkspace.run_needs_attention"), detail: event.message });
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
    if (command.threadId !== state.threadId) throw new Error(tr("evolution_companion.the_evolution_conversation_changed_select_the_action_again"));
    const { action, params } = command;
    if (action === "answer") {
      const pending = await this.backend.request("get_pending_questions", { thread_id: command.threadId });
      const question = pending.find(q => q.id === params.questionId);
      if (!question) throw new Error(tr("evolution_companion.the_question_ended_or_the_connection_recovered_wait_for_the_agent_to_ask_again"));
      if (question.questions.some(q => q.secret)) throw new Error(tr("evolution_companion.enter_sensitive_information_in_the_main_window"));
      if (!params.answers || question.questions.some(q => !Array.isArray(params.answers[q.id]) || !params.answers[q.id].length)) throw new Error(tr("evolution_companion.answer_every_question"));
      await this.backend.request("resolve_question", { thread_id: command.threadId, question_id: params.questionId, answers: params.answers });
      this.event(command.threadId, { type: "question-resolved", request: { id: params.questionId } });
      return;
    }
    if (action === "resume") { await this.store.pause(false); return; }
    if (["build", "apply", "save"].includes(action)) {
      if (state.transaction) throw new Error(tr("evolution_companion.a_version_switch_is_in_progress_wait_for_it_to_finish"));
      if (!this.ready()) throw new Error(tr("evolution_companion.cleo_is_editing_or_checking_changes_wait_for_the_current_step_to_finish"));
      const actions = evolutionActions(await this.evolution.status());
      if (action === "build") {
        if (!actions.needsCheck && !actions.checkFailed) throw new Error(tr("evolution_companion.no_changes_need_checking"));
        await this.build();
      } else if (action === "apply") {
        if (!actions.canApply) throw new Error(tr("evolution_companion.checks_have_not_passed_or_the_changes_have_changed_run_checks_again"));
        // Applying restarts Cleo; record the hand-off before this process exits.
        await this.store.commandResult(command.id, "completed", tr("evolution_companion.applying_changes_and_restarting_cleo"));
        await this.apply(actions.candidateId);
      } else {
        if (!actions.canSave) throw new Error(tr("evolution_companion.apply_changes_that_passed_checks_before_saving_a_version"));
        const name = typeof params?.name === "string" ? params.name.trim().slice(0, 80) : "";
        await this.save(name || actions.suggestedName);
      }
      return;
    }
    if (!["stop", "discard", "rollback"].includes(action)) throw new Error(tr("evolution_companion.unsupported_evolution_action"));
    if (state.transaction) throw new Error(tr("evolution_companion.a_version_switch_is_in_progress_wait_for_the_current_recovery_process_to_finish"));
    if (action !== "stop" && (params.active !== state.active || params.iteration !== (state.iteration?.id || null)))
      throw new Error(tr("evolution_companion.the_version_or_change_batch_changed_confirm_the_recovery_target_again"));
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
        throw new Error(tr("evolution_companion.choose_an_available_saved_version_or_the_version_from_the_start_of_this_iteration"));
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
