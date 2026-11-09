import { t as tr } from "../../electron/i18n.mjs";
import { useEffect, useRef } from "react";
import { MessageCircleQuestion, X } from "lucide-react";
import type { useQuestions } from "../useQuestions";

/** Purpose: Answer an agent's native question without leaving the conversation.
 * Input: the question queue. Output: a card docked above the composer (a non-modal dialog, so the
 * timeline stays readable and scrollable); "answer later" folds it to a one-line banner that
 * reopens it. Escape folds it too.
 */
export function QuestionDialog({ questions }: { questions: ReturnType<typeof useQuestions> }) {
  const card = useRef<HTMLElement>(null);
  const request = questions.current;
  useEffect(() => {
    if (!questions.open) return;
    card.current?.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled])")?.focus();
  }, [questions.open, request?.id]);
  if (!request) return null;
  if (!questions.open) {
    return (
      <div className="question-banner" role="status">
        <MessageCircleQuestion size={15} /><span>{tr("questiondialog.the_agent_is_waiting_for_your_answer")}</span>
        <button onClick={questions.reopen}>{tr("questiondialog.answer_question")}</button>
      </div>
    );
  }
  return (
    <section ref={card} className="question-dialog question-card" role="dialog" aria-modal="false" aria-label={tr("questiondialog.agent_question")}
      onKeyDown={event => {
        // Plain keys typed into the card stay in it (no single-key approval shortcut fires underneath);
        // Ctrl/Cmd combinations such as the palette and conversation switching still reach the app.
        if (!event.ctrlKey && !event.metaKey) event.stopPropagation();
        if ((event.key === "Enter" || event.key === "Escape") && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) {
          event.preventDefault();
          return;
        }
        if (event.key === "Escape") { event.preventDefault(); questions.collapse(); }
      }}>
      <form onSubmit={event => { event.preventDefault(); void questions.submit(); }}>
        <header>
          <MessageCircleQuestion size={15} />
          <h2>{tr("questiondialog.agent_question")}</h2>
          <button type="button" aria-label={tr("questiondialog.collapse_question")} onClick={questions.collapse}><X size={16} /></button>
        </header>
        <div className="question-card-body">
          {request.questions.map(question => {
            const value = questions.draft[question.id] ?? { selected: [], text: "" };
            const change = (next: typeof value) => questions.setDraft({ ...questions.draft, [question.id]: next });
            return <fieldset key={question.id} disabled={questions.busy}>
              <legend>{question.header}</legend><p className="question-text">{question.question}</p>
              {question.options.map(option => <label className="question-option" key={option.label}>
                <input type={question.multiple ? "checkbox" : "radio"} name={question.id} value={option.label}
                  checked={value.selected.includes(option.label)} onChange={event => change({ ...value, selected: question.multiple
                    ? event.target.checked ? [...value.selected, option.label] : value.selected.filter(v => v !== option.label)
                    : [option.label] })} />
                <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
              </label>)}
              <label className="question-custom">{question.options.length ? tr("questiondialog.custom_answer_optional") : tr("questiondialog.your_answer")}
                {question.secret ? <input type="password" value={value.text} onChange={e => change({ ...value, text: e.target.value })} maxLength={16000} />
                  : <textarea value={value.text} onChange={e => change({ ...value, text: e.target.value })} maxLength={16000} rows={2} />}
              </label>
            </fieldset>;
          })}
        </div>
        {questions.error && <p role="alert" className="question-error">{questions.error}</p>}
        <footer><button type="button" onClick={questions.collapse}>{tr("questiondialog.answer_later")}</button><button type="submit" disabled={questions.busy}>{questions.busy ? tr("evolutioncontribution.submitting") : tr("questiondialog.submit_answer")}</button></footer>
      </form>
    </section>
  );
}
