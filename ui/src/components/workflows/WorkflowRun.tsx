import { t as tr } from "../../../electron/i18n.mjs";
import { ArrowLeft, Check, ChevronDown, CircleAlert, Copy, LoaderCircle, Play, RotateCcw, Sparkles, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { projectLabel } from "../../runtime-labels";
import type { Project } from "../../types";
import type { WorkflowClient, WorkflowDefinition, WorkflowExecutor, WorkflowRun, WorkflowSession } from "../../workflow-types";
import { duration } from "../Timing";
import { StatusMark, WorkflowCanvas, nodeStatus, type CanvasSelection } from "./WorkflowCanvas";
import { ago, executorLabel, runStatusLabel, tokenCount } from "./workflow-labels";
import { agentBound, layers } from "./workflow-model";

/** Purpose: The last look before agents start: what will run, on which models, with what access.
 * A workflow Cleo drafted is only ever started from here, by the user. */
export function WorkflowLaunch({ definition, reviewDraft, executors, projects, task, onTaskChange, projectId, onProjectChange, starting, error, onStart, onBack }: {
  definition: WorkflowDefinition;
  /** Cleo wrote it and nobody has saved it: the user is approving a proposal. */
  reviewDraft: boolean;
  executors: readonly WorkflowExecutor[];
  projects: Project[];
  task: string;
  onTaskChange: (task: string) => void;
  projectId: string;
  onProjectChange: (projectId: string) => void;
  starting: boolean;
  error: string | null;
  onStart: () => void;
  onBack: () => void;
}) {
  const [attempted, setAttempted] = useState(false);
  const [selection, setSelection] = useState<CanvasSelection>(null);
  const nodes = useMemo(() => layers(definition).flat(), [definition]);
  const writers = nodes.filter((node) => node.access === "write").length;
  const taskMissing = !task.trim();
  const start = () => {
    setAttempted(true);
    if (!taskMissing && !starting) onStart();
  };
  return (
    <div className="wf-launch" data-testid="workflow-launch">
      <header className="wf-page-header">
        <button type="button" className="wf-back" onClick={onBack}><ArrowLeft size={15} />{tr("workflows.back")}</button>
      </header>
      <h2>{tr("workflows.launch_title", { p0: definition.name })}</h2>
      {definition.description ? <p className="wf-lede">{definition.description}</p> : null}
      {reviewDraft ? <p className="wf-draft-note"><Sparkles size={14} /><span>{tr("workflows.launch_drafted_note")}</span></p> : null}

      <div className="wf-launch-body">
      <div className="wf-launch-form">
        <label className="wf-field wide"><span>{tr("workflows.task")}</span>
          <textarea rows={4} value={task} maxLength={4000} placeholder={tr("workflows.task_placeholder")} autoFocus
            aria-invalid={attempted && taskMissing} data-testid="workflow-task"
            onChange={(event) => onTaskChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); start(); } }} />
          {attempted && taskMissing ? <small className="wf-field-error" role="alert">{tr("workflows.task_required")}</small> : null}
        </label>
        <label className="wf-field wide"><span>{tr("workflows.project")}</span>
          <select value={projectId} onChange={(event) => onProjectChange(event.target.value)}>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{projectLabel(project) || tr("workflows.no_folder")}</option>
            ))}
          </select>
        </label>

        <h3>{tr("workflows.plan")}</h3>
        <div className="wf-plan" role="table" aria-label={tr("workflows.plan")}>
          <div className="wf-plan-row head" role="row">
            <span role="columnheader">{tr("workflows.role")}</span><span role="columnheader">{tr("workflows.executor")}</span>
            <span role="columnheader">{tr("workflows.access")}</span><span role="columnheader">{tr("workflows.workspace")}</span>
          </div>
          {nodes.map((node) => (
            <div className={`wf-plan-row ${selection?.id === node.id ? "selected" : ""}`} role="row" key={node.id}>
              <strong role="cell">{node.role}{node.each !== null ? ` ×${node.each}` : ""}</strong>
              <span role="cell">{executorLabel(node.executorId, executors)}</span>
              <span role="cell" className={node.access === "write" ? "wf-write" : ""}>{node.access === "write" ? tr("workflows.access_write") : tr("workflows.access_read")}</span>
              <span role="cell">{node.access === "read" ? "—" : node.workspace === "worktree" ? tr("workflows.workspace_worktree") : tr("workflows.workspace_shared")}</span>
            </div>
          ))}
        </div>
        <p className="wf-rule">{tr("workflows.plan_summary", { p0: agentBound(definition), p1: writers })}</p>

        {error ? <p className="wf-inline-error" role="alert">{error}</p> : null}
        <div className="wf-launch-actions">
          <button type="button" className="wf-button primary" onClick={start} disabled={starting} aria-busy={starting} data-testid="workflow-start">
            {starting ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />}{tr("workflows.approve_and_run")}
          </button>
          <button type="button" className="wf-button" onClick={onBack} disabled={starting}>{tr("workflows.back_to_edit")}</button>
        </div>
      </div>
      <div className="wf-canvas-frame">
        <WorkflowCanvas definition={definition} executors={executors} selection={selection} onSelect={setSelection} />
      </div>
      </div>
    </div>
  );
}

