import { useRef, useState } from "react";
import { FlaskConical, X } from "lucide-react";
import type { EvolutionAcceptanceState } from "../evolution-types";
import type { Thread } from "../types";

interface Props {
  currentCaseIds?: string[];
  state?: EvolutionAcceptanceState;
  thread?: Thread | null;
  busy: boolean;
  canCompare?: boolean;
  onAction: (action: string, params?: Record<string, unknown>) => void;
  onImprove: (id: string) => void;
  onCreate: (input: Record<string, unknown>) => Promise<void>;
}
const labels = { passed: "通过", failed: "未通过", error: "运行失败", manual: "待人工验收" };

/** Purpose: Capture human acceptance criteria before editing, then expose comparable version evidence. */
export function EvolutionCases({ state, thread, busy, canCompare, onAction, onImprove, onCreate, currentCaseIds = [] }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [expectation, setExpectation] = useState("");
  const [issue, setIssue] = useState("");
  const [saving, setSaving] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const cases = state?.cases.filter((item) => item.enabled) || [];
  return <section className="evolution-cases" aria-label="行为验收">
    <div className="evolution-cases-heading"><FlaskConical size={15} /><strong>{state ? "行为验收" : "改进 Cleo"}</strong>
      {state && <span>{cases.length} 个案例 · {state.fresh ? "结果对应当前构建" : "等待比较当前构建"}</span>}
      <button disabled={busy} onClick={() => { setTitle(thread?.title || ""); setExpectation(""); setIssue(""); dialog.current?.showModal(); }}>
        {thread ? "从此对话创建改进案例" : "添加验收案例"}</button>
      {state && <button disabled={busy || !canCompare || !cases.length} onClick={() => onAction("compareCases")}>比较行为</button>}
    </div>
    {state && Boolean(cases.length) && <details className="evolution-case-list"><summary>查看预期和修改前后结果</summary>
      <p className="evolution-case-help">自动回放使用固定模型输出和独立临时数据。普通对话需要人工验证；构建通过不能替代行为验收。</p>
      {cases.map((item) => {
        const result = state.report?.results.find((entry) => entry.id === item.id);
        return <article key={item.id} className="evolution-case">
          <div><b>{item.title}</b><small>{currentCaseIds.includes(item.id) ? "本轮新增" : "回归案例"} · {item.kind === "dream-format" ? "自动 · Dream 格式恢复" : "人工 · 行为验收"}</small></div>
          <p>{item.expectation}</p>
          <div className="evolution-comparison">
            <div><small>修改前</small><strong>{!result || result.before.status === "manual" ? "尚未验证" : labels[result.before.status]}</strong><p>{result?.before.detail}</p></div>
            <div><small>当前构建 {state.fresh ? "" : "· 旧结果不可用于验收"}</small><strong>{result ? labels[result.after.status] : "待比较"}</strong><p>{result?.after.detail}</p></div>
          </div>
          <details><summary>原始证据 · {item.sourceThread || "用户提交"}</summary><pre>{item.evidence || "无附加证据"}</pre></details>
          {item.kind === "manual" && state.fresh && result?.after.status === "manual" && <div className="evolution-manual-review">
            <label>验收依据<textarea aria-label={`验收依据：${item.title}`} value={notes[item.id] || ""} maxLength={4000}
              placeholder="记录你检查了什么，以及观察到的结果" onChange={(event) => setNotes({ ...notes, [item.id]: event.target.value })} /></label>
            <button disabled={busy || !notes[item.id]?.trim()} onClick={() => onAction("reviewCase", { id: item.id, note: notes[item.id] })}>记录人工验收通过</button>
          </div>}
          <footer><button disabled={busy} onClick={() => onImprove(item.id)}>让 Cleo 按此案例改进</button>
            <button disabled={busy} onClick={() => onAction("archiveCase", { id: item.id })}>归档案例</button></footer>
        </article>;
      })}
    </details>}
    <dialog ref={dialog} className="evolution-dialog" onCancel={() => dialog.current?.close()}>
      <div className="evolution-dialog-title"><h2>冻结改进案例</h2><button aria-label="关闭案例" onClick={() => dialog.current?.close()}><X size={18} /></button></div>
      <p>先保存当前对话和预期，再让 Cleo 修改自己。案例创建后保持原样；需要调整时归档并新建。</p>
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
