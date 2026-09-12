import { useState } from "react";
import type { EvolutionAcceptanceState, EvolutionRequest } from "../evolution-types";

interface Props {
  requests: EvolutionRequest[];
  acceptance?: EvolutionAcceptanceState;
  preparing: boolean;
  busy: boolean;
  onResume: (request: EvolutionRequest, clarification?: string) => void;
  onRevise: (params: Record<string, unknown>) => Promise<unknown>;
}

/** Show the durable request and frozen criteria in the conversation, independently of agent prose. */
export function EvolutionPreparation({ requests, acceptance, preparing, busy, onResume, onRevise }: Props) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [expectation, setExpectation] = useState("");
  const [trigger, setTrigger] = useState("");
  const [reason, setReason] = useState("");
  const [revisionId, setRevisionId] = useState("");
  const [error, setError] = useState("");
  return <section className="evolution-preparation" aria-label="本轮验收准备">
    {preparing && <p role="status">正在分析需求并准备验收…</p>}
    {requests.map((request, index) => <article key={request.id} className="evolution-request">
      <div className="evolution-request-heading"><strong>{request.status === "answered" ? "只读答复" : request.repair ? "修复 · 沿用冻结案例" : "验收准备"}</strong>
        <small>{request.status === "frozen" ? "已冻结" : request.status === "failed" ? "准备失败" : request.status === "clarification" ? "等待补充" : request.status === "answered" ? "未启动修改" : request.interrupted ? "准备中断" : "正在分析需求并准备验收"}</small></div>
      <p className="evolution-request-prompt">{request.prompt}</p>
      {request.answer && <p className="evolution-request-prompt">{request.answer}</p>}
      {request.reason && <p>需求调整原因：{request.reason}（旧案例仍保留）</p>}
      {request.error && <p role="alert">{request.error}</p>}
      {(request.status === "failed" || request.interrupted) && <button disabled={busy} onClick={() => onResume(request)}>重试准备原需求</button>}
      {request.status === "clarification" && <div className="evolution-manual-review">
        <label>补充需求<textarea aria-label="补充需求" value={answers[request.id] || ""} maxLength={5000}
          onChange={(event) => setAnswers({ ...answers, [request.id]: event.target.value })} /></label>
        <button disabled={busy || !answers[request.id]?.trim()} onClick={() => onResume(request, answers[request.id])}>补充并继续准备</button>
      </div>}
      {request.cases.map((detail) => {
        const { item } = detail;
        const active = acceptance?.cases.find((c) => c.id === item.id)?.enabled;
        const result = acceptance?.report?.results.find((r) => r.id === item.id)?.after;
        const isCurrent = index === requests.length - 1;
        return <details key={item.id} className="evolution-case" open={isCurrent}>
          <summary>{item.title} · {active === false ? "历史案例" : isCurrent && !request.repair ? "本轮新增" : "回归案例"}</summary>
          <dl><dt>对应要求</dt><dd>{detail.requirement}</dd><dt>当前行为</dt><dd>{detail.current}</dd>
            <dt>操作 / 触发</dt><dd>{detail.trigger}</dd><dt>预期结果</dt><dd>{item.expectation}</dd>
            <dt>验证方式与结果</dt><dd>{item.kind === "dream-format" ? "自动 · Dream 格式回放" : "人工验收"} · {
              acceptance?.fresh && result?.status === "passed" ? "通过" : acceptance?.fresh && result?.status === "failed" ? "未通过" : acceptance?.fresh && result?.status === "error" ? "运行失败" : item.kind === "manual" ? "待人工验收" : "待回放"}</dd></dl>
          <details><summary>查看静态证据</summary><pre>{detail.sourceEvidence || item.evidence}</pre></details>
          {active && !request.repair && <button disabled={busy} onClick={() => {
            setEditing(item.id); setExpectation(item.expectation); setTrigger(detail.trigger); setReason("");
            setRevisionId(crypto.randomUUID()); setError("");
          }}>修正案例</button>}
          {editing === item.id && <form className="evolution-manual-review" onSubmit={(event) => {
            event.preventDefault(); setError("");
            void onRevise({ id: revisionId, caseId: item.id, expectation, trigger, reason })
              .then(() => setEditing(null)).catch((failure: unknown) => setError(String(failure)));
          }}>
            <label>操作条件<textarea aria-label="操作条件" required maxLength={2000} value={trigger} onChange={(event) => setTrigger(event.target.value)} /></label>
            <label>修正后的预期<textarea aria-label="修正后的预期" required maxLength={4000} value={expectation} onChange={(event) => setExpectation(event.target.value)} /></label>
            <label>变更原因<textarea aria-label="变更原因" required maxLength={4000} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
            {error && <p role="alert">{error}</p>}
            <button disabled={busy || !reason.trim() || !expectation.trim() || !trigger.trim()}>保留旧案例并保存修正</button>
            <button type="button" onClick={() => setEditing(null)}>取消</button>
          </form>}
        </details>;
      })}
      {request.status === "frozen" && !request.execution
        && request.cases.every((c) => acceptance?.cases.some((item) => item.id === c.item.id && item.enabled)) && <button disabled={busy}
        onClick={() => onResume(request)}>按冻结案例继续实现</button>}
      {request.execution && <p>{request.execution.status === "completed" ? "实现任务已结束，行为结果见验收区。" : request.execution.status === "interrupted" ? "实现中断，已保留案例。可使用修复入口继续。" : "实现已提交；刷新不会重复发送。"}</p>}
      {request.execution && request.execution.status !== "completed" && <button disabled={busy}
        onClick={() => onResume(request)}>沿用案例继续未完成的实现</button>}
    </article>)}
  </section>;
}
