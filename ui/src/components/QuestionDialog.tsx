import { useEffect, useRef } from "react";
import { MessageCircleQuestion, X } from "lucide-react";
import type { useQuestions } from "../useQuestions";

export function QuestionDialog({ questions, textOnly = false }: { questions: ReturnType<typeof useQuestions>; textOnly?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (questions.open) dialog.current?.showModal(); else dialog.current?.close();
  }, [questions.open, questions.current?.id]);
  const request = questions.current;
  return <>
    {textOnly && <p className="question-text-fallback">此连接通过普通对话提问和回答。</p>}
    {request && <div className="question-banner" role="status">
      <MessageCircleQuestion size={16} /><span>Agent 正在等待你的回答</span>
      <button onClick={questions.reopen}>回答问题</button>
    </div>}
    <dialog ref={dialog} className="question-dialog" aria-label="Agent 提问"
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
      }} onCancel={event => { event.preventDefault(); questions.collapse(); }}>
      {request && <form onSubmit={event => { event.preventDefault(); void questions.submit(); }}>
        <header><h2>Agent 提问</h2><button type="button" aria-label="收起提问" onClick={questions.collapse}><X size={18} /></button></header>
        <p>提交后继续原任务。收起窗口不会提交答案。</p>
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
            <label className="question-custom">{question.options.length ? "自定义回答（可选）" : "你的回答"}
              {question.secret ? <input type="password" value={value.text} onChange={e => change({ ...value, text: e.target.value })} maxLength={16000} />
                : <textarea value={value.text} onChange={e => change({ ...value, text: e.target.value })} maxLength={16000} rows={3} />}
            </label>
          </fieldset>;
        })}
        {questions.error && <p role="alert" className="question-error">{questions.error}</p>}
        <footer><button type="button" onClick={questions.collapse}>稍后回答</button><button type="submit" disabled={questions.busy}>{questions.busy ? "正在提交…" : "提交答案"}</button></footer>
      </form>}
    </dialog>
  </>;
}
