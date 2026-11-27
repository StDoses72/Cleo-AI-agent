import { t as tr } from "../../../electron/i18n.mjs";
import { ArrowLeft, BookmarkPlus, Check, CircleAlert, LoaderCircle, MessageSquare, PanelRight, Play, Redo2, Sparkles, Trash2, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, useLayoutEffect } from "react";
import { effortLabels } from "../../runtime-labels";
import type { WorkflowDefinition, WorkflowEdge, WorkflowHarness, WorkflowNode, WorkflowNodeFields, WorkflowRole } from "../../workflow-types";
import { WorkflowCanvas, type CanvasFrame, type CanvasSelection, type NodePreset } from "./WorkflowCanvas";
import { issueText } from "./workflow-labels";
import { MAX_ITEMS, MAX_ROUNDS, fieldsOf, removeEdge, removeNode, withRuntime, workflowIssues, type WorkflowIssue } from "./workflow-model";

interface WorkflowEditorProps {
  definition: WorkflowDefinition;
  onChange: (definition: WorkflowDefinition) => void;
  harnesses: readonly WorkflowHarness[];
  /** Node definitions the user kept; offered next to the built-in ones. */
  roles: readonly WorkflowRole[];
  /** Already in the library (a draft or a new workflow is not, until saved). */
  saved: boolean;
  /** Differs from what the library holds. */
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onRun: () => void;
  onBack: () => void;
  onNotify: (message: string, tone?: "success" | "error") => void;
  /** Have Cleo write a node's definition from one sentence. */
  onDraftNode: (intent: string, definition: WorkflowDefinition, nodeId: string) => Promise<Partial<WorkflowNodeFields>>;
  onSaveRole: (fields: WorkflowNodeFields) => Promise<void>;
}

/** How an opened node shows what it is set to: a card beside it, or a panel at the side. */
type DetailStyle = "card" | "panel";
const DETAIL_KEY = "cleo-workflow-detail";
const CARD_WIDTH = 320;

/** Ready-made nodes for the menu: a blank one, a few common roles, and what the user kept. */
function nodePresets(roles: readonly WorkflowRole[]): NodePreset[] {
  const preset = (key: string, label: string, instructions: string, fields: Partial<WorkflowNodeFields> = {}): NodePreset =>
    ({ key, label, fields: { role: label, instructions, ...fields } });
  return [
    { key: "blank", label: tr("workflows.preset_blank"), fields: {} },
    preset("planner", tr("workflows.preset_planner"), tr("workflows.preset_planner_text")),
    preset("reviewer", tr("workflows.preset_reviewer"), tr("workflows.preset_reviewer_text")),
    preset("executor", tr("workflows.preset_executor"), tr("workflows.preset_executor_text"), { access: "write" }),
    preset("acceptance", tr("workflows.preset_acceptance"), tr("workflows.preset_acceptance_text")),
    ...roles.map((role): NodePreset => ({ key: role.id, label: role.fields.role, saved: true, fields: role.fields })),
  ];
}

/** Purpose: Build one workflow on a canvas that fills the page. Structure is made by hand there;
 * a node shows only its name, and what it is set to opens when it is selected. */
