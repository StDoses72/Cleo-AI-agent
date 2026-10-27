import { t as tr } from "../../electron/i18n.mjs";
import { useEffect, useRef } from "react";
import { MessageCircleQuestion, X } from "lucide-react";
import type { useQuestions } from "../useQuestions";
import { handleDialogKeyDown } from "./Modal";

export function QuestionDialog({ questions }: { questions: ReturnType<typeof useQuestions> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (questions.open) dialog.current?.showModal(); else dialog.current?.close();
  }, [questions.open, questions.current?.id]);
  const request = questions.current;
  return <>
    {request && <div className="question-banner" role="status">
      <MessageCircleQuestion size={16} /><span>{tr("questiondialog.the_agent_is_waiting_for_your_answer")}</span>
      <button onClick={questions.reopen}>{tr("questiondialog.answer_question")}</button>
    </div>}
    <dialog ref={dialog} className="question-dialog" aria-label={tr("questiondialog.agent_question")}
      onKeyDown={handleDialogKeyDown} onCancel={event => { event.preventDefault(); questions.collapse(); }}>
      {request && <form onSubmit={event => { event.preventDefault(); void questions.submit(); }}>
        <header><h2>{tr("questiondialog.agent_question")}</h2><button type="button" aria-label={tr("questiondialog.collapse_question")} onClick={questions.collapse}><X size={18} /></button></header>
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
                : <textarea value={value.text} onChange={e => change({ ...value, text: e.target.value })} maxLength={16000} rows={3} />}
            </label>
          </fieldset>;
        })}
        {questions.error && <p role="alert" className="question-error">{questions.error}</p>}
        <footer><button type="button" onClick={questions.collapse}>{tr("questiondialog.answer_later")}</button><button type="submit" disabled={questions.busy}>{questions.busy ? tr("evolutioncontribution.submitting") : tr("questiondialog.submit_answer")}</button></footer>
      </form>}
    </dialog>
  </>;
}
