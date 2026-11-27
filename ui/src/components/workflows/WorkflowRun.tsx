import { t as tr } from "../../../electron/i18n.mjs";
import { ChevronDown, CircleAlert, PanelRight, Pencil, Repeat, RotateCcw, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cleoClient } from "../../services/cleoClient";
import type { TimelineItem } from "../../types";
import type { WorkflowHarness, WorkflowNode, WorkflowRun, WorkflowSession } from "../../workflow-types";
import { duration } from "../Timing";
import { StatusMark, WorkflowCanvas, nodeStatus, statusLabel, type CanvasSelection } from "./WorkflowCanvas";
import { runStatusLabel, runtimeLabel, tokenCount } from "./workflow-labels";
import { layers } from "./workflow-model";
import "./workflows.css";

/** The workflow run a conversation shows in its details panel: the latest one in its timeline. */
export function latestWorkflowRun(items: readonly TimelineItem[] | undefined): WorkflowRun | null {
  const item = items?.findLast((entry) => entry.type === "workflow");
  return item?.type === "workflow" ? item.run : null;
}

/** A clock that ticks only while something is running, for live durations. */
function useNow(ticking: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}

/** Purpose: A workflow run where it happened, in the conversation: one quiet line per run, with a
 * mark per node. The graph and what each node did are in the details panel. */
export function WorkflowRunCard({ run, onOpen, onRetry }: {
  run: WorkflowRun;
  /** Show the run's graph in the details panel. */
  onOpen?: () => void;
  /** Resume from the nodes that did not finish; absent while another run is going. */
  onRetry?: () => void;
}) {
  const now = useNow(run.status === "running");
  const nodes = useMemo(() => layers(run.definition).flat(), [run.definition]);
  const finished = nodes.filter((node) => nodeStatus(run, node) === "done").length;
  return (
    <section className="wf-run-card" data-testid="workflow-run-card" data-status={run.status} aria-label={run.definition.name}>
      <header>
        <Workflow size={15} />
        <strong>{run.definition.name}</strong>
        <span className="wf-run-status" data-status={run.status} data-testid="workflow-run-status">{runStatusLabel(run.status)}</span>
        <small>{finished}/{nodes.length} · {duration((run.finishedAt ?? now) - run.startedAt)}</small>
        {onOpen ? (
          <button type="button" className="icon-button" onClick={onOpen} data-testid="workflow-run-open"
            aria-label={tr("workflows.show_graph")} title={tr("workflows.show_graph")}><PanelRight size={15} /></button>
        ) : null}
      </header>
      <ol className="wf-run-strip">
        {nodes.map((node) => {
          const status = nodeStatus(run, node);
          return <li key={node.id} data-status={status} title={`${node.role} · ${statusLabel(status)}`}><StatusMark status={status} /><span>{node.role}</span></li>;
        })}
      </ol>
      {run.status === "failed" ? (
        <p className="wf-run-error" role="alert" data-testid="workflow-failure">
          <CircleAlert size={14} /><span>{run.error}</span>
          {onRetry ? <button type="button" className="wf-button" onClick={onRetry} data-testid="workflow-retry"><RotateCcw size={13} />{tr("workflows.retry_failed")}</button> : null}
        </p>
      ) : null}
    </section>
  );
}

/** Purpose: The run beside its conversation: the graph with every node's state, and for the node
 * the user picks, what it was told to do and what it did. */
