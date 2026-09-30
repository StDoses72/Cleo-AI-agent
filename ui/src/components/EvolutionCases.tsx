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
const labels = { passed: "通过", failed: "未通过", error: "运行失败", manual: "待确认" };

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
  return <section className={`evolution-cases${dialogOnlyView ? " dialog-only" : ""}`} aria-label={dialogOnlyView ? undefined : "行为验收"}>
    {!dialogOnlyView && <div className="evolution-cases-heading"><FlaskConical size={15} /><strong>验收清单</strong>
      {state && <span>{cases.length} 项待验收</span>}
      <button disabled={busy} onClick={openDialog}>
        {thread ? "从此对话创建改进案例" : "添加目标"}</button>
    </div>}
    {state && Boolean(cases.length) && <details className="evolution-case-list"><summary>查看目标与结果</summary>
      {cases.map((item, index) => {
        const result = state.report?.results.find((entry) => entry.id === item.id);
        const detail = requests.flatMap(request => request.cases).find(c => c.item.id === item.id);
        const before = detail?.current || item.evidence.match(/当前行为[：:]([\s\S]*?)(?=\n操作[：:]|\n静态证据[：:]|$)/)?.[1];
        const trigger = detail?.trigger || item.evidence.match(/(?:操作|触发条件)[：:]\s*([^\n]+)/)?.[1];
        const lastFeedback = state.interactions?.feedback.filter((feedback) => feedback.caseId === item.id).at(-1);
        const request = requests.find(entry => entry.cases.some(detail => detail.item.id === item.id));
        return <article key={item.id} className="evolution-case">
          <div><b>{index + 1}. {item.title}</b><small>{!state.fresh ? "等待检查" : result ? labels[result.after.status] : "待确认"}</small></div>
          <p>{item.expectation}</p>
          {trigger && <p>操作：{trigger}</p>}
          {state.fresh && result?.after.detail && result.after.status !== "manual" && <p>{result.after.detail}</p>}
          <details><summary>依据与历史</summary>
            <p className="evolution-case-evidence">修改前{item.kind === "manual" ? "（源码分析，未实测）" : ""}：{item.kind === "manual" ? before || "未记录" : result?.before.detail || "未记录"}</p>
            {request?.answer && <p>{request.answer}</p>}
            {request?.reason && <p>调整原因：{request.reason}</p>}
            <pre>{detail?.sourceEvidence || item.evidence || "无附加证据"}</pre>
            {onRevise && !request?.repair && <CaseCriteria item={item} trigger={trigger || ""} busy={busy} onRevise={onRevise} />}
          </details>
          {item.kind === "manual" && state.fresh && result?.after.status === "manual" && !canReview && <p>应用修改后可确认效果。</p>}
          <CaseFeedback caseId={item.id} title={item.title} state={state} requests={requests} busy={busy} onSend={onImprove} />
          {item.kind === "manual" && <footer><button disabled={busy || !canReview || !state.fresh
            || !result || Boolean(lastFeedback && lastFeedback.mode !== "continue")}
            onClick={() => onAction("completeCase", { id: item.id })}>确认效果</button>
            <button disabled={busy} onClick={() => onAction("cancelCase", { id: item.id })}>取消此项</button></footer>}
        </article>;
      })}
    </details>}
    {history.length > 0 && <details className="evolution-case-list"><summary>历史记录 · {history.length} 项</summary>
      {history.map((item) => <article key={item.id} className="evolution-case"><b>{item.title}</b>
        <p>{item.expectation}</p><small>{item.cancelledAt ? "已取消，未记为通过" : state?.interactions?.completions.some(entry => entry.id === item.id) ? "已确认效果" : requests.some(request => request.replaces === item.id) ? "已调整目标" : "已归档"}</small>
        <details><summary>原始证据</summary><pre>{item.evidence}</pre></details></article>)}
    </details>}
    <dialog ref={dialog} className="evolution-dialog" aria-label="改进 Cleo" onKeyDown={handleDialogKeyDown} onCancel={event => { event.preventDefault(); closeDialog(); }}>
      <div className="evolution-dialog-title"><h2>改进 Cleo</h2><button aria-label="关闭案例" disabled={saving} onClick={closeDialog}><X size={18} /></button></div>
      <p>记录问题和期望效果，作为后续验收依据。</p>
      <form onSubmit={(event) => {
        event.preventDefault(); if (savingRef.current) return; savingRef.current = true; setSaving(true); setIssue("");
        const evidence = thread?.items.filter((item) => item.type === "message" || item.type === "notice" || item.type === "tool")
          .map((item) => JSON.stringify(item)).join("\n") || "";
        void onCreate({ title, expectation, evidence, sourceThread: thread?.id || "", kind: "manual" })
          .then(() => { savingRef.current = false; closeDialog(); }).catch((error: unknown) => setIssue(error instanceof Error ? error.message : "保存失败"))
          .finally(() => { savingRef.current = false; setSaving(false); });
      }}>
        <label>案例名称<input ref={titleInput} aria-label="案例名称" required maxLength={120} disabled={saving} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>预期行为<textarea aria-label="预期行为" required maxLength={4000} disabled={saving} value={expectation} onChange={(event) => setExpectation(event.target.value)} placeholder="例如：模型返回格式错误时，保留已有进度并自动尝试纠正，最多三次" /></label>
        {thread && <p>将附带「{thread.title}」已加载的对话记录。</p>}
        {issue && <p role="alert">{issue}</p>}
        <button className="evolution-primary" disabled={busy || saving || !title.trim() || !expectation.trim()}>保存案例并打开进化</button>
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
  return <details className="evolution-feedback"><summary>继续修改</summary>
    <div className="evolution-feedback-history" role="log" aria-label={`反馈记录：${title}`}>
      {messages.map((message) => {
        const request = requests.find((r) => r.id === message.id);
        return <div key={message.id}><p className="evolution-feedback-user"><small>你</small>{message.body}</p>
          <p className="evolution-feedback-reply"><small>Cleo</small>{request?.error || (request?.execution?.status === "completed"
            ? "本轮实现已结束，请查看构建结果；应用后再次验收。" : request?.execution?.status === "interrupted"
              ? "实现已中断，可在对话中继续。" : request?.execution ? "正在根据反馈修改。" : request?.status === "frozen"
                ? "已保留验收预期，准备继续修改。" : "反馈已保存，正在准备；如需补充信息，请在对话中确认。")}
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
      <textarea aria-label={`继续反馈：${title}`} placeholder="补充实际表现（可选）" value={body} maxLength={5000}
        disabled={sending || busy} onChange={(event) => { setBody(event.target.value); setRequestId(crypto.randomUUID()); }} />
      <button type="submit" aria-label={`继续修改：${title}`} disabled={busy || sending}><ArrowUp size={16} />继续修改</button>
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
  }}>调整目标</button>;
  return <form className="evolution-manual-review" onSubmit={event => {
    event.preventDefault(); if (savingRef.current || busy) return;
    savingRef.current = true; setSaving(true); setError("");
    void onRevise({ ...draft, caseId: item.id }).then(() => setEditing(false))
      .catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => { savingRef.current = false; setSaving(false); });
  }}>
    <label>操作条件<textarea autoFocus aria-label="操作条件" required maxLength={2000} disabled={saving} value={draft.trigger} onChange={event => setDraft({ ...draft, trigger: event.target.value, id: crypto.randomUUID() })} /></label>
    <label>调整后的目标<textarea aria-label="调整后的目标" required maxLength={4000} disabled={saving} value={draft.expectation} onChange={event => setDraft({ ...draft, expectation: event.target.value, id: crypto.randomUUID() })} /></label>
    <label>调整原因<textarea aria-label="调整原因" required maxLength={4000} disabled={saving} value={draft.reason} onChange={event => setDraft({ ...draft, reason: event.target.value, id: crypto.randomUUID() })} /></label>
    {error && <p role="alert">{error}</p>}
    <button disabled={busy || saving || !draft.reason.trim() || !draft.expectation.trim() || !draft.trigger.trim()}>保存目标</button>
    <button type="button" disabled={saving} onClick={() => setEditing(false)}>取消</button>
  </form>;
}
