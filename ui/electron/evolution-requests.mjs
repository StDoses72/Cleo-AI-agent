import { getLanguage, translator, t as tr } from "./i18n.mjs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJson, writeJson } from "./evolution-store.mjs";

const now = () => new Date().toISOString();
const behaviorText = value => String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
const sameBehavior = (a, b) => behaviorText(a.trigger) === behaviorText(b.trigger)
  && behaviorText(a.item.expectation) === behaviorText(b.item.expectation);
const text = (value, limit, name) => {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(tr("evolution_requests.invalid_value", { p0: name }));
  return value.trim();
};

/** Durable preparation journal. Existing suite/report schemas remain unchanged for older writers.
 * Call mutations inside the existing evolution operation lock; status is safe during preparation.
 */
export class EvolutionRequests {
  constructor(acceptance, analyze, onChange = () => {}) {
    this.acceptance = acceptance;
    this.store = acceptance.store;
    this.analyze = analyze;
    this.onChange = onChange;
    this.path = join(this.store.root, "acceptance", "requests-v1.json");
    this.running = new Set();
  }

  async read() {
    const data = await readJson(this.path, { schema: 1, requests: [] });
    if (data?.schema !== 1 || !Array.isArray(data.requests) || data.requests.some((r) =>
      !r || typeof r.id !== "string" || typeof r.prompt !== "string" || !Array.isArray(r.cases)
      || !["analyzing", "failed", "clarification", "answered", "freezing", "frozen"].includes(r.status)
      || (r.promptLanguage != null && !["zh-CN", "en"].includes(r.promptLanguage))
      || (["freezing", "frozen"].includes(r.status) && !r.cases.length)
      || r.cases.some((c) => !c?.item || typeof c.item.id !== "string" || typeof c.item.expectation !== "string"
        || typeof c.item.evidence !== "string"))) {
      throw new Error(tr("evolution_requests.could_not_read_the_acceptance_request_record_format_the_original_file_was_preserved_a"));
    }
    return data;
  }

  async status() {
    return (await this.read()).requests.map((r) => ({ ...r,
      interrupted: ["analyzing", "freezing"].includes(r.status) && !this.running.has(r.id),
    }));
  }

  /** Capture case feedback before analysis; revised criteria get new IDs, never overwritten history. */
  async feedback({ id, caseId, body, threadId }) {
    text(id, 100, tr("evolution_requests.feedback_id")); text(body, 5000, tr("evolution_requests.feedback")); text(threadId, 150, tr("evolution_requests.conversation_id"));
    const item = (await this.suite()).find((c) => c.id === caseId);
    const retry = (await this.read()).requests.find((r) => r.id === id);
    const promptLanguage = retry ? retry.promptLanguage ?? "zh-CN" : getLanguage();
    const requestText = translator(promptLanguage);
    if (!item || (!item.enabled && !retry)) throw new Error(tr("evolution_requests.this_acceptance_item_has_ended_use_the_latest_pending_item"));
    const pending = (await this.acceptance.interactions.read()).feedback.find((f) => f.caseId === caseId && f.id !== id);
    if (pending && item.kind === "manual") throw new Error(tr("evolution_requests.this_item_already_has_feedback_add_details_or_continue_in_the_conversation_before_giv"));
    const prompt = requestText("evolution_requests.continue_this_behavior_acceptance_case_use_the_original_context_and_latest_feedback_t")
      + requestText("evolution_requests.acceptance_item_value_previous_expectation_value_context_value_latest_user_feedback_v", { p0: item.title, p1: item.expectation, p2: item.evidence.slice(0, 18000), p3: body });
    await this.acceptance.interactions.append("feedback", { id, caseId, body, threadId });
    // A feedback submission cannot leave a previous human pass usable while clarification waits.
    const status = await this.acceptance.status(await this.store.read());
    const result = status.report?.results.find((r) => r.id === caseId);
    if (result && item.kind === "manual") {
      result.after = { ...result.after, status: "manual", detail: tr("evolution_requests.the_user_submitted_more_feedback_awaiting_changes_before_another_acceptance_check") };
      await writeJson(this.acceptance.reportPath, status.report);
    }
    return this.prepare({ id, threadId, prompt, promptLanguage, ...(item.kind === "manual" ? { replaces: caseId } : {}) });
  }

  async save(data) {
    await writeJson(this.path, data);
    this.onChange();
  }

