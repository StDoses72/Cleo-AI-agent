import { t as tr } from "../../../electron/i18n.mjs";
import { ArrowLeft, ArrowRight, Check, CircleAlert, Copy, LoaderCircle, Play, Redo2, Repeat, Sparkles, Trash2, Undo2, X } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { effortLabels } from "../../runtime-labels";
import type { WorkflowDefinition, WorkflowEdge, WorkflowExecutor, WorkflowNode } from "../../workflow-types";
import { WorkflowCanvas, type CanvasSelection, type NodePreset } from "./WorkflowCanvas";
import { issueText, refusalText } from "./workflow-labels";
import {
  END, MAX_ITEMS, MAX_ROUNDS, NODE_WIDTH, START,
  addNode, agentBound, connect, forwardEdges, newNode, removeEdge, removeNode, workflowIssues,
} from "./workflow-model";

interface WorkflowEditorProps {
  definition: WorkflowDefinition;
  onChange: (definition: WorkflowDefinition) => void;
  executors: readonly WorkflowExecutor[];
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
}

/** Ready-made nodes for the palette and the right-click menu: a role with its instructions written. */
function nodePresets(): NodePreset[] {
  const preset = (key: string, label: string, instructions: string, fields: Partial<WorkflowNode> = {}): NodePreset =>
    ({ key, label, fields: { role: label, instructions, ...fields } });
  return [
    { key: "blank", label: tr("workflows.preset_blank"), fields: {} },
    preset("planner", tr("workflows.preset_planner"), tr("workflows.preset_planner_text")),
    preset("reviewer", tr("workflows.preset_reviewer"), tr("workflows.preset_reviewer_text")),
    preset("executor", tr("workflows.preset_executor"), tr("workflows.preset_executor_text"), { access: "write" }),
    preset("acceptance", tr("workflows.preset_acceptance"), tr("workflows.preset_acceptance_text")),
  ];
}

/** Purpose: Build one workflow on a canvas. Structure is made by hand there (create, drag, connect);
 * the panel beside it holds what the selected node or edge is set to, and what still keeps the
 * workflow from running. */