export function WorkflowEditor({ definition, onChange, harnesses, roles, saved, dirty, saving, error, onSave, onRun, onBack, onNotify, onDraftNode, onSaveRole }: WorkflowEditorProps) {
  const [selection, setSelection] = useState<CanvasSelection>(null);
  const [detail, setDetail] = useState<DetailStyle>(() => {
    try { return localStorage.getItem(DETAIL_KEY) === "panel" ? "panel" : "card"; } catch { return "card"; }
  });
  const [drafting, setDrafting] = useState<ReadonlySet<string>>(new Set());
  const [issuesOpen, setIssuesOpen] = useState(false);
  const issues = useMemo(() => workflowIssues(definition, harnesses), [definition, harnesses]);
  const flagged = useMemo(() => new Set(issues.flatMap((issue) => [issue.nodeId, issue.edgeId].filter((id): id is string => Boolean(id)))), [issues]);
  const presets = nodePresets(roles);
  // What is on screen now, for results that arrive later (a drafted definition).
  const latest = useRef(definition);
  latest.current = definition;
  // Undo steps are whole definitions. Changes with the same tag made in quick succession
  // (typing in one field, nudging one node) count as one step.
  const history = useRef({ past: [] as WorkflowDefinition[], future: [] as WorkflowDefinition[], tag: "", at: 0 });
  const [, refresh] = useState(0);
  const change = (next: WorkflowDefinition, tag = "") => {
    const record = history.current;
    const now = Date.now();
    if (!(tag && tag === record.tag && now - record.at < 900)) record.past.push(latest.current);
    if (record.past.length > 100) record.past.shift();
    record.future = [];
    record.tag = tag;
    record.at = now;
    refresh((value) => value + 1);
    onChange(next);
  };
  const travel = (from: WorkflowDefinition[], to: WorkflowDefinition[]) => {
    const target = from.pop();
    if (!target) return;
    to.push(latest.current);
    history.current.tag = "";
    refresh((value) => value + 1);
    onChange(target);
  };
  const undo = () => travel(history.current.past, history.current.future);
  const redo = () => travel(history.current.future, history.current.past);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || (event.target as Element).closest("input, textarea, select")) return;
    const key = event.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    event.preventDefault();
    if (key === "y" || event.shiftKey) redo(); else undo();
  };

  const node = selection?.kind === "node" ? definition.nodes.find((item) => item.id === selection.id) : undefined;
  const edge = selection?.kind === "edge" ? definition.edges.find((item) => item.id === selection.id) : undefined;
  // Opening a drafted node is the look the user may or may not take; after it the mark goes.
  useEffect(() => {
    if (node?.drafted) onChange({ ...definition, nodes: definition.nodes.map((item) => item.id === node.id ? { ...item, drafted: undefined } : item) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.id]);
  const editNode = (next: WorkflowNode, field: string) =>
    change({ ...definition, nodes: definition.nodes.map((item) => item.id === next.id ? next : item) }, `${next.id}:${field}`);
  const editEdge = (next: WorkflowEdge, field: string) =>
    change({ ...definition, edges: definition.edges.map((item) => item.id === next.id ? next : item) }, `${next.id}:${field}`);
  const draftNode = (nodeId: string, intent: string) => {
    setDrafting((current) => new Set(current).add(nodeId));
    void onDraftNode(intent, latest.current, nodeId).then((fields) => {
      const current = latest.current;
      if (!current.nodes.some((item) => item.id === nodeId)) return;
      // Applied as written: the user may open the node to look, and does not have to.
      change({ ...current, nodes: current.nodes.map((item) => item.id === nodeId
        ? { ...item, ...fields, drafted: selection?.id === nodeId ? undefined : true } : item) });
    }).catch((reason: unknown) => onNotify(reason instanceof Error ? reason.message : String(reason), "error"))
      .finally(() => setDrafting((current) => { const next = new Set(current); next.delete(nodeId); return next; }));
  };
  const chooseDetail = (style: DetailStyle) => {
    setDetail(style);
    try { localStorage.setItem(DETAIL_KEY, style); } catch { /* per-viewer convenience */ }
  };
  const openIssue = (issue: WorkflowIssue) => {
    setIssuesOpen(false);
    if (issue.nodeId) setSelection({ kind: "node", id: issue.nodeId });
    else if (issue.edgeId) setSelection({ kind: "edge", id: issue.edgeId });
    else if (issue.code === "name_missing") document.querySelector<HTMLInputElement>(".wf-name-input")?.focus();
  };
  const nodeCard = node ? (
    <NodeCard node={node} harnesses={harnesses} busy={drafting.has(node.id)}
      issues={issues.filter((issue) => issue.nodeId === node.id)}
      onChange={editNode} onRedraft={(intent) => draftNode(node.id, intent)}
      onKeep={() => void onSaveRole(fieldsOf(node)).catch((reason: unknown) => onNotify(reason instanceof Error ? reason.message : String(reason), "error"))}
      onRemove={() => { change(removeNode(definition, node.id)); setSelection(null); }}
      onClose={() => setSelection(null)} />
  ) : null;
  // The card is as tall as what it holds, which changes when "more" opens: its height is
  // measured so that it can be kept whole inside the canvas.
  const cardElement = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState(0);
  useLayoutEffect(() => {
    const element = cardElement.current;
    if (!element) return;
    const measure = () => setCardHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [node?.id, detail]);
  /** A card beside its node: to the right where there is room, otherwise to the left; level with
   * the node's top, moved up as far as it must to stay inside the canvas. */
  const beside = (frame: CanvasFrame, nodeId: string) => {
    const box = frame.node(nodeId);
    if (!box) return null;
    const right = box.left + box.width + 12;
    const left = right + CARD_WIDTH <= frame.width - 8 ? right : Math.max(8, box.left - CARD_WIDTH - 12);
    return { left, top: Math.max(8, Math.min(box.top - 8, frame.height - cardHeight - 8)) };
  };

  return (
    <div className="wf-editor" data-testid="workflow-editor" data-detail={detail} onKeyDown={keyDown}>
      <header className="wf-editor-bar">
        <button type="button" className="icon-button" onClick={onBack} aria-label={tr("workflows.title")} title={tr("workflows.title")} data-testid="workflow-back"><ArrowLeft size={16} /></button>
        <input className="wf-name-input" value={definition.name} maxLength={60} placeholder={tr("workflows.name_placeholder")} title={definition.description || undefined}
          aria-label={tr("workflows.name")} onChange={(event) => change({ ...definition, name: event.target.value }, "name")} />
        {definition.origin === "drafted" && !saved ? <span className="wf-state-note drafted"><Sparkles size={13} />{tr("workflows.drafted_tag")}</span> : null}
        <div className="wf-header-actions">
          {error ? <span className="wf-inline-error" role="alert">{error}</span>
            : dirty ? <span className="wf-state-note" data-testid="workflow-state">{saved ? tr("workflows.unsaved_changes") : tr("workflows.not_saved")}</span>
            : <span className="wf-state-note saved" data-testid="workflow-state"><Check size={13} />{tr("workflows.saved")}</span>}
          {issues.length ? (
            <div className="wf-issues">
              <button type="button" className="wf-issues-chip" aria-expanded={issuesOpen} data-testid="workflow-issues"
                aria-label={tr("workflows.issues_title", { p0: issues.length })} title={tr("workflows.issues_title", { p0: issues.length })}
                onClick={() => setIssuesOpen((open) => !open)}><CircleAlert size={14} />{issues.length}</button>
              {issuesOpen ? (
                <ul className="wf-issues-list surface-popover" data-testid="workflow-checks">
                  {issues.map((issue, index) => (
                    <li key={`${issue.code}-${issue.nodeId ?? issue.edgeId ?? index}`}><button type="button" onClick={() => openIssue(issue)}>{issueText(issue)}</button></li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <div className="segmented-control wf-detail-switch" role="group" aria-label={tr("workflows.detail_style")}>
            <button type="button" className={detail === "card" ? "active" : ""} aria-pressed={detail === "card"} data-testid="detail-card"
              aria-label={tr("workflows.detail_card")} title={tr("workflows.detail_card")} onClick={() => chooseDetail("card")}><MessageSquare size={14} /></button>
            <button type="button" className={detail === "panel" ? "active" : ""} aria-pressed={detail === "panel"} data-testid="detail-panel"
              aria-label={tr("workflows.detail_panel")} title={tr("workflows.detail_panel")} onClick={() => chooseDetail("panel")}><PanelRight size={14} /></button>
          </div>
          <button type="button" className="icon-button" disabled={!history.current.past.length} onClick={undo}
            aria-label={tr("workflows.undo")} title={tr("workflows.undo")} data-testid="workflow-undo"><Undo2 size={15} /></button>
          <button type="button" className="icon-button" disabled={!history.current.future.length} onClick={redo}
            aria-label={tr("workflows.redo")} title={tr("workflows.redo")} data-testid="workflow-redo"><Redo2 size={15} /></button>
          <button type="button" className="wf-button" disabled={!dirty || saving || !definition.name.trim()}
            title={definition.name.trim() ? undefined : tr("workflows.issue_name_missing")} onClick={onSave} data-testid="workflow-save">
            {saving ? <LoaderCircle size={14} className="spin" /> : null}{tr("workflows.save")}
          </button>
          <button type="button" className="wf-button primary" disabled={issues.length > 0 || saving} onClick={onRun} data-testid="workflow-run"
            title={issues.length ? tr("workflows.fix_issues_first") : undefined}>
            <Play size={14} />{tr("workflows.run")}
          </button>
        </div>
      </header>

      <WorkflowCanvas definition={definition} harnesses={harnesses} presets={presets} flagged={flagged} drafting={drafting}
        selection={selection} onSelect={setSelection} onChange={(next) => change(next)} onDraftNode={draftNode}
        onNotice={(message) => onNotify(message, "error")}>
        {(frame) => {
          if (node) {
            if (detail === "panel") return <aside className="wf-detail panel" data-testid="node-detail" aria-label={tr("workflows.node")}>{nodeCard}</aside>;
            const at = beside(frame, node.id);
            return at ? <div ref={cardElement} className="wf-detail card surface-popover" data-testid="node-detail" role="dialog" aria-label={tr("workflows.node")} style={at}>{nodeCard}</div> : null;
          }
          if (!edge) return null;
          const at = frame.edge(edge.id);
          if (!at) return null;
          return (
            <div className="wf-detail edge surface-popover" data-testid="edge-detail" role="dialog" aria-label={edge.loop ? tr("workflows.loop") : tr("workflows.edge")}
              style={{ left: Math.min(at.left + 14, frame.width - (edge.loop ? 268 : 48)), top: Math.max(8, at.top - 18) }}>
              {edge.loop ? (
                <>
                  <label>{tr("workflows.max_rounds")}
                    <input type="number" min={1} max={MAX_ROUNDS} value={edge.loop.maxRounds || ""} data-testid="loop-rounds"
                      onChange={(event) => editEdge({ ...edge, loop: { ...edge.loop!, maxRounds: Number(event.target.value) } }, "rounds")} /></label>
                  <select value={edge.loop.onExhausted} aria-label={tr("workflows.on_exhausted")} title={tr("workflows.on_exhausted")}
                    onChange={(event) => editEdge({ ...edge, loop: { ...edge.loop!, onExhausted: event.target.value as "stop" | "continue" } }, "exhausted")}>
                    <option value="stop">{tr("workflows.on_exhausted_stop")}</option>
                    <option value="continue">{tr("workflows.on_exhausted_continue")}</option>
                  </select>
                </>
              ) : null}
              <button type="button" className="icon-button" aria-label={tr("workflows.menu_delete_edge")} title={tr("workflows.menu_delete_edge")}
                data-testid="edge-delete" onClick={() => { change(removeEdge(definition, edge.id)); setSelection(null); }}><Trash2 size={14} /></button>
            </div>
          );
        }}
      </WorkflowCanvas>
    </div>
  );
}

/** Purpose: Everything one node is set to, most used first: its name, what it is responsible for,
 * and where it runs. What is changed less often sits behind one disclosure. */
function NodeCard({ node, harnesses, busy, issues, onChange, onRedraft, onKeep, onRemove, onClose }: {
  node: WorkflowNode;
  harnesses: readonly WorkflowHarness[];
  /** Cleo is writing this node's definition. */
  busy: boolean;
  issues: WorkflowIssue[];
  onChange: (node: WorkflowNode, field: string) => void;
  onRedraft: (intent: string) => void;
  onKeep: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [intent, setIntent] = useState("");
  const harness = harnesses.find((item) => item.id === node.harness);
  const model = harness?.models.find((item) => item.id === node.model);
  const runtime = (change: Partial<Pick<WorkflowNodeFields, "harness" | "model" | "effort" | "speed">>, field: string) =>
    onChange(withRuntime(node, harnesses, change), field);
  return (
    <div className="wf-node-card" aria-busy={busy}>
      <header>
        <input className="wf-card-name" value={node.role} maxLength={24} placeholder={tr("workflows.role_placeholder")} aria-label={tr("workflows.role")}
          data-field="role" onChange={(event) => onChange({ ...node, role: event.target.value }, "role")} />
        <button type="button" className="icon-button" onClick={onKeep} disabled={!node.role.trim()} data-testid="node-keep"
          aria-label={tr("workflows.keep_role")} title={tr("workflows.keep_role")}><BookmarkPlus size={15} /></button>
        <button type="button" className="icon-button" onClick={onRemove} data-testid="node-remove"
          aria-label={tr("workflows.menu_delete_node")} title={tr("workflows.menu_delete_node")}><Trash2 size={14} /></button>
        <button type="button" className="icon-button" onClick={onClose} aria-label={tr("app.close")} title={tr("app.close")}><X size={15} /></button>
      </header>
      {issues.map((issue) => <p className="wf-card-issue" key={issue.code}><CircleAlert size={13} />{issueText(issue)}</p>)}
      <textarea className="wf-card-text" rows={6} value={node.instructions} maxLength={2000} placeholder={tr("workflows.instructions_placeholder")}
        aria-label={tr("workflows.instructions")} data-field="instructions" disabled={busy}
        onChange={(event) => onChange({ ...node, instructions: event.target.value }, "instructions")} />
      <form className="wf-card-ask" onSubmit={(event) => { event.preventDefault(); if (intent.trim() && !busy) { onRedraft(intent.trim()); setIntent(""); } }}>
        {busy ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
        <input value={intent} disabled={busy} maxLength={120} placeholder={busy ? tr("workflows.drafting_node") : tr("workflows.redraft_placeholder")}
          aria-label={tr("workflows.redraft_placeholder")} data-testid="node-redraft" onChange={(event) => setIntent(event.target.value)} />
      </form>

      <div className="wf-card-runtime">
        <select value={node.harness ?? ""} aria-label={tr("workflows.harness")} title={tr("workflows.harness")} data-field="harness"
          onChange={(event) => runtime({ harness: event.target.value || null }, "harness")}>
          <option value="">{tr("workflows.runtime_inherit")}</option>
          {node.harness && !harness ? <option value={node.harness}>{node.harness}</option> : null}
          {harnesses.map((item) => (
            <option key={item.id} value={item.id} disabled={!item.available}>
              {item.label}{item.available ? "" : `${tr("punctuation.openParen")}${item.reason || tr("workflows.runtime_unavailable")}${tr("punctuation.closeParen")}`}
            </option>
          ))}
        </select>
        {harness ? (
          <select value={node.model ?? ""} aria-label={tr("workflows.model")} title={tr("workflows.model")} data-field="model"
            onChange={(event) => runtime({ model: event.target.value }, "model")}>
            {harness.models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        ) : null}
        {model?.supportedEfforts.length ? (
          <select value={node.effort ?? ""} aria-label={tr("workflows.effort")} title={tr("workflows.effort")} data-field="effort"
            onChange={(event) => runtime({ effort: (event.target.value || null) as WorkflowNodeFields["effort"] }, "effort")}>
            <option value="">{tr("workflows.effort_default")}</option>
            {model.supportedEfforts.map((effort) => <option key={effort} value={effort}>{effortLabels[effort]}</option>)}
          </select>
        ) : null}
        {model?.serviceTiers?.length ? (
          <select value={node.speed ?? ""} aria-label={tr("workflows.speed")} title={tr("workflows.speed")} data-field="speed"
            onChange={(event) => runtime({ speed: (event.target.value || null) as WorkflowNodeFields["speed"] }, "speed")}>
            <option value="">{tr("workflows.speed_standard")}</option>
            {model.serviceTiers.map((tier) => <option key={tier.id} value={tier.id}>{tier.label}</option>)}
          </select>
        ) : null}
      </div>

      <details className="wf-card-more">
        <summary>{tr("workflows.more")}</summary>
        <Toggle label={tr("workflows.limit_write")} checked={node.access === "write"} testId="limit-write"
          onChange={(checked) => onChange({ ...node, access: checked ? "write" : "read", workspace: checked ? node.workspace : "shared" }, "access")} />
        {node.access === "write" ? (
          <Toggle label={tr("workflows.limit_worktree")} checked={node.workspace === "worktree"}
            onChange={(checked) => onChange({ ...node, workspace: checked ? "worktree" : "shared" }, "workspace")} />
        ) : null}
        <Toggle label={tr("workflows.limit_delegate")} checked={node.delegation === "on"}
          onChange={(checked) => onChange({ ...node, delegation: checked ? "on" : "off" }, "delegation")} />
        <Toggle label={tr("workflows.copies_each")} checked={node.each !== null}
          onChange={(checked) => onChange({ ...node, each: checked ? node.each ?? 4 : null }, "each")}>
          {node.each !== null ? (
            <input type="number" min={2} max={MAX_ITEMS} value={node.each || ""} aria-label={tr("workflows.max_items")} title={tr("workflows.max_items")}
              data-testid="each-limit" onChange={(event) => onChange({ ...node, each: Number(event.target.value) }, "each-limit")} />
          ) : null}
        </Toggle>
      </details>
    </div>
  );
}

function Toggle({ label, checked, onChange, testId, children }: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="wf-toggle">
      <span>{label}</span>
      {children}
      <label className="switch"><input type="checkbox" checked={checked} aria-label={label} data-testid={testId} onChange={(event) => onChange(event.target.checked)} /><span /></label>
    </div>
  );
}