  /** Purpose: Retire an explicitly abandoned task without deleting its request or evidence.
   * Input: task identity. Output: durable abandonment and cancellation of its remaining manual cases.
   */
  async abandon({ threadId }) {
    text(threadId, 150, tr("evolution_requests.conversation_id"));
    const data = await this.read();
    const requests = data.requests.filter((r) => r.threadId === threadId && !r.abandonedAt);
    if (requests.some((r) => this.running.has(r.id))) throw new Error(tr("evolution_requests.stop_the_requirements_preparation_already_in_progress_first"));
    const abandonedAt = now();
    for (const request of requests) request.abandonedAt = abandonedAt;
    // Journal first: even an interrupted cancellation must never restart an abandoned request.
    await this.save(data);
    const ids = new Set(data.requests.filter((r) => r.threadId === threadId).flatMap((r) => r.cases.map((c) => c.item.id)));
    for (const item of await this.suite()) {
      if (ids.has(item.id) && item.enabled && item.kind === "manual") await this.acceptance.cancel(item.id);
    }
    return { threadId, abandoned: requests.length };
  }

  /** Purpose: Resume implementation against the same frozen case, without another planning pass.
   * Input: case, task, optional feedback and stable retry ID. Output: one repair request and feedback receipt.
   */
  async continueCase({ id, caseId, threadId, body = "" }) {
    id = text(id, 100, tr("evolution_requests.request_id")); threadId = text(threadId, 150, tr("evolution_requests.conversation_id"));
    if (typeof body !== "string" || body.length > 5000) throw new Error(tr("evolution_requests.feedback_is_limited_to_5_000_characters"));
    const item = (await this.suite()).find((c) => c.id === caseId && c.enabled);
    if (!item) throw new Error(tr("evolution_requests.this_acceptance_item_has_ended_use_the_latest_pending_item"));
    const data = await this.read();
    const parent = data.requests.find((r) => r.cases.some((c) => c.item.id === caseId));
    const previous = data.requests.find(r => r.id === id);
    const promptLanguage = previous ? previous.promptLanguage ?? "zh-CN" : getLanguage();
    const requestText = translator(promptLanguage);
    const prompt = requestText("evolution_requests.value_the_user_chose_to_continue_editing_with_this_case_do_not_regenerate_the_case_or", { p0: (await this.acceptance.prompt(caseId, promptLanguage)).slice(0, 24000) })
      + (body.trim() ? requestText("evolution_requests.latest_feedback_value", { p0: body.trim() }) : "");
    const request = await this.repair({ id, threadId, prompt, parent: parent?.id, promptLanguage });
    await this.acceptance.interactions.append("feedback", { id, caseId, threadId,
      body: body.trim() || requestText("evolution_requests.continue_editing_with_this_case"), mode: "continue" });
    const status = await this.acceptance.status(await this.store.read());
    const result = status.report?.results.find((r) => r.id === caseId);
    if (result && item.kind === "manual" && !request.execution) {
      result.after = { ...result.after, status: "manual", detail: tr("evolution_requests.continue_editing_with_this_case_and_repeat_acceptance_afterward") };
      await writeJson(this.acceptance.reportPath, status.report);
    }
    return request;
  }

  async suite() {
    const cases = await readJson(this.acceptance.path, []);
    if (!Array.isArray(cases) || cases.some((c) => !c || typeof c.id !== "string"
      || typeof c.expectation !== "string" || typeof c.enabled !== "boolean")) {
      throw new Error(tr("evolution_requests.could_not_read_the_existing_acceptance_case_format_it_was_not_overwritten"));
    }
    return cases;
  }