export function WorkflowEditor({ definition, onChange, executors, saved, dirty, saving, error, onSave, onRun, onBack, onNotify }: WorkflowEditorProps) {
  const [selection, setSelection] = useState<CanvasSelection>(null);
  const issues = useMemo(() => workflowIssues(definition, executors), [definition, executors]);
  const flagged = useMemo(() => new Set(issues.flatMap((issue) => [issue.nodeId, issue.edgeId].filter((id): id is string => Boolean(id)))), [issues]);
  const presets = nodePresets();
  // Undo steps are whole definitions. Changes with the same tag made in quick succession
  // (typing in one field, nudging one node) count as one step.
  const history = useRef({ past: [] as WorkflowDefinition[], future: [] as WorkflowDefinition[], tag: "", at: 0 });
  const [, refresh] = useState(0);
  const change = (next: WorkflowDefinition, tag = "") => {
    const record = history.current;
    const now = Date.now();
    if (!(tag && tag === record.tag && now - record.at < 900)) record.past.push(definition);
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
    to.push(definition);
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
  const roleOf = (id: string) => id === START ? tr("workflows.diagram_task") : id === END ? tr("workflows.diagram_result")
    : definition.nodes.find((item) => item.id === id)?.role || tr("workflows.unnamed_role");
  const editNode = (next: WorkflowNode, field: string) =>
    change({ ...definition, nodes: definition.nodes.map((item) => item.id === next.id ? next : item) }, `${next.id}:${field}`);
  const editEdge = (next: WorkflowEdge, field: string) =>
    change({ ...definition, edges: definition.edges.map((item) => item.id === next.id ? next : item) }, `${next.id}:${field}`);
  const link = (from: string, to: string) => {
    const linked = connect(definition, from, to);
    if ("refused" in linked) { onNotify(refusalText(linked.refused), "error"); return; }
    change(linked.definition);
  };
  const openNode = (nodeId: string) => {
    setSelection({ kind: "node", id: nodeId });
    requestAnimationFrame(() => {
      const field = document.querySelector<HTMLInputElement>('.wf-inspector [data-field="role"]');
      field?.focus();
      field?.select();
    });
  };
  const runBlocked = issues.length ? tr("workflows.fix_issues_first") : undefined;

  return (
    <div className="wf-editor" data-testid="workflow-editor" onKeyDown={keyDown}>
      <header className="wf-page-header">
        <button type="button" className="wf-back" onClick={onBack}><ArrowLeft size={15} />{tr("workflows.title")}</button>
        <div className="wf-header-actions">
          {error ? <span className="wf-inline-error" role="alert">{error}</span>
            : dirty ? <span className="wf-state-note">{saved ? tr("workflows.unsaved_changes") : tr("workflows.not_saved")}</span>
            : <span className="wf-state-note saved"><Check size={13} />{tr("workflows.saved")}</span>}
          <button type="button" className="icon-button" disabled={!history.current.past.length} onClick={undo}
            aria-label={tr("workflows.undo")} title={tr("workflows.undo")} data-testid="workflow-undo"><Undo2 size={15} /></button>
          <button type="button" className="icon-button" disabled={!history.current.future.length} onClick={redo}
            aria-label={tr("workflows.redo")} title={tr("workflows.redo")} data-testid="workflow-redo"><Redo2 size={15} /></button>
          <button type="button" className="wf-button" disabled={!dirty || saving || !definition.name.trim()}
            title={definition.name.trim() ? undefined : tr("workflows.issue_name_missing")} onClick={onSave} data-testid="workflow-save">
            {saving ? <LoaderCircle size={14} className="spin" /> : null}{tr("workflows.save")}
          </button>
          <button type="button" className="wf-button primary" disabled={issues.length > 0} title={runBlocked} onClick={onRun} data-testid="workflow-run">
            <Play size={14} />{tr("workflows.run")}
          </button>
        </div>
      </header>

      <input className="wf-name-input" value={definition.name} maxLength={60} placeholder={tr("workflows.name_placeholder")}
        aria-label={tr("workflows.name")} onChange={(event) => change({ ...definition, name: event.target.value }, "name")} />
      <textarea className="wf-description-input" rows={1} value={definition.description} maxLength={200} placeholder={tr("workflows.description_placeholder")}
        aria-label={tr("workflows.description")} onChange={(event) => change({ ...definition, description: event.target.value.replace(/\n/g, " ") }, "description")} />
      {definition.origin === "drafted" && !saved ? (
        <p className="wf-draft-note"><Sparkles size={14} /><span>{tr("workflows.drafted_note")}</span></p>
      ) : null}

      <div className="wf-editor-body">
        <WorkflowCanvas definition={definition} executors={executors} presets={presets} flagged={flagged}
          selection={selection} onSelect={setSelection} onChange={(next) => change(next)}
          onNotice={(message) => onNotify(message, "error")} onOpenNode={openNode} />

        <aside className="wf-inspector" aria-label={tr("workflows.inspector")}>
          {node ? (
            <section data-testid="node-inspector">
              <header>
                <h3>{tr("workflows.node")}</h3>
                <button type="button" className="icon-button" aria-label={tr("workflows.menu_duplicate_node")} title={tr("workflows.menu_duplicate_node")}
                  onClick={() => {
                    const { id: _original, ...fields } = node;
                    const copy = newNode(node.x + NODE_WIDTH + 24, node.y, fields);
                    change(addNode(definition, copy));
                    setSelection({ kind: "node", id: copy.id });
                  }}><Copy size={14} /></button>
                <button type="button" className="icon-button" aria-label={tr("workflows.menu_delete_node")} title={tr("workflows.menu_delete_node")}
                  data-testid="inspector-delete" onClick={() => { change(removeNode(definition, node.id)); setSelection(null); }}><Trash2 size={14} /></button>
              </header>
              <NodeFields node={node} executors={executors} onChange={editNode} />
              <NextSteps definition={definition} node={node} roleOf={roleOf} onLink={(to) => link(node.id, to)}
                onUnlink={(edgeId) => change(removeEdge(definition, edgeId))} onOpenEdge={(edgeId) => setSelection({ kind: "edge", id: edgeId })} />
            </section>
          ) : edge ? (
            <section data-testid="edge-inspector">
              <header>
                <h3>{edge.loop ? tr("workflows.loop") : tr("workflows.edge")}</h3>
                <button type="button" className="icon-button" aria-label={tr("workflows.menu_delete_edge")} title={tr("workflows.menu_delete_edge")}
                  data-testid="inspector-delete" onClick={() => { change(removeEdge(definition, edge.id)); setSelection(null); }}><Trash2 size={14} /></button>
              </header>
              <p className="wf-edge-ends"><strong>{roleOf(edge.from)}</strong>{edge.loop ? <Repeat size={13} /> : <ArrowRight size={13} />}<strong>{roleOf(edge.to)}</strong></p>
              {edge.loop ? (
                <>
                  <div className="wf-fields">
                    <label className="wf-field"><span>{tr("workflows.max_rounds")}</span>
                      <input type="number" min={1} max={MAX_ROUNDS} value={edge.loop.maxRounds || ""} data-testid="loop-rounds"
                        onChange={(event) => editEdge({ ...edge, loop: { ...edge.loop!, maxRounds: Number(event.target.value) } }, "rounds")} /></label>
                    <label className="wf-field"><span>{tr("workflows.on_exhausted")}</span>
                      <select value={edge.loop.onExhausted}
                        onChange={(event) => editEdge({ ...edge, loop: { ...edge.loop!, onExhausted: event.target.value as "stop" | "continue" } }, "exhausted")}>
                        <option value="stop">{tr("workflows.on_exhausted_stop")}</option>
                        <option value="continue">{tr("workflows.on_exhausted_continue")}</option>
                      </select></label>
                  </div>
                  <p className="wf-rule">{tr("workflows.loop_rule", { p0: roleOf(edge.from), p1: roleOf(edge.to) })}</p>
                </>
              ) : <p className="wf-rule">{tr("workflows.edge_rule", { p0: roleOf(edge.from), p1: roleOf(edge.to) })}</p>}
            </section>
          ) : (
            <section>
              <header><h3>{tr("workflows.guide_title")}</h3></header>
              <ul className="wf-guide">
                <li>{tr("workflows.guide_create")}</li>
                <li>{tr("workflows.guide_connect")}</li>
                <li>{tr("workflows.guide_shapes")}</li>
                <li>{tr("workflows.guide_edit")}</li>
              </ul>
            </section>
          )}

          <div className="wf-checks" data-testid="workflow-checks">
            {issues.length ? (
              <>
                <strong><CircleAlert size={14} />{tr("workflows.issues_title", { p0: issues.length })}</strong>
                <ul>
                  {issues.map((issue, index) => (
                    <li key={`${issue.code}-${issue.nodeId ?? issue.edgeId ?? index}`}>
                      <button type="button" onClick={() => {
                        if (issue.nodeId) setSelection({ kind: "node", id: issue.nodeId });
                        else if (issue.edgeId) setSelection({ kind: "edge", id: issue.edgeId });
                        else if (issue.code === "name_missing") document.querySelector<HTMLInputElement>(".wf-name-input")?.focus();
                      }}>{issueText(issue)}</button>
                    </li>
                  ))}
                </ul>
              </>
            ) : <p className="wf-ready"><Check size={14} />{tr("workflows.ready", { p0: agentBound(definition) })}</p>}
          </div>
        </aside>
      </div>
    </div>
  );
}

/** What follows a node, and the way to add or drop an edge without dragging. */
function NextSteps({ definition, node, roleOf, onLink, onUnlink, onOpenEdge }: {
  definition: WorkflowDefinition;
  node: WorkflowNode;
  roleOf: (id: string) => string;
  onLink: (to: string) => void;
  onUnlink: (edgeId: string) => void;
  onOpenEdge: (edgeId: string) => void;
}) {
  const outgoing = definition.edges.filter((edge) => edge.from === node.id);
  const taken = new Set(outgoing.map((edge) => edge.to));
  const choices = [...definition.nodes.filter((item) => item.id !== node.id && !taken.has(item.id)).map((item) => item.id), ...(taken.has(END) ? [] : [END])];
  return (
    <div className="wf-field wide wf-next">
      <span>{tr("workflows.next_steps")}</span>
      {outgoing.length ? (
        <ul>
          {outgoing.map((edge) => (
            <li key={edge.id}>
              <button type="button" className="wf-next-target" onClick={() => onOpenEdge(edge.id)}>
                {edge.loop ? <Repeat size={12} /> : <ArrowRight size={12} />}
                {edge.loop ? tr("workflows.next_loop", { p0: roleOf(edge.to), p1: edge.loop.maxRounds }) : roleOf(edge.to)}
              </button>
              <button type="button" className="icon-button" aria-label={tr("workflows.unlink_value", { p0: roleOf(edge.to) })} title={tr("workflows.menu_delete_edge")}
                onClick={() => onUnlink(edge.id)}><X size={13} /></button>
            </li>
          ))}
        </ul>
      ) : <small>{forwardEdges(definition).some((edge) => edge.to === node.id) ? tr("workflows.next_none") : tr("workflows.next_isolated")}</small>}
      {choices.length ? (
        <select value="" aria-label={tr("workflows.connect_to")} data-testid="connect-to" onChange={(event) => { if (event.target.value) onLink(event.target.value); }}>
          <option value="">{tr("workflows.connect_to")}</option>
          {choices.map((id) => <option key={id} value={id}>{roleOf(id)}</option>)}
        </select>
      ) : null}
    </div>
  );
}

function NodeFields({ node, executors, onChange }: {
  node: WorkflowNode;
  executors: readonly WorkflowExecutor[];
  onChange: (node: WorkflowNode, field: string) => void;
}) {
  const groups = useMemo(() => {
    const byHarness = new Map<string, WorkflowExecutor[]>();
    for (const executor of executors) byHarness.set(executor.harness, [...byHarness.get(executor.harness) ?? [], executor]);
    return [...byHarness];
  }, [executors]);
  const known = node.executorId === null || executors.some((executor) => executor.id === node.executorId);
  return (
    <div className="wf-fields">
      <label className="wf-field wide"><span>{tr("workflows.role")}</span>
        <input value={node.role} maxLength={24} placeholder={tr("workflows.role_placeholder")} data-field="role"
          onChange={(event) => onChange({ ...node, role: event.target.value }, "role")} /></label>
      <label className="wf-field wide"><span>{tr("workflows.executor")}</span>
        <select value={node.executorId ?? ""} data-field="executor" onChange={(event) => onChange({ ...node, executorId: event.target.value || null }, "executor")}>
          <option value="">{tr("workflows.executor_inherit")}</option>
          {known ? null : <option value={node.executorId ?? ""}>{tr("workflows.executor_unknown")}</option>}
          {groups.map(([harness, items]) => (
            <optgroup key={harness} label={harness}>
              {items.map((item) => (
                <option key={item.id} value={item.id} disabled={!item.available}>
                  {[item.model, item.effort ? effortLabels[item.effort] : ""].filter(Boolean).join(" · ")}
                  {item.available ? "" : `${tr("punctuation.openParen")}${item.reason || tr("workflows.executor_unavailable")}${tr("punctuation.closeParen")}`}
                </option>
              ))}
            </optgroup>
          ))}
        </select></label>
      <label className="wf-field wide"><span>{tr("workflows.instructions")}</span>
        <textarea rows={4} value={node.instructions} maxLength={2000} placeholder={tr("workflows.instructions_placeholder")} data-field="instructions"
          onChange={(event) => onChange({ ...node, instructions: event.target.value }, "instructions")} />
        <small>{tr("workflows.instructions_hint")}</small></label>
      <div className="wf-field wide"><span>{tr("workflows.access")}</span>
        <Segmented label={tr("workflows.access")} value={node.access}
          onChange={(access) => onChange({ ...node, access, workspace: access === "read" ? "shared" : node.workspace }, "access")}
          options={[["read", tr("workflows.access_read")], ["write", tr("workflows.access_write")]]} /></div>
      {node.access === "write" ? (
        <div className="wf-field wide"><span>{tr("workflows.workspace")}</span>
          <Segmented label={tr("workflows.workspace")} value={node.workspace} onChange={(workspace) => onChange({ ...node, workspace }, "workspace")}
            options={[["shared", tr("workflows.workspace_shared")], ["worktree", tr("workflows.workspace_worktree")]]} /></div>
      ) : null}
      <div className="wf-field wide"><span>{tr("workflows.copies")}</span>
        <Segmented label={tr("workflows.copies")} value={node.each === null ? "once" : "each"}
          onChange={(mode) => onChange({ ...node, each: mode === "once" ? null : node.each ?? 4 }, "each")}
          options={[["once", tr("workflows.copies_once")], ["each", tr("workflows.copies_each")]]} />
        {node.each !== null ? (
          <label className="wf-inline-number">{tr("workflows.max_items")}
            <input type="number" min={2} max={MAX_ITEMS} value={node.each || ""} data-testid="each-limit"
              onChange={(event) => onChange({ ...node, each: Number(event.target.value) }, "each-limit")} /></label>
        ) : null}
        <small>{node.each !== null ? tr("workflows.each_rule") : tr("workflows.copies_hint")}</small></div>
      <div className="wf-field wide"><span>{tr("workflows.delegation")}</span>
        <Segmented label={tr("workflows.delegation")} value={node.delegation} onChange={(delegation) => onChange({ ...node, delegation }, "delegation")}
          options={[["default", tr("workflows.delegation_default")], ["on", tr("workflows.delegation_on")], ["off", tr("workflows.delegation_off")]]} />
        <small>{tr("workflows.delegation_hint")}</small></div>
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented-control wf-segmented" role="group" aria-label={label}>
      {options.map(([option, text]) => (
        <button type="button" key={option} className={option === value ? "active" : ""} aria-pressed={option === value}
          onClick={() => onChange(option)}>{text}</button>
      ))}
    </div>
  );
}
