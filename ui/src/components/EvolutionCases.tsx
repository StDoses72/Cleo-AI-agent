import { t as tr } from "../../electron/i18n.mjs";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, FlaskConical, X } from "lucide-react";
import type { EvolutionAcceptanceState, EvolutionCase, EvolutionRequest } from "../evolution-types";
import type { Thread } from "../types";
import { handleDialogKeyDown } from "./Modal";

interface Props {
  dialogOnly?: boolean;
  open?: boolean;
  onClose?: () => void;
  state?: EvolutionAcceptanceState;
  requests?: EvolutionRequest[];
  thread?: Thread | null;
  busy: boolean;
  canReview?: boolean;
  onAction: (action: string, params?: Record<string, unknown>) => void;
  onImprove: (caseId: string, body: string, requestId: string) => Promise<void>;
  onCreate: (input: Record<string, unknown>) => Promise<void>;
  onRevise?: (params: Record<string, unknown>) => Promise<unknown>;
}
const labels = { get passed() { return tr("evolutioncases.passed"); }, get failed() { return tr("evolutioncases.not_passed"); }, get error() { return tr("evolutioncases.run_failed"); }, get manual() { return tr("evolutioncases.pending_confirmation"); } };

/** Purpose: Capture human acceptance criteria before editing, then expose comparable version evidence. */
export function EvolutionCases({ state, requests = [], thread, busy, canReview, onAction, onImprove, onCreate, onRevise, dialogOnly = false, open, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [expectation, setExpectation] = useState("");
  const [issue, setIssue] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const openDialog = () => { setTitle(thread?.title || ""); setExpectation(""); setIssue(""); dialog.current?.showModal(); titleInput.current?.focus(); };
  const closeDialog = () => { if (!savingRef.current) { dialog.current?.close(); onClose?.(); } };
  useEffect(() => { if (open) openDialog(); else if (open === false) dialog.current?.close(); }, [open, thread?.id]);
  useEffect(() => { const node = dialog.current; return () => { if (node?.open) node.close(); }; }, []);
  const cases = state?.cases.filter((item) => item.enabled) || [];
  const history = state?.cases.filter(item => !item.enabled) || [];
  const dialogOnlyView = dialogOnly || !state?.cases.length;
  return <section className={`evolution-cases${dialogOnlyView ? " dialog-only" : ""}`} aria-label={dialogOnlyView ? undefined : tr("evolutioncases.behavior_acceptance")}>
    {!dialogOnlyView && <div className="evolution-cases-heading"><FlaskConical size={15} /><strong>{tr("evolutioncases.acceptance_checklist")}</strong>
      {state && <span>{cases.length} {tr("evolutioncases.items_awaiting_acceptance")}</span>}
      <button disabled={busy} onClick={openDialog}>
        {thread ? tr("evolutioncases.create_an_improvement_case_from_this_conversation") : tr("evolutioncases.add_goal")}</button>
    </div>}
    {state && Boolean(cases.length) && <details className="evolution-case-list"><summary>{tr("evolutioncases.view_goals_and_results")}</summary>
      {cases.map((item, index) => {
        const result = state.report?.results.find((entry) => entry.id === item.id);
        const detail = requests.flatMap(request => request.cases).find(c => c.item.id === item.id);
        const before = detail?.current || item.evidence.match(/(?:当前行为[：:]|Current behavior:)([\s\S]*?)(?=\n(?:操作[：:]|Action:)|\n(?:静态证据[：:]|Static evidence:)|$)/)?.[1];
        const trigger = detail?.trigger || item.evidence.match(/(?:操作[：:]|触发条件[：:]|Action:|Trigger:)\s*([^\n]+)/)?.[1];
        const lastFeedback = state.interactions?.feedback.filter((feedback) => feedback.caseId === item.id).at(-1);
        const request = requests.find(entry => entry.cases.some(detail => detail.item.id === item.id));
        return <article key={item.id} className="evolution-case">
          <div><b>{index + 1}. {item.title}</b><small>{!state.fresh ? tr("evolutioncases.awaiting_checks") : result ? labels[result.after.status] : tr("evolutioncases.pending_confirmation")}</small></div>
          <p>{item.expectation}</p>
          {trigger && <p>{tr("evolutioncases.action")}{trigger}</p>}
          {state.fresh && result?.after.detail && result.after.status !== "manual" && <p>{result.after.detail}</p>}
          <details><summary>{tr("evolutioncases.evidence_and_history")}</summary>
            <p className="evolution-case-evidence">{tr("evolutioncases.before_changes")}{item.kind === "manual" ? tr("evolutioncases.source_analysis_not_tested") : ""}{tr("punctuation.colon")}{item.kind === "manual" ? before || tr("evolutioncases.not_recorded") : result?.before.detail || tr("evolutioncases.not_recorded")}</p>
            {request?.answer && <p>{request.answer}</p>}
            {request?.reason && <p>{tr("evolutioncases.reason_for_adjustment")}{request.reason}</p>}
            <pre>{detail?.sourceEvidence || item.evidence || tr("evolutioncases.no_additional_evidence")}</pre>
            {onRevise && !request?.repair && <CaseCriteria item={item} trigger={trigger || ""} busy={busy} onRevise={onRevise} />}
          </details>
          {item.kind === "manual" && state.fresh && result?.after.status === "manual" && !canReview && <p>{tr("evolutioncases.apply_the_changes_before_confirming_the_result")}</p>}
          <CaseFeedback caseId={item.id} title={item.title} state={state} requests={requests} busy={busy} onSend={onImprove} />
          {item.kind === "manual" && <footer><button disabled={busy || !canReview || !state.fresh
            || !result || Boolean(lastFeedback && lastFeedback.mode !== "continue")}
            onClick={() => onAction("completeCase", { id: item.id })}>{tr("evolutioncases.confirm_result")}</button>
            <button disabled={busy} onClick={() => onAction("cancelCase", { id: item.id })}>{tr("evolutioncases.cancel_this_item")}</button></footer>}
        </article>;
      })}
    </details>}
    {history.length > 0 && <details className="evolution-case-list"><summary>{tr("evolutioncases.history")}{history.length} {tr("evolutioncases.items")}</summary>
      {history.map((item) => <article key={item.id} className="evolution-case"><b>{item.title}</b>
        <p>{item.expectation}</p><small>{item.cancelledAt ? tr("evolutioncases.cancelled_not_counted_as_passed") : state?.interactions?.completions.some(entry => entry.id === item.id) ? tr("evolutioncases.result_confirmed") : requests.some(request => request.replaces === item.id) ? tr("evolutioncases.goal_adjusted") : tr("evolutioncases.archived")}</small>
        <details><summary>{tr("evolutioncases.original_evidence")}</summary><pre>{item.evidence}</pre></details></article>)}
    </details>}
    <dialog ref={dialog} className="evolution-dialog" aria-label={tr("conversation.improve_cleo")} onKeyDown={handleDialogKeyDown} onCancel={event => { event.preventDefault(); closeDialog(); }}>
      <div className="evolution-dialog-title"><h2>{tr("conversation.improve_cleo")}</h2><button aria-label={tr("evolutioncases.close_case")} disabled={saving} onClick={closeDialog}><X size={18} /></button></div>
      <p>{tr("evolutioncases.record_the_problem_and_expected_outcome_for_later_acceptance_checks")}</p>
      <form onSubmit={(event) => {
        event.preventDefault(); if (savingRef.current) return; savingRef.current = true; setSaving(true); setIssue("");
        const evidence = thread?.items.filter((item) => item.type === "message" || item.type === "notice" || item.type === "tool")
          .map((item) => JSON.stringify(item)).join("\n") || "";
        void onCreate({ title, expectation, evidence, sourceThread: thread?.id || "", kind: "manual" })
          .then(() => { savingRef.current = false; closeDialog(); }).catch((error: unknown) => setIssue(error instanceof Error ? error.message : tr("evolutioncases.save_failed")))
          .finally(() => { savingRef.current = false; setSaving(false); });
      }}>
        <label>{tr("evolutioncases.case_name")}<input ref={titleInput} aria-label={tr("evolutioncases.case_name")} required maxLength={120} disabled={saving} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>{tr("evolutioncases.expected_behavior")}<textarea aria-label={tr("evolutioncases.expected_behavior")} required maxLength={4000} disabled={saving} value={expectation} onChange={(event) => setExpectation(event.target.value)} placeholder={tr("evolutioncases.for_example_preserve_progress_when_the_model_returns_invalid_output_then_try_to_corre")} /></label>
        {thread && <p>{tr("evolutioncases.includes_the_loaded_conversation_from")}{thread.title}{tr("evolutioncases.label")}</p>}
        {issue && <p role="alert">{issue}</p>}
        <button className="evolution-primary" disabled={busy || saving || !title.trim() || !expectation.trim()}>{tr("evolutioncases.save_case_and_open_evolution")}</button>
      </form>
    </dialog>
  </section>;
}

/** Purpose: Continue with optional feedback while retaining the case and retry identity.
 * Input: case and its history. Output: one continuation submission, including when no note is needed.
 */
function CaseFeedback({ caseId, title, state, requests, busy, onSend }: {
  caseId: string; title: string; state: EvolutionAcceptanceState; requests: EvolutionRequest[];
  busy: boolean; onSend: Props["onImprove"];
}) {
  const [body, setBody] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const ancestors = new Set([caseId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const request of requests) {
      if (request.replaces && request.cases.some((c) => ancestors.has(c.item.id)) && !ancestors.has(request.replaces)) {
        ancestors.add(request.replaces); changed = true;
      }
    }
  }
  const messages = state.interactions?.feedback.filter((f) => ancestors.has(f.caseId)) || [];
  return <details className="evolution-feedback"><summary>{tr("evolutioncases.continue_editing")}</summary>
    <div className="evolution-feedback-history" role="log" aria-label={tr("evolutioncases.feedback_history_value", { p0: title })}>
      {messages.map((message) => {
        const request = requests.find((r) => r.id === message.id);
        return <div key={message.id}><p className="evolution-feedback-user"><small>{tr("evolutioncases.you")}</small>{message.body}</p>
          <p className="evolution-feedback-reply"><small>Cleo</small>{request?.error || (request?.execution?.status === "completed"
            ? tr("evolutioncases.implementation_has_finished_review_the_build_results_apply_the_changes_and_check_the_") : request?.execution?.status === "interrupted"
              ? tr("evolutioncases.implementation_was_interrupted_continue_in_the_conversation") : request?.execution ? tr("evolutioncases.updating_based_on_your_feedback") : request?.status === "frozen"
                ? tr("evolutioncases.acceptance_expectations_are_saved_preparing_to_continue") : tr("evolutioncases.feedback_saved_preparing_to_continue_provide_any_additional_information_in_the_conver"))}
            {request?.answer && <span className="evolution-feedback-assumption">{request.answer}</span>}</p></div>;
      })}
    </div>
    <form onSubmit={(event) => {
      event.preventDefault(); if (sending || busy) return;
      setSending(true); setError("");
      void onSend(caseId, body, requestId).then(() => { setBody(""); setRequestId(crypto.randomUUID()); })
        .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
        .finally(() => setSending(false));
    }}>
      <textarea aria-label={tr("evolutioncases.additional_feedback_value", { p0: title })} placeholder={tr("evolutioncases.describe_the_actual_behavior_optional")} value={body} maxLength={5000}
        disabled={sending || busy} onChange={(event) => { setBody(event.target.value); setRequestId(crypto.randomUUID()); }} />
      <button type="submit" aria-label={tr("evolutioncases.continue_editing_value", { p0: title })} disabled={busy || sending}><ArrowUp size={16} />{tr("evolutioncases.continue_editing")}</button>
    </form>
    {error && <p role="alert">{error}</p>}
  </details>;
}

function CaseCriteria({ item, trigger, busy, onRevise }: {
  item: EvolutionCase; trigger: string; busy: boolean; onRevise: NonNullable<Props["onRevise"]>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ expectation: item.expectation, trigger, reason: "", id: "" });
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  if (!editing) return <button disabled={busy} onClick={() => {
    setDraft({ expectation: item.expectation, trigger, reason: "", id: crypto.randomUUID() }); setEditing(true); setError("");
  }}>{tr("evolutioncases.adjust_goal")}</button>;
  return <form className="evolution-manual-review" onSubmit={event => {
    event.preventDefault(); if (savingRef.current || busy) return;
    savingRef.current = true; setSaving(true); setError("");
    void onRevise({ ...draft, caseId: item.id }).then(() => setEditing(false))
      .catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => { savingRef.current = false; setSaving(false); });
  }}>
    <label>{tr("evolutioncases.action_conditions")}<textarea autoFocus aria-label={tr("evolutioncases.action_conditions")} required maxLength={2000} disabled={saving} value={draft.trigger} onChange={event => setDraft({ ...draft, trigger: event.target.value, id: crypto.randomUUID() })} /></label>
    <label>{tr("evolutioncases.revised_goal")}<textarea aria-label={tr("evolutioncases.revised_goal")} required maxLength={4000} disabled={saving} value={draft.expectation} onChange={event => setDraft({ ...draft, expectation: event.target.value, id: crypto.randomUUID() })} /></label>
    <label>{tr("evolutioncases.reason_for_adjustment_2")}<textarea aria-label={tr("evolutioncases.reason_for_adjustment_2")} required maxLength={4000} disabled={saving} value={draft.reason} onChange={event => setDraft({ ...draft, reason: event.target.value, id: crypto.randomUUID() })} /></label>
    {error && <p role="alert">{error}</p>}
    <button disabled={busy || saving || !draft.reason.trim() || !draft.expectation.trim() || !draft.trigger.trim()}>{tr("evolutioncases.save_goal")}</button>
    <button type="button" disabled={saving} onClick={() => setEditing(false)}>{tr("computerpanel.cancel")}</button>
  </form>;
}
