import { useRef, useState } from "react";
import { ArrowUp, FlaskConical, X } from "lucide-react";
import type { EvolutionAcceptanceState, EvolutionRequest } from "../evolution-types";
import type { Thread } from "../types";

interface Props {
  currentCaseIds?: string[];
  state?: EvolutionAcceptanceState;
  requests?: EvolutionRequest[];
  thread?: Thread | null;
  busy: boolean;
  canCompare?: boolean;
  canReview?: boolean;
  onAction: (action: string, params?: Record<string, unknown>) => void;
  onImprove: (caseId: string, body: string, requestId: string) => Promise<void>;
  onCreate: (input: Record<string, unknown>) => Promise<void>;
}
const labels = { passed: "通过", failed: "未通过", error: "运行失败", manual: "待人工验收" };

/** Purpose: Capture human acceptance criteria before editing, then expose comparable version evidence. */
export function EvolutionCases({ state, requests = [], thread, busy, canCompare, canReview, onAction, onImprove, onCreate, currentCaseIds = [] }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [expectation, setExpectation] = useState("");
  const [issue, setIssue] = useState("");
  const [saving, setSaving] = useState(false);
  const cases = state?.cases.filter((item) => item.enabled) || [];
  return <section className="evolution-cases" aria-label="行为验收">
    <div className="evolution-cases-heading"><FlaskConical size={15} /><strong>{state ? "行为验收" : "改进 Cleo"}</strong>
      {state && <span>{cases.length} 项待验收 · {state.fresh ? "结果对应当前构建" : "等待比较当前构建"}</span>}
      <button disabled={busy} onClick={() => { setTitle(thread?.title || ""); setExpectation(""); setIssue(""); dialog.current?.showModal(); }}>
        {thread ? "从此对话创建改进案例" : "添加验收案例"}</button>
      {state && <button disabled={busy || !canCompare || !cases.length} onClick={() => onAction("compareCases")}>比较行为</button>}
    </div>
    {state && Boolean(cases.length) && <details className="evolution-case-list"><summary>查看预期和修改前后结果</summary>
      <p className="evolution-case-help">应用后体验 Cleo，符合预期即可直接点击“验收”；不符合时，在对应项中描述新需求，让 Cleo 继续改进。应用本身不会自动完成验收。</p>
      {cases.map((item) => {
        const result = state.report?.results.find((entry) => entry.id === item.id);
        return <article key={item.id} className="evolution-case">
          <div><b>{item.title}</b><small>{currentCaseIds.includes(item.id) ? "本轮新增" : item.kind === "manual" ? "待完成" : "回归案例"} · {item.kind === "dream-format" ? "自动 · Dream 格式恢复" : "人工 · 行为验收"}</small></div>
          <p>{item.expectation}</p>
          <div className="evolution-comparison">
            <div><small>修改前</small><strong>{item.kind === "manual" ? "问题描述 · 来源：冻结的用户描述 / 源码证据，非运行验证" : !result ? "尚未验证" : labels[result.before.status]}</strong><p className="evolution-case-evidence">{item.kind === "manual" ? item.evidence || "未提供修改前证据，请依据案例主题与原始对话比对。" : result?.before.detail}</p></div>
            <div><small>当前构建 {state.fresh ? "" : "· 尚无有效验收结果"}</small><strong>{item.kind === "manual" && (!state.fresh || result?.after.status !== "passed") ? "预期效果 · 应用后待人工比对" : result ? labels[result.after.status] : "待比较"}</strong><p>{item.expectation}</p>
              {item.kind === "manual" && <p>应用后操作：{item.evidence.match(/(?:操作|触发条件)[：:]\s*([^\n]+)/)?.[1] || "按左侧证据中的场景操作"}。实际效果符合预期后，直接点击“验收”。</p>}
              {state.fresh && result?.after.status === "passed" && <p>{result.after.detail ? `验收记录：${result.after.detail}` : "用户已确认验收。"}</p>}
              {item.kind !== "manual" && result?.after.status !== "passed" && <p>{result?.after.detail}</p>}
            </div>
          </div>
          <details><summary>原始证据 · {item.sourceThread || "用户提交"}</summary><pre>{item.evidence || "无附加证据"}</pre></details>
          {item.kind === "manual" && state.fresh && result?.after.status === "manual" && !canReview && <p>应用当前构建后，在这里确认实际效果。</p>}
          <CaseFeedback caseId={item.id} title={item.title} state={state} requests={requests} busy={busy} onSend={onImprove} />
          {item.kind === "manual" && <footer><button disabled={busy || !canReview || !state.fresh
            || !result || state.interactions?.feedback.some((feedback) => feedback.caseId === item.id)}
            onClick={() => onAction("completeCase", { id: item.id })}>验收</button>
            <small>确认实际效果符合预期后结束此项</small></footer>}
        </article>;
      })}
    </details>}
    <dialog ref={dialog} className="evolution-dialog" onCancel={() => dialog.current?.close()}>
      <div className="evolution-dialog-title"><h2>冻结改进案例</h2><button aria-label="关闭案例" onClick={() => dialog.current?.close()}><X size={18} /></button></div>
      <p>先记录当前对话和预期，再让 Cleo 修改。应用后不符合预期，可以直接在验收项里继续反馈；确认通过后结束。</p>
      <form onSubmit={(event) => {
        event.preventDefault(); setSaving(true); setIssue("");
        const evidence = thread?.items.filter((item) => item.type === "message" || item.type === "notice" || item.type === "tool")
          .map((item) => JSON.stringify(item)).join("\n") || "";
        void onCreate({ title, expectation, evidence, sourceThread: thread?.id || "", kind: "manual" })
          .then(() => dialog.current?.close()).catch((error: unknown) => setIssue(error instanceof Error ? error.message : "保存失败"))
          .finally(() => setSaving(false));
      }}>
        <label>案例名称<input autoFocus aria-label="案例名称" required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>预期行为<textarea aria-label="预期行为" required maxLength={4000} value={expectation} onChange={(event) => setExpectation(event.target.value)} placeholder="例如：模型返回格式错误时，保留已有进度并自动尝试纠正，最多三次" /></label>
        {thread && <p>将保存「{thread.title}」当前已加载的对话记录，来源 {thread.id}。</p>}
        {issue && <p role="alert">{issue}</p>}
        <button className="evolution-primary" disabled={busy || saving || !title.trim() || !expectation.trim()}>保存案例并打开进化</button>
      </form>
    </dialog>
  </section>;
}