  /** Purpose: Persist intent before analysis, allowing explicit reconsideration of a blocked request.
   * Input: Original identity, optional clarification or reanalyze flag. Output: durable preparation; frozen goals stay immutable.
   */
  async prepare({ id, threadId, prompt, clarification, reanalyze = false, skipClarification = false, replaces, promptLanguage = getLanguage() }) {
    text(id, 100, tr("evolution_requests.request_id")); text(threadId, 150, tr("evolution_requests.conversation_id")); text(prompt, 30000, tr("evolution_requests.requirements"));
    const data = await this.read();
    let request = data.requests.find((r) => r.id === id);
    const requestText = translator(request ? request.promptLanguage ?? "zh-CN" : promptLanguage);
    if (request?.abandonedAt) throw new Error(tr("evolution_requests.this_request_was_discarded_submit_a_new_change_request"));
    if (request && (request.prompt !== prompt || request.threadId !== threadId)) throw new Error(tr("evolution_requests.this_request_id_was_already_used_for_another_request"));
    if (!request) {
      request = { id, threadId, prompt, promptLanguage, status: "analyzing", createdAt: now(), cases: [], clarifications: [],
        ...(replaces ? { replaces } : {}) };
      data.requests.push(request);
      await this.save(data);
    }
    if (request.status === "freezing") return this.freeze(data, request);
    if (["frozen", "answered"].includes(request.status)) return request;
    request.clarifications ||= [];
    if (request.status === "clarification" && !clarification && !reanalyze && !skipClarification) return request;
    if (skipClarification) {
      const recorded = (await this.acceptance.interactions.read()).confirmations.find((c) => c.id === id && c.skipped);
      if (!recorded) {
        if (request.status !== "clarification") throw new Error(tr("evolution_requests.this_request_is_not_awaiting_confirmation"));
        await this.acceptance.interactions.append("confirmations", { id, skipped: true, question: request.answer });
      }
    }
    if (clarification) {
      const answer = text(clarification, 5000, tr("evolution_requests.additional_details"));
      if (request.status === "clarification") request.clarifications.push({ question: request.answer, answer, at: now() });
      else if (request.clarifications.at(-1)?.answer !== answer)
        throw new Error(tr("evolution_requests.this_request_is_not_awaiting_clarification_use_a_case_correction_to_preserve_the_reas"));
    }
    this.running.add(id);
    try {
      request.status = "analyzing"; delete request.error; delete request.answer;
      await this.save(data);
      const skipped = (await this.acceptance.interactions.read()).confirmations.some((c) => c.id === id && c.skipped);
      const confirmed = skipped || request.clarifications.length > 0;
      const continuation = confirmed ? requestText("evolution_requests.one_consolidated_confirmation_has_already_been_completed_do_not_ask_again") + (skipped
        ? requestText("evolution_requests.the_user_chose_to_skip_confirmation_without_providing_specific_answers") : requestText("evolution_requests.continue_using_the_user_s_additional_information"))
        + requestText("evolution_requests.use_reasonable_reversible_assumptions_return_change_or_investigate_with_concrete_acce") : "";
      const enabled = new Set((await this.suite()).filter(c => c.enabled).map(c => c.id));
      const previous = data.requests.filter(r => r.id !== id && r.threadId === threadId && !r.abandonedAt)
        .flatMap(r => r.cases).filter(c => enabled.has(c.item.id) && c.item.id !== replaces);
      const context = previous.filter((c, index) => previous.findIndex(p => p.item.id === c.item.id) === index)
        .slice(-30).map(c => ({ title: c.item.title, trigger: c.trigger, expectation: c.item.expectation }));
      let analysis = await this.analyze(threadId, prompt + request.clarifications.map((c) =>
        requestText("evolution_requests.clarification_questions_value_user_details_value", { p0: c.question, p1: c.answer })).join("") + continuation, context);
      if (confirmed && analysis?.intent === "clarification") {
        // One bounded model correction, not another user question or fabricated acceptance.
        analysis = await this.analyze(threadId, prompt + request.clarifications.map((c) => requestText("evolution_requests.user_details_value", { p0: c.answer })).join("")
          + continuation + requestText("evolution_requests.the_previous_analysis_still_requested_clarification_and_did_not_follow_the_confirmed_"), context);
        if (analysis?.intent === "clarification") throw new Error(tr("evolution_requests.the_analyzer_could_not_generate_acceptance_criteria_using_reasonable_assumptions_the_"));
      }
      if (["question", "clarification"].includes(analysis?.intent)) {
        request.answer = text(analysis.answer, 10000, tr("evolution_requests.analysis_response"));
        request.status = analysis.intent === "question" ? "answered" : "clarification";
        await this.save(data);
        return request;
      }
      if (analysis?.intent !== "change" || !Array.isArray(analysis.cases) || !analysis.cases.length || analysis.cases.length > 12)
        throw new Error(tr("evolution_requests.no_valid_case_was_generated_code_editing_has_not_started"));
      const state = await this.store.read();
      if (!state.active) throw new Error(tr("evolution_acceptance.prepare_the_current_version_first"));
      if (confirmed) request.answer = typeof analysis.answer === "string" && analysis.answer.trim()
        ? analysis.answer.slice(0, 10000) : requestText("evolution_requests.assumptions_preserve_existing_context_and_behavior_not_requested_to_change_implement_");
      request.cases = analysis.cases.map((c) => {
        const detail = { requirement: text(c.requirement, 4000, tr("evolution_requests.related_requirement")),
          current: text(c.current, 3000, tr("evolution_requests.current_behavior")), trigger: text(c.trigger, 2000, tr("evolutioncases.action_conditions")),
          sourceEvidence: text(c.evidence, 20000, tr("evolution_requests.source_evidence")) };
        // A model cannot invent an executable checker or claim an observed baseline failure.
        detail.current = (detail.current.startsWith("尚未验证") || detail.current.startsWith("Not verified")) ? detail.current : requestText("evolution_requests.not_verified_static_analysis_only_value", { p0: detail.current });
        const item = { id: randomUUID(), title: text(c.title, 120, tr("evolution_requests.title")),
          expectation: text(c.expectation, 4000, tr("evolution_requests.expectation")),
          evidence: requestText("evolution_requests.related_requirement_value_current_behavior_value_action_value_static_evidence_value", { p0: detail.requirement, p1: detail.current, p2: detail.trigger, p3: detail.sourceEvidence }),
          kind: "manual", enabled: true, sourceThread: threadId, baseline: state.active, createdAt: now() };
        const same = previous.find(c => sameBehavior(c, { ...detail, item }));
        return same || { ...detail, item };
      }).filter((c, index, all) => all.findIndex(p => sameBehavior(p, c)) === index);
      request.status = "freezing";
      await this.save(data); // Journal IDs before the suite write, for crash-safe replay.
      return await this.freeze(data, request);
    } catch (error) {
      // Once IDs have been journaled, even a failed final journal write must resume
      // that freeze, not ask the model for different expectations on retry.
      request.status = request.cases.length ? "freezing" : "failed";
      request.error = error.message;
      await this.save(data);
      throw error;
    } finally { this.running.delete(id); }
  }