/** Follows one run from the client until it stops; `nonce` restarts the watch after a retry. */
function useWorkflowRun(client: WorkflowClient, runId: string, nonce: number) {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const stream = client.watch(runId);
    void (async () => {
      try {
        for await (const snapshot of stream) {
          if (!active) return;
          setRun(snapshot);
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => { active = false; void stream.return(undefined); };
  }, [client, runId, nonce]);
  return { run, error };
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

/** Purpose: One run as it happens: the graph with every node's state, and each agent session in
 * the order it started. The run belongs to the orchestrator; this view watches, stops and retries it. */
export function WorkflowRunView({ client, runId, executors, projects, saved, onBack, onRunAgain, onSaveDefinition, onSettled, onCopy }: {
  client: WorkflowClient;
  runId: string;
  executors: readonly WorkflowExecutor[];
  projects: Project[];
  /** The definition that ran is in the library. */
  saved: (definition: WorkflowDefinition) => boolean;
  onBack: () => void;
  onRunAgain: (run: WorkflowRun) => void;
  onSaveDefinition: (definition: WorkflowDefinition) => Promise<void>;
  /** The run stopped (finished, failed or was cancelled). */
  onSettled: () => void;
  onCopy: (text: string) => void;
}) {
  const [nonce, setNonce] = useState(0);
  const { run, error } = useWorkflowRun(client, runId, nonce);
  const [stopping, setStopping] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [openSessions, setOpenSessions] = useState<string[]>([]);
  const [selection, setSelection] = useState<CanvasSelection>(null);
  const list = useRef<HTMLDivElement>(null);
  const running = run?.status === "running";
  const now = useNow(Boolean(running));
  useEffect(() => {
    if (run && run.status !== "running") { setStopping(false); setRetrying(false); onSettled(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.status]);
  // Picking a node on the graph brings its latest session into view.
  const selectedNode = selection?.kind === "node" ? selection.id : null;
  useEffect(() => {
    if (!selectedNode) return;
    const cards = list.current?.querySelectorAll(`[data-node="${CSS.escape(selectedNode)}"]`);
    cards?.[cards.length - 1]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedNode]);

  if (error) return <div className="wf-run"><p className="wf-inline-error" role="alert">{error}</p><button type="button" className="wf-button" onClick={onBack}>{tr("workflows.back")}</button></div>;
  if (!run) return <div className="wf-run wf-loading" role="status"><LoaderCircle size={16} className="spin" />{tr("overlays.loading")}</div>;

  const project = projects.find((item) => item.id === run.projectId);
  const tokens = run.sessions.reduce((total, session) => total + (session.tokens ?? 0), 0);
  const elapsed = (run.finishedAt ?? now) - run.startedAt;
  const finished = run.definition.nodes.filter((node) => nodeStatus(run, node) === "done").length;
  const inLoop = new Set(run.sessions.filter((session) => session.round !== undefined).map((session) => session.nodeId));
  const unsaved = !saved(run.definition);
  const toggle = (id: string) => setOpenSessions((open) => open.includes(id) ? open.filter((item) => item !== id) : [...open, id]);

  return (
    <div className="wf-run" data-testid="workflow-run-view" data-status={run.status}>
      <header className="wf-page-header">
        <button type="button" className="wf-back" onClick={onBack}><ArrowLeft size={15} />{tr("workflows.title")}</button>
        <div className="wf-header-actions">
          {running ? (
            <button type="button" className="wf-button danger" disabled={stopping} data-testid="workflow-stop"
              onClick={() => { setStopping(true); void client.cancel(run.id); }}>
              {stopping ? <LoaderCircle size={14} className="spin" /> : <Square size={13} />}{stopping ? tr("workflows.stopping") : tr("workflows.stop")}
            </button>
          ) : (
            <>
              {unsaved ? (
                <button type="button" className="wf-button" disabled={saving} data-testid="workflow-save-run"
                  onClick={() => { setSaving(true); void onSaveDefinition(run.definition).finally(() => setSaving(false)); }}>
                  {saving ? <LoaderCircle size={14} className="spin" /> : null}{tr("workflows.save_as_workflow")}
                </button>
              ) : null}
              <button type="button" className="wf-button" onClick={() => onRunAgain(run)} data-testid="workflow-run-again">
                <RotateCcw size={14} />{tr("workflows.run_again")}
              </button>
            </>
          )}
        </div>
      </header>

      <div className="wf-run-heading">
        <div>
          <h2>{run.definition.name}</h2>
          <p className="wf-run-task">{run.task}</p>
        </div>
        <dl className="wf-run-facts">
          <div><dt>{tr("workflows.fact_status")}</dt>
            <dd className="wf-run-status" data-status={run.status} data-testid="workflow-run-status">
              {running ? <LoaderCircle size={13} className="spin" /> : null}{runStatusLabel(run.status)}
            </dd></div>
          <div><dt>{tr("workflows.fact_nodes")}</dt><dd>{finished} / {run.definition.nodes.length}</dd></div>
          <div><dt>{tr("workflows.fact_elapsed")}</dt><dd>{duration(elapsed)}</dd></div>
          <div><dt>{tr("workflows.fact_agents")}</dt><dd>{run.sessions.length}</dd></div>
          <div><dt>{tr("workflows.fact_tokens")}</dt><dd>{tokens ? tokenCount(tokens) : "—"}</dd></div>
          <div><dt>{tr("workflows.project")}</dt><dd>{projectLabel(project) || tr("workflows.no_folder")}</dd></div>
        </dl>
      </div>

      {run.status === "failed" ? (
        <div className="wf-banner failed" role="alert" data-testid="workflow-failure">
          <CircleAlert size={16} />
          <div><strong>{tr("workflows.failed_title")}</strong><span>{run.error}</span></div>
          <button type="button" className="wf-button" disabled={retrying} data-testid="workflow-retry"
            onClick={() => { setRetrying(true); void client.retry(run.id).then(() => setNonce((value) => value + 1)); }}>
            {retrying ? <LoaderCircle size={14} className="spin" /> : <RotateCcw size={14} />}{tr("workflows.retry_failed")}
          </button>
        </div>
      ) : null}
      {run.status === "cancelled" ? (
        <div className="wf-banner" role="status"><Square size={14} /><div><strong>{tr("workflows.stopped_title")}</strong>
          <span>{tr("workflows.stopped_detail", { p0: finished, p1: run.definition.nodes.length })}</span></div></div>
      ) : null}
      {run.status === "completed" && run.result ? (
        <section className="wf-result" data-testid="workflow-result" aria-label={tr("workflows.result")}>
          <header><strong><Check size={15} />{tr("workflows.result")}</strong>
            <button type="button" className="icon-button" onClick={() => onCopy(run.result!)} aria-label={tr("workflows.copy_result")} title={tr("workflows.copy_result")}><Copy size={14} /></button>
          </header>
          <pre>{run.result}</pre>
        </section>
      ) : null}

      <div className="wf-run-body">
        <div className="wf-canvas-frame">
          <WorkflowCanvas definition={run.definition} executors={executors} run={run} selection={selection} onSelect={setSelection} />
        </div>
        <div className="wf-run-side">
          <h3 className="wf-sessions-title">{tr("workflows.sessions")}<small>{tr("workflows.started_value", { p0: ago(run.startedAt) })}</small></h3>
          {run.sessions.length ? (
            <div className="wf-sessions" ref={list}>
              {run.sessions.map((session) => (
                <SessionCard key={session.id} session={session} now={now} looped={inLoop.has(session.nodeId)} highlighted={selectedNode === session.nodeId}
                  open={openSessions.includes(session.id)} onToggle={() => toggle(session.id)} />
              ))}
            </div>
          ) : <p className="wf-rule">{tr("workflows.sessions_none")}</p>}
        </div>
      </div>
    </div>
  );
}

function SessionCard({ session, now, looped, highlighted, open, onToggle }: {
  session: WorkflowSession;
  now: number;
  /** The node is inside a loop, so which round this was matters. */
  looped: boolean;
  highlighted: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const elapsed = session.elapsedMs ?? (session.startedAt ? Math.max(0, now - session.startedAt) : 0);
  const text = session.error ?? session.output ?? "";
  const expandable = Boolean(text);
  // A failure is shown in full without asking; a finished session shows its first line until opened.
  const expanded = expandable && (open || session.status === "failed");
  const title = (
    <>
      <StatusMark status={session.status} />
      <span className="wf-session-title">
        <strong>{session.role}</strong>
        {looped && session.round ? <em>{tr("workflows.round_value", { p0: session.round })}</em> : null}
        {session.verdict ? <em className={`verdict ${session.verdict}`}>{session.verdict === "pass" ? tr("workflows.verdict_pass") : tr("workflows.verdict_revise")}</em> : null}
        {session.item ? <span className="wf-session-item">{session.item}</span> : null}
      </span>
      <small>{[session.executor || tr("workflows.executor_inherit"), session.workspace === "worktree" ? tr("workflows.workspace_worktree") : "",
        duration(elapsed), session.tokens ? `${tokenCount(session.tokens)} tokens` : ""].filter(Boolean).join(" · ")}</small>
      {expandable ? <ChevronDown size={14} className="wf-chevron" /> : null}
    </>
  );
  return (
    <article className={`wf-session ${expanded ? "open" : ""} ${highlighted ? "highlighted" : ""}`} data-status={session.status} data-node={session.nodeId} data-testid="workflow-session">
      {expandable
        ? <button type="button" className="wf-session-header" aria-expanded={expanded} onClick={onToggle}>{title}</button>
        : <div className="wf-session-header">{title}</div>}
      {expanded ? <pre className={session.error ? "error" : ""}>{text}</pre>
        : session.status === "running" ? <p className="wf-session-preview">{tr("workflows.node_working")}</p>
        : text ? <p className="wf-session-preview">{text.split("\n")[0]}</p> : null}
    </article>
  );
}