/** Keep draft retries stable and show feedback across successive frozen revisions. */
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
  return <div className="evolution-feedback">
    <p>不符合预期可在这里继续描述并修改。</p>
    <div className="evolution-feedback-history" role="log" aria-label={`反馈记录：${title}`}>
      {messages.map((message) => {
        const request = requests.find((r) => r.id === message.id);
        return <div key={message.id}><p className="evolution-feedback-user"><small>你</small>{message.body}</p>
          <p className="evolution-feedback-reply"><small>Cleo</small>{request?.error || (request?.execution?.status === "completed"
            ? "本轮实现已结束，请查看构建结果；应用后再次验收。" : request?.execution?.status === "interrupted"
              ? "实现已中断，可在对话中继续。" : request?.execution ? "正在根据反馈修改。" : request?.status === "frozen"
                ? "已更新待验收预期，准备继续修改。" : "反馈已保存，正在准备；如需补充信息，请在对话中确认。")}
            {request?.answer && <span className="evolution-feedback-assumption">{request.answer}</span>}</p></div>;
      })}
    </div>
    <form onSubmit={(event) => {
      event.preventDefault(); if (!body.trim() || sending || busy) return;
      setSending(true); setError("");
      void onSend(caseId, body, requestId).then(() => { setBody(""); setRequestId(crypto.randomUUID()); })
        .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
        .finally(() => setSending(false));
    }}>
      <textarea aria-label={`继续反馈：${title}`} placeholder="实际表现是什么？你希望怎样调整？" value={body} maxLength={5000}
        disabled={sending || busy} onChange={(event) => { setBody(event.target.value); setRequestId(crypto.randomUUID()); }} />
      <button type="submit" aria-label={`发送反馈：${title}`} disabled={busy || sending || !body.trim()}><ArrowUp size={16} /></button>
    </form>
    {error && <p role="alert">{error}</p>}
  </div>;
}