export function WorkflowRunPanel({ run }: { run: WorkflowRun }) {
  const [selection, setSelection] = useState<CanvasSelection>(null);
  const [harnesses, setHarnesses] = useState<WorkflowHarness[]>([]);
  const now = useNow(run.status === "running");
  useEffect(() => {
    let current = true;
    void cleoClient.workflows?.library().then((library) => { if (current) setHarnesses(library.harnesses); }).catch(() => {});
    return () => { current = false; };
  }, []);
  // A new run starts with nothing picked.
  useEffect(() => { setSelection(null); }, [run.id]);
  const node = selection?.kind === "node" ? run.definition.nodes.find((item) => item.id === selection.id) : undefined;
  const tokens = run.sessions.reduce((total, session) => total + (session.tokens ?? 0), 0);
  const finished = run.definition.nodes.filter((item) => nodeStatus(run, item) === "done").length;
  return (
    <div className="wf-run-panel" data-testid="workflow-run-panel" data-status={run.status}>
      <div className="wf-run-panel-graph">
        <WorkflowCanvas definition={run.definition} harnesses={harnesses} run={run} selection={selection} onSelect={setSelection} />
      </div>
      <div className="wf-run-panel-detail">
        {node ? <NodeRun node={node} run={run} harnesses={harnesses} now={now} /> : (
          <>
            <header><strong>{run.definition.name}</strong><span className="wf-run-status" data-status={run.status}>{runStatusLabel(run.status)}</span></header>
            <dl className="wf-run-facts">
              <div><dt>{tr("workflows.fact_nodes")}</dt><dd>{finished} / {run.definition.nodes.length}</dd></div>
              <div><dt>{tr("workflows.fact_elapsed")}</dt><dd>{duration((run.finishedAt ?? now) - run.startedAt)}</dd></div>
              <div><dt>{tr("workflows.fact_agents")}</dt><dd>{run.sessions.length}</dd></div>
              <div><dt>{tr("workflows.fact_tokens")}</dt><dd>{tokens ? tokenCount(tokens) : "—"}</dd></div>
            </dl>
            <p className="wf-run-task">{run.task}</p>
            {run.status === "failed" ? <p className="wf-run-error"><CircleAlert size={14} /><span>{run.error}</span></p> : null}
            {run.result ? <pre className="wf-run-output">{run.result}</pre> : <p className="wf-rule">{tr("workflows.pick_node")}</p>}
          </>
        )}
      </div>
    </div>
  );
}

/** One node of a run: what it was set to, then each session it ran, newest last. */
function NodeRun({ node, run, harnesses, now }: { node: WorkflowNode; run: WorkflowRun; harnesses: readonly WorkflowHarness[]; now: number }) {
  const sessions = run.sessions.filter((session) => session.nodeId === node.id);
  const status = nodeStatus(run, node);
  return (
    <div data-testid="workflow-node-run">
      <header>
        <StatusMark status={status} />
        <strong>{node.role}</strong>
        <span className="wf-run-status" data-status={status}>{statusLabel(status)}</span>
      </header>
      <p className="wf-node-runtime">
        {runtimeLabel(node, harnesses)}
        {node.access === "write" ? <em title={tr("workflows.limit_write")}><Pencil size={11} /></em> : null}
        {node.each !== null ? <em title={tr("workflows.each_mark", { p0: node.each })}>×{node.each}</em> : null}
        {run.definition.edges.some((edge) => edge.loop && edge.from === node.id) ? <em title={tr("workflows.judge")}><Repeat size={11} /></em> : null}
      </p>
      <details className="wf-node-brief">
        <summary>{tr("workflows.instructions")}<ChevronDown size={13} className="wf-chevron" /></summary>
        <pre>{node.instructions}</pre>
      </details>
      {sessions.length ? sessions.map((session) => <SessionEntry key={session.id} session={session} now={now} />)
        : <p className="wf-rule">{tr("workflows.node_not_started")}</p>}
    </div>
  );
}

function SessionEntry({ session, now }: { session: WorkflowSession; now: number }) {
  const elapsed = session.elapsedMs ?? (session.startedAt ? Math.max(0, now - session.startedAt) : 0);
  return (
    <article className="wf-session" data-status={session.status} data-testid="workflow-session">
      <header>
        <StatusMark status={session.status} />
        {session.round ? <em>{tr("workflows.round_value", { p0: session.round })}</em> : null}
        {session.verdict ? <em className={`verdict ${session.verdict}`}>{session.verdict === "pass" ? tr("workflows.verdict_pass") : tr("workflows.verdict_revise")}</em> : null}
        {session.item ? <span className="wf-session-item" title={session.item}>{session.item}</span> : null}
        <small>{[duration(elapsed), session.tokens ? `${tokenCount(session.tokens)} tokens` : ""].filter(Boolean).join(" · ")}</small>
      </header>
      {session.error ? <pre className="wf-run-output error">{session.error}</pre>
        : session.output ? <pre className="wf-run-output">{session.output}</pre>
        : <p className="wf-rule">{tr("workflows.node_working")}</p>}
    </article>
  );
}