  async freeze(data, request) {
    const cases = await this.suite();
    for (const { item } of request.cases) {
      const existing = cases.find((c) => c.id === item.id);
      if (existing && (existing.expectation !== item.expectation || existing.evidence !== item.evidence))
        throw new Error(tr("evolution_requests.the_frozen_case_differs_from_the_saved_content_it_was_not_overwritten"));
      if (!existing) cases.push(item);
    }
    // Revisions retain the entire old case and only archive it, using the old writer's semantics.
    await writeJson(this.acceptance.path, cases.map((c) => request.replaces === c.id ? { ...c, enabled: false } : c));
    request.status = "frozen"; request.frozenAt ||= now(); delete request.error;
    await this.save(data);
    return request;
  }

  async revise({ id, caseId, expectation, trigger, reason }) {
    const promptLanguage = getLanguage();
    const requestText = translator(promptLanguage);
    text(id, 100, tr("evolution_requests.correction_id"));
    const data = await this.read();
    const retry = data.requests.find((r) => r.id === id);
    if (retry) {
      if (retry.replaces !== caseId || retry.reason !== reason || retry.cases[0]?.item.expectation !== expectation.trim()
        || retry.cases[0]?.trigger !== trigger.trim())
        throw new Error(tr("evolution_requests.this_correction_id_was_already_used_for_different_content"));
      return retry.status === "freezing" ? this.freeze(data, retry) : retry;
    }
    const source = data.requests.find((r) => r.cases.some((c) => c.item.id === caseId));
    const previous = source?.cases.find((c) => c.item.id === caseId);
    const saved = (await this.suite()).find((c) => c.id === caseId && c.enabled);
    if (!previous || !saved) throw new Error(tr("evolution_requests.could_not_find_an_automatically_prepared_case_that_can_be_corrected"));
    const revised = { ...previous, trigger: text(trigger, 2000, tr("evolutioncases.action_conditions")), item: { ...saved,
      id: randomUUID(), expectation: text(expectation, 4000, tr("evolution_requests.expectation")), createdAt: now(), enabled: true,
      evidence: requestText("evolution_requests.value_user_adjusted_action_value_reason_for_change_value", { p0: saved.evidence, p1: trigger, p2: text(reason, 4000, tr("evolution_requests.reason_for_change")) }) } };
    const request = { id, threadId: source.threadId, prompt: source.prompt, promptLanguage, status: "freezing", createdAt: now(),
      cases: [revised], replaces: caseId, parent: source.id, reason, clarifications: [] };
    data.requests.push(request);
    await this.save(data);
    return this.freeze(data, request);
  }

