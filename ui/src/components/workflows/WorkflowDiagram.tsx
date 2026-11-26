import { t as tr } from "../../../electron/i18n.mjs";
import { Ban, Check, CircleAlert, LoaderCircle, Repeat, Split } from "lucide-react";
import { Fragment } from "react";
import type {
  WorkflowAgentStep,
  WorkflowDefinition,
  WorkflowExecutor,
  WorkflowNodeRun,
  WorkflowNodeStatus,
  WorkflowRun,
} from "../../workflow-types";
import { executorLabel } from "./workflow-labels";

interface WorkflowDiagramProps {
  definition: WorkflowDefinition;
  executors: readonly WorkflowExecutor[];
  /** With a run, every node shows where that run is. */
  run?: WorkflowRun | null;
  selectedStepId?: string | null;
  onSelectStep?: (stepId: string) => void;
}

/** Purpose: The workflow as a picture: the sequence top to bottom, a parallel group side by side,
 * a loop as a frame around what repeats. It is read-only; structure is edited in the step list. */
export function WorkflowDiagram({ definition, executors, run, selectedStepId, onSelectStep }: WorkflowDiagramProps) {
  const phaseOf = (stepId: string) => run?.phases.find((phase) => phase.stepId === stepId);
  /** The latest session a step started in this run (a loop step has one per round). */
  const latest = (stepId: string, nodeId: string): WorkflowNodeRun | undefined =>
    phaseOf(stepId)?.nodes.filter((node) => node.stepId === nodeId).at(-1);
  // A group is selected as a whole (its frame); only a step that is one agent highlights its node.
  const node = (stepId: string, agent: WorkflowAgentStep, state?: WorkflowNodeRun, caption?: string) => (
    <DiagramNode key={state?.id ?? agent.id} role={state?.item ?? agent.role}
      detail={caption ?? executorLabel(agent.executorId, executors)} status={run ? state?.status ?? "pending" : undefined}
      selected={selectedStepId === stepId && stepId === agent.id} onClick={onSelectStep ? () => onSelectStep(stepId) : undefined} />
  );

  if (!definition.steps.length) return <div className="wf-diagram wf-diagram-empty">{tr("workflows.diagram_empty")}</div>;
  return (
    <div className="wf-diagram" data-testid="workflow-diagram" aria-label={tr("workflows.diagram")}>
      <span className="wf-terminal">{tr("workflows.diagram_task")}</span>
      {definition.steps.map((step) => {
        const phase = phaseOf(step.id);
        return (
          <Fragment key={step.id}>
            <span className="wf-edge" aria-hidden="true" />
            {step.kind === "agent" ? node(step.id, step, latest(step.id, step.id)) : step.kind === "parallel" ? (
              <div className={`wf-group parallel ${selectedStepId === step.id ? "selected" : ""}`} data-status={phase?.status}>
                <span className="wf-group-tag"><Split size={11} />
                  {step.fanOut === "each" ? tr("workflows.diagram_each", { p0: step.maxItems }) : tr("workflows.parallel")}
                </span>
                <div className="wf-branches">
                  {step.fanOut === "each"
                    // Before a run there is one template; a run shows the copy started for each item.
                    ? phase?.nodes.length ? phase.nodes.map((state) => node(step.id, step.branches[0], state, state.role))
                      : step.branches.slice(0, 1).map((agent) => <div className="wf-stack" key={agent.id}>{node(step.id, agent)}</div>)
                    : step.branches.map((agent) => node(step.id, agent, latest(step.id, agent.id)))}
                </div>
              </div>
            ) : (
              <div className={`wf-group loop ${selectedStepId === step.id ? "selected" : ""}`} data-status={phase?.status}>
                <span className="wf-group-tag"><Repeat size={11} />
                  {phase?.round ? tr("workflows.round_of", { p0: phase.round, p1: step.maxRounds }) : tr("workflows.diagram_rounds", { p0: step.maxRounds })}
                </span>
                {step.body.map((agent, index) => (
                  <Fragment key={agent.id}>
                    {index ? <span className="wf-edge short" aria-hidden="true" /> : null}
                    {node(step.id, agent, latest(step.id, agent.id),
                      agent.id === step.judgeId ? `${executorLabel(agent.executorId, executors)} · ${tr("workflows.judge")}` : undefined)}
                  </Fragment>
                ))}
              </div>
            )}
          </Fragment>
        );
      })}
      <span className="wf-edge" aria-hidden="true" />
      <span className="wf-terminal">{tr("workflows.diagram_result")}</span>
    </div>
  );
}

function DiagramNode({ role, detail, status, selected, onClick }: {
  role: string;
  detail: string;
  status?: WorkflowNodeStatus;
  selected: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="wf-node-copy">
        <strong>{role || tr("workflows.unnamed_role")}</strong>
        <small>{detail}</small>
      </span>
      {status ? <StatusMark status={status} /> : null}
    </>
  );
  return onClick
    ? <button type="button" className={`wf-node ${selected ? "selected" : ""}`} data-status={status} onClick={onClick}>{body}</button>
    : <div className="wf-node" data-status={status}>{body}</div>;
}

export function StatusMark({ status }: { status: WorkflowNodeStatus }) {
  const label = statusLabel(status);
  return (
    <span className="wf-status-mark" data-status={status} title={label} aria-label={label} role="img">
      {status === "running" ? <LoaderCircle size={13} className="spin" />
        : status === "done" ? <Check size={13} />
        : status === "failed" ? <CircleAlert size={13} />
        : status === "cancelled" ? <Ban size={12} /> : <span className="wf-status-dot" />}
    </span>
  );
}

export function statusLabel(status: WorkflowNodeStatus) {
  return status === "running" ? tr("workflows.status_running")
    : status === "done" ? tr("workflows.status_done")
    : status === "failed" ? tr("workflows.status_failed")
    : status === "cancelled" ? tr("workflows.status_cancelled") : tr("workflows.status_pending");
}
