import { useState } from "react";
import type { EvolutionAcceptanceState, EvolutionRequest } from "../evolution-types";

interface Props {
  requests: EvolutionRequest[];
  acceptance?: EvolutionAcceptanceState;
  busy: boolean;
  onResume: (request: EvolutionRequest, clarification?: string, skip?: boolean) => void;
}

/** Keep questions and interrupted work reachable; the acceptance list owns all criteria. */
export function EvolutionPreparation({ requests, acceptance, busy, onResume }: Props) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const visible = requests.filter(request => !requests.some(next => next.parent === request.id) && (request.status === "answered" || request.status === "clarification"
    || request.status === "failed" || request.interrupted
    || ((request.execution?.status === "interrupted" || (request.execution?.status === "submitted" && !busy) || (request.status === "frozen" && !request.execution))
      && request.cases.some(detail => acceptance?.cases.some(item => item.id === detail.item.id && item.enabled)))));
  if (!visible.length) return null;
  return <section className="evolution-preparation" aria-label="本轮验收准备">
    {visible.map(request => <article key={request.id} className="evolution-request">
      <p className="evolution-request-prompt">{request.prompt}</p>
      {request.answer && <p className="evolution-request-prompt">{request.answer}</p>}
      {request.error && <p role="alert">{request.error}</p>}
      {request.status === "clarification" ? <div className="evolution-manual-review">
        <label>补充需求<textarea aria-label="补充需求" value={answers[request.id] || ""} maxLength={5000}
          onChange={event => setAnswers({ ...answers, [request.id]: event.target.value })} /></label>
        <button disabled={busy || !answers[request.id]?.trim()} onClick={() => onResume(request, answers[request.id])}>补充并继续</button>
        <button disabled={busy} onClick={() => onResume(request, undefined, true)}>跳过并继续</button>
        <button disabled={busy} onClick={() => onResume(request)}>重新分析</button>
      </div> : request.status !== "answered" && <>
        {request.execution && <p>上次修改尚未完成，验收目标已保留。</p>}
        <button disabled={busy} onClick={() => onResume(request)}>{request.status === "failed" || request.interrupted ? "重试" : "继续修改"}</button>
      </>}
    </article>)}
  </section>;
}