  async editingPrompt(id) {
    const request = (await this.read()).requests.find((r) => r.id === id);
    const requestText = translator(request?.promptLanguage ?? "zh-CN");
    if (request?.abandonedAt) throw new Error(tr("evolution_requests.this_request_was_discarded_submit_a_new_change_request"));
    if (!request || request.status !== "frozen") throw new Error(tr("evolution_requests.complete_acceptance_preparation_for_this_iteration_first"));
    const cases = await this.suite();
    for (const { item } of request.cases) {
      const saved = cases.find((c) => c.id === item.id);
      if (saved?.cancelledAt) continue;
      if (!saved?.enabled || saved.expectation !== item.expectation || saved.evidence !== item.evidence)
        throw new Error(tr("evolution_requests.this_iteration_s_case_was_corrected_or_archived_use_the_updated_case"));
    }
    if (!request.cases.some(({ item }) => cases.some((c) => c.id === item.id && c.enabled)))
      throw new Error(tr("evolution_requests.all_acceptance_items_in_this_iteration_are_cancelled_or_finished_submit_a_new_change_"));
    const enabled = cases.filter((c) => c.enabled);
    return `[[CLEO_ACCEPTANCE_REQUEST:${request.id}]]\n${request.prompt}\n`
      + (request.reason ? requestText("evolution_requests.reason_for_user_adjustment_value", { p0: request.reason }) : "")
      + (request.clarifications || []).map((c) => requestText("evolution_requests.additional_details_value", { p0: c.answer })).join("")
      + (request.answer ? requestText("evolution_requests.continuation_approach_and_assumptions_value", { p0: request.answer }) : "")
      + requestText("evolution_requests.the_following_cases_have_been_saved_and_frozen_by_the_desktop_app_implement_the_requi")
      + enabled.map((c) => requestText("evolution_requests.value_value_actions_and_evidence_value_expected_behavior_value_verification_method_va", { p0: c.id, p1: c.title, p2: c.evidence, p3: c.expectation, p4: c.kind })).join("\n\n");
  }

  /** Claim once before handing control to an editing agent. No renderer completion can pass a case. */
  async claim(threadId, prompt) {
    const id = /^\[\[CLEO_ACCEPTANCE_REQUEST:([^\]]+)\]\]/.exec(prompt)?.[1];
    if (!id || prompt !== await this.editingPrompt(id)) throw new Error(tr("evolution_requests.prepare_and_freeze_acceptance_cases_before_editing"));
    const data = await this.read();
    const request = data.requests.find((r) => r.id === id);
    if (request.threadId !== threadId || request.execution) throw new Error(tr("evolution_requests.this_request_was_already_submitted_or_the_conversation_does_not_match_editing_will_no"));
    request.execution = { status: "submitted", at: now() };
    await this.save(data);
    return id;
  }

  async finish(id, status) {
    const data = await this.read();
    const request = data.requests.find((r) => r.id === id);
    if (request) { request.execution = { ...request.execution, status, finishedAt: now() }; await this.save(data); }
  }

  /** Diagnostics reuse all frozen expectations, including legacy manually prepared cases. */
  async repair({ id, threadId, prompt, parent, promptLanguage = getLanguage() }) {
    const requestText = translator(promptLanguage);
    const data = await this.read();
    const existing = data.requests.find((r) => r.id === id);
    if (existing) {
      if (existing.abandonedAt) throw new Error(tr("evolution_requests.this_request_was_discarded_submit_a_new_change_request"));
      if (existing.threadId !== threadId || existing.prompt !== prompt) throw new Error(tr("evolution_requests.this_request_id_was_already_used_for_another_request"));
      return existing;
    }
    const cases = (await this.suite()).filter((c) => c.enabled);
    if (!cases.length) return this.prepare({ id, threadId, prompt, promptLanguage });
    const request = { id: text(id, 100, tr("evolution_requests.request_id")), threadId: text(threadId, 150, tr("evolution_requests.conversation_id")),
      prompt: text(prompt, 30000, tr("evolution_requests.diagnostics")), promptLanguage, status: "frozen", createdAt: now(), frozenAt: now(), repair: true,
      ...(parent ? { parent } : {}),
      cases: cases.map((item) => ({ item, requirement: item.title, current: requestText("evolution_requests.not_verified"), trigger: item.evidence })), clarifications: [] };
    data.requests.push(request); await this.save(data); return request;
  }
}
