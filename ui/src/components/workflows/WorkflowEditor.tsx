import { t as tr } from "../../../electron/i18n.mjs";
import { ArrowDown, ArrowLeft, ArrowUp, Bot, Check, ChevronDown, CircleAlert, LoaderCircle, Play, Plus, Repeat, Sparkles, Split, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { effortLabels } from "../../runtime-labels";
import type {
  WorkflowAgentStep,
  WorkflowDefinition,
  WorkflowExecutor,
  WorkflowLoopStep,
  WorkflowParallelStep,
  WorkflowStep,
} from "../../workflow-types";
import { WorkflowDiagram } from "./WorkflowDiagram";
import { executorLabel, issueText } from "./workflow-labels";
import { MAX_ITEMS, MAX_ROUNDS, agentBound, moveStep, newAgent, newLoop, newParallel, workflowIssues } from "./workflow-model";

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
}

/** Purpose: Edit one workflow as an ordered list of steps. The list is the structure: a step is
 * one agent, a parallel group or a bounded loop, and nothing else can be drawn. */
export function WorkflowEditor({ definition, onChange, executors, saved, dirty, saving, error, onSave, onRun, onBack }: WorkflowEditorProps) {
  const [openStepId, setOpenStepId] = useState<string | null>(definition.steps[0]?.id ?? null);
  const [openNodeId, setOpenNodeId] = useState<string | null>(null);
  const issues = useMemo(() => workflowIssues(definition, executors), [definition, executors]);
  const bound = agentBound(definition);
  const setSteps = (steps: WorkflowStep[]) => onChange({ ...definition, steps });
  const replaceStep = (step: WorkflowStep) => setSteps(definition.steps.map((item) => item.id === step.id ? step : item));
  const addStep = (step: WorkflowStep) => {
    setSteps([...definition.steps, step]);
    setOpenStepId(step.id);
    setOpenNodeId(step.kind === "agent" ? null : (step.kind === "parallel" ? step.branches : step.body)[0]?.id ?? null);
  };
  const reveal = (stepId: string | null, nodeId?: string) => {
    if (!stepId) { document.querySelector<HTMLInputElement>(".wf-name-input")?.focus(); return; }
    setOpenStepId(stepId);
    if (nodeId) setOpenNodeId(nodeId);
    requestAnimationFrame(() => document.querySelector(`[data-step-id="${stepId}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };
  const runBlocked = issues.length ? tr("workflows.fix_issues_first") : undefined;

  return (
    <div className="wf-editor" data-testid="workflow-editor">
      <header className="wf-page-header">
        <button type="button" className="wf-back" onClick={onBack}><ArrowLeft size={15} />{tr("workflows.title")}</button>
        <div className="wf-header-actions">
          {error ? <span className="wf-inline-error" role="alert">{error}</span>
            : dirty ? <span className="wf-state-note">{saved ? tr("workflows.unsaved_changes") : tr("workflows.not_saved")}</span>
            : <span className="wf-state-note saved"><Check size={13} />{tr("workflows.saved")}</span>}
          <button type="button" className="wf-button" disabled={!dirty || saving || !definition.name.trim()}
            title={definition.name.trim() ? undefined : tr("workflows.issue_name_missing")} onClick={onSave} data-testid="workflow-save">
            {saving ? <LoaderCircle size={14} className="spin" /> : null}{tr("workflows.save")}
          </button>
          <button type="button" className="wf-button primary" disabled={issues.length > 0} title={runBlocked} onClick={onRun} data-testid="workflow-run">
            <Play size={14} />{tr("workflows.run")}
          </button>
        </div>
      </header>

      <div className="wf-editor-body">
        <section className="wf-editor-main">
          <input className="wf-name-input" value={definition.name} maxLength={60} placeholder={tr("workflows.name_placeholder")}
            aria-label={tr("workflows.name")} onChange={(event) => onChange({ ...definition, name: event.target.value })} />
          <textarea className="wf-description-input" rows={1} value={definition.description} maxLength={200} placeholder={tr("workflows.description_placeholder")}
            aria-label={tr("workflows.description")} onChange={(event) => onChange({ ...definition, description: event.target.value.replace(/\n/g, " ") })} />
          {definition.origin === "drafted" && !saved ? (
            <p className="wf-draft-note"><Sparkles size={14} /><span>{tr("workflows.drafted_note")}</span></p>
          ) : null}

          {definition.steps.length ? (
            <ol className="wf-steps">
              {definition.steps.map((step, index) => (
                <li key={step.id} data-step-id={step.id}>
                  <StepCard step={step} index={index} count={definition.steps.length} executors={executors}
                    open={openStepId === step.id} onToggle={() => setOpenStepId((current) => current === step.id ? null : step.id)}
                    openNodeId={openNodeId} onOpenNode={setOpenNodeId}
                    onChange={replaceStep}
                    onMove={(offset) => setSteps(moveStep(definition.steps, index, offset))}
                    onRemove={() => { setSteps(definition.steps.filter((item) => item.id !== step.id)); if (openStepId === step.id) setOpenStepId(null); }} />
                </li>
              ))}
            </ol>
          ) : (
            <div className="wf-empty compact"><strong>{tr("workflows.no_steps_title")}</strong><span>{tr("workflows.no_steps_hint")}</span></div>
          )}

          <div className="wf-add-step" role="group" aria-label={tr("workflows.add_step")}>
            <span>{tr("workflows.add_step")}</span>
            <button type="button" onClick={() => addStep(newAgent())} data-testid="add-agent-step"><Bot size={14} />{tr("workflows.kind_agent")}</button>
            <button type="button" onClick={() => addStep(newParallel(tr("workflows.parallel")))} data-testid="add-parallel-step"><Split size={14} />{tr("workflows.parallel")}</button>
            <button type="button" onClick={() => addStep(newLoop(tr("workflows.loop")))} data-testid="add-loop-step"><Repeat size={14} />{tr("workflows.loop")}</button>
          </div>
        </section>

        <aside className="wf-editor-side" aria-label={tr("workflows.diagram")}>
          <h3>{tr("workflows.diagram")}</h3>
          <WorkflowDiagram definition={definition} executors={executors} selectedStepId={openStepId} onSelectStep={(stepId) => reveal(stepId)} />
          <div className="wf-checks" data-testid="workflow-checks">
            {issues.length ? (
              <>
                <strong><CircleAlert size={14} />{tr("workflows.issues_title", { p0: issues.length })}</strong>
                <ul>
                  {issues.map((issue, index) => (
                    <li key={`${issue.code}-${issue.nodeId ?? issue.stepId ?? index}`}>
                      <button type="button" onClick={() => reveal(issue.stepId, issue.nodeId)}>{issueText(issue)}</button>
                    </li>
                  ))}
                </ul>
              </>
            ) : <p className="wf-ready"><Check size={14} />{tr("workflows.ready", { p0: bound })}</p>}
          </div>
        </aside>
      </div>
    </div>
  );
}

function StepCard({ step, index, count, executors, open, onToggle, openNodeId, onOpenNode, onChange, onMove, onRemove }: {
  step: WorkflowStep;
  index: number;
  count: number;
  executors: readonly WorkflowExecutor[];
  open: boolean;
  onToggle: () => void;
  openNodeId: string | null;
  onOpenNode: (nodeId: string | null) => void;
  onChange: (step: WorkflowStep) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}) {
  const Icon = step.kind === "agent" ? Bot : step.kind === "parallel" ? Split : Repeat;
  const title = step.kind === "agent" ? step.role || tr("workflows.unnamed_role") : step.label || (step.kind === "parallel" ? tr("workflows.parallel") : tr("workflows.loop"));
  const summary = step.kind === "agent"
    ? `${executorLabel(step.executorId, executors)} · ${step.access === "write" ? tr("workflows.access_write") : tr("workflows.access_read")}`
    : step.kind === "parallel"
      ? step.fanOut === "each" ? tr("workflows.summary_each", { p0: step.maxItems }) : tr("workflows.summary_branches", { p0: step.branches.length })
      : tr("workflows.summary_loop", { p0: step.maxRounds, p1: step.body.find((node) => node.id === step.judgeId)?.role || tr("workflows.unnamed_role") });
  return (
    <article className={`wf-step ${open ? "open" : ""}`} data-kind={step.kind}>
      <div className="wf-step-header">
        <button type="button" className="wf-step-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="wf-step-index">{index + 1}</span>
          <Icon size={15} />
          <span className="wf-step-title"><strong>{title}</strong><small>{summary}</small></span>
          <ChevronDown size={15} className="wf-chevron" />
        </button>
        <div className="wf-step-actions">
          <button type="button" className="icon-button" disabled={index === 0} onClick={() => onMove(-1)}
            aria-label={tr("workflows.move_up_value", { p0: title })} title={tr("workflows.move_up")}><ArrowUp size={14} /></button>
          <button type="button" className="icon-button" disabled={index === count - 1} onClick={() => onMove(1)}
            aria-label={tr("workflows.move_down_value", { p0: title })} title={tr("workflows.move_down")}><ArrowDown size={14} /></button>
          <button type="button" className="icon-button" onClick={onRemove}
            aria-label={tr("workflows.remove_value", { p0: title })} title={tr("workflows.remove_step")}><Trash2 size={14} /></button>
        </div>
      </div>
      {open ? (
        <div className="wf-step-body">
          {step.kind === "agent" ? <AgentFields node={step} executors={executors} onChange={onChange} />
            : step.kind === "parallel" ? <ParallelFields step={step} executors={executors} onChange={onChange} openNodeId={openNodeId} onOpenNode={onOpenNode} />
            : <LoopFields step={step} executors={executors} onChange={onChange} openNodeId={openNodeId} onOpenNode={onOpenNode} />}
        </div>
      ) : null}
    </article>
  );
}

function ParallelFields({ step, executors, onChange, openNodeId, onOpenNode }: {
  step: WorkflowParallelStep;
  executors: readonly WorkflowExecutor[];
  onChange: (step: WorkflowParallelStep) => void;
  openNodeId: string | null;
  onOpenNode: (nodeId: string | null) => void;
}) {
  const each = step.fanOut === "each";
  return (
    <>
      <div className="wf-fields">
        <label className="wf-field"><span>{tr("workflows.step_name")}</span>
          <input value={step.label} maxLength={40} onChange={(event) => onChange({ ...step, label: event.target.value })} /></label>
        <div className="wf-field"><span>{tr("workflows.fan_out")}</span>
          <Segmented label={tr("workflows.fan_out")} value={step.fanOut} onChange={(fanOut) => onChange({ ...step, fanOut })}
            options={[["branches", tr("workflows.fan_out_branches")], ["each", tr("workflows.fan_out_each")]]} /></div>
        {each ? (
          <label className="wf-field"><span>{tr("workflows.max_items")}</span>
            <input type="number" min={2} max={MAX_ITEMS} value={step.maxItems || ""}
              onChange={(event) => onChange({ ...step, maxItems: Number(event.target.value) })} /></label>
        ) : null}
      </div>
      <p className="wf-rule">{each ? tr("workflows.each_rule") : tr("workflows.branches_rule")}</p>
      <NodeList nodes={each ? step.branches.slice(0, 1) : step.branches} executors={executors} openNodeId={openNodeId} onOpenNode={onOpenNode}
        fixed={each} addLabel={tr("workflows.add_branch")}
        onChange={(branches) => onChange({ ...step, branches: each ? [...branches, ...step.branches.slice(1)] : branches })} />
    </>
  );
}

function LoopFields({ step, executors, onChange, openNodeId, onOpenNode }: {
  step: WorkflowLoopStep;
  executors: readonly WorkflowExecutor[];
  onChange: (step: WorkflowLoopStep) => void;
  openNodeId: string | null;
  onOpenNode: (nodeId: string | null) => void;
}) {
  return (
    <>
      <div className="wf-fields">
        <label className="wf-field"><span>{tr("workflows.step_name")}</span>
          <input value={step.label} maxLength={40} onChange={(event) => onChange({ ...step, label: event.target.value })} /></label>
        <label className="wf-field"><span>{tr("workflows.max_rounds")}</span>
          <input type="number" min={1} max={MAX_ROUNDS} value={step.maxRounds || ""}
            onChange={(event) => onChange({ ...step, maxRounds: Number(event.target.value) })} /></label>
        <label className="wf-field"><span>{tr("workflows.judge_field")}</span>
          <select value={step.judgeId} onChange={(event) => onChange({ ...step, judgeId: event.target.value })}>
            {step.body.some((node) => node.id === step.judgeId) ? null : <option value={step.judgeId}>{tr("workflows.choose_judge")}</option>}
            {step.body.map((node) => <option key={node.id} value={node.id}>{node.role || tr("workflows.unnamed_role")}</option>)}
          </select></label>
        <label className="wf-field"><span>{tr("workflows.on_exhausted")}</span>
          <select value={step.onExhausted} onChange={(event) => onChange({ ...step, onExhausted: event.target.value as WorkflowLoopStep["onExhausted"] })}>
            <option value="stop">{tr("workflows.on_exhausted_stop")}</option>
            <option value="continue">{tr("workflows.on_exhausted_continue")}</option>
          </select></label>
      </div>
      <p className="wf-rule">{tr("workflows.loop_rule")}</p>
      <NodeList nodes={step.body} executors={executors} openNodeId={openNodeId} onOpenNode={onOpenNode} addLabel={tr("workflows.add_loop_node")}
        marked={step.judgeId} onChange={(body) => onChange({ ...step, body,
          // The judge follows its node; when that node is removed the last one judges.
          judgeId: body.some((node) => node.id === step.judgeId) ? step.judgeId : body.at(-1)?.id ?? "" })} />
    </>
  );
}

/** The agents inside a group, each folded to one line until opened. */
function NodeList({ nodes, executors, openNodeId, onOpenNode, onChange, addLabel, fixed = false, marked }: {
  nodes: WorkflowAgentStep[];
  executors: readonly WorkflowExecutor[];
  openNodeId: string | null;
  onOpenNode: (nodeId: string | null) => void;
  onChange: (nodes: WorkflowAgentStep[]) => void;
  addLabel: string;
  /** One template only: nothing to add or remove. */
  fixed?: boolean;
  /** The loop's judge. */
  marked?: string;
}) {
  return (
    <div className="wf-subnodes">
      {nodes.map((node) => {
        const open = openNodeId === node.id;
        const name = node.role || tr("workflows.unnamed_role");
        return (
          <div className={`wf-subnode ${open ? "open" : ""}`} key={node.id} data-node-id={node.id}>
            <div className="wf-subnode-header">
              <button type="button" className="wf-subnode-toggle" aria-expanded={open} onClick={() => onOpenNode(open ? null : node.id)}>
                <Bot size={14} />
                <strong>{name}</strong>
                {marked === node.id ? <em>{tr("workflows.judge")}</em> : null}
                <small>{executorLabel(node.executorId, executors)}</small>
                <ChevronDown size={14} className="wf-chevron" />
              </button>
              {fixed ? null : (
                <button type="button" className="icon-button" onClick={() => onChange(nodes.filter((item) => item.id !== node.id))}
                  aria-label={tr("workflows.remove_value", { p0: name })} title={tr("workflows.remove_node")}><Trash2 size={13} /></button>
              )}
            </div>
            {open ? <AgentFields node={node} executors={executors} onChange={(next) => onChange(nodes.map((item) => item.id === next.id ? next : item))} /> : null}
          </div>
        );
      })}
      {fixed ? null : (
        <button type="button" className="wf-add-sub" onClick={() => { const node = newAgent(); onChange([...nodes, node]); onOpenNode(node.id); }}>
          <Plus size={13} />{addLabel}
        </button>
      )}
    </div>
  );
}

function AgentFields({ node, executors, onChange }: {
  node: WorkflowAgentStep;
  executors: readonly WorkflowExecutor[];
  onChange: (node: WorkflowAgentStep) => void;
}) {
  const groups = useMemo(() => {
    const byHarness = new Map<string, WorkflowExecutor[]>();
    for (const executor of executors) byHarness.set(executor.harness, [...byHarness.get(executor.harness) ?? [], executor]);
    return [...byHarness];
  }, [executors]);
  const known = node.executorId === null || executors.some((executor) => executor.id === node.executorId);
  return (
    <div className="wf-fields">
      <label className="wf-field"><span>{tr("workflows.role")}</span>
        <input value={node.role} maxLength={24} placeholder={tr("workflows.role_placeholder")}
          onChange={(event) => onChange({ ...node, role: event.target.value })} /></label>
      <label className="wf-field"><span>{tr("workflows.executor")}</span>
        <select value={node.executorId ?? ""} onChange={(event) => onChange({ ...node, executorId: event.target.value || null })}>
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
        <textarea rows={3} value={node.instructions} maxLength={2000} placeholder={tr("workflows.instructions_placeholder")}
          onChange={(event) => onChange({ ...node, instructions: event.target.value })} />
        <small>{tr("workflows.instructions_hint")}</small></label>
      <div className="wf-field"><span>{tr("workflows.access")}</span>
        <Segmented label={tr("workflows.access")} value={node.access}
          onChange={(access) => onChange({ ...node, access, workspace: access === "read" ? "shared" : node.workspace })}
          options={[["read", tr("workflows.access_read")], ["write", tr("workflows.access_write")]]} /></div>
      {node.access === "write" ? (
        <div className="wf-field"><span>{tr("workflows.workspace")}</span>
          <Segmented label={tr("workflows.workspace")} value={node.workspace} onChange={(workspace) => onChange({ ...node, workspace })}
            options={[["shared", tr("workflows.workspace_shared")], ["worktree", tr("workflows.workspace_worktree")]]} /></div>
      ) : null}
      <div className="wf-field wide"><span>{tr("workflows.delegation")}</span>
        <Segmented label={tr("workflows.delegation")} value={node.delegation} onChange={(delegation) => onChange({ ...node, delegation })}
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
