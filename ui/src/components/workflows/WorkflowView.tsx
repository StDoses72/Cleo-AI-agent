import { t as tr } from "../../../electron/i18n.mjs";
import { ArrowRight, CircleAlert, Copy, LoaderCircle, Play, Plus, Sparkles, Trash2, Workflow } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { projectsInSpace } from "../../runtime-labels";
import type { Project } from "../../types";
import type { WorkflowClient, WorkflowDefinition, WorkflowLibrary, WorkflowRunSummary } from "../../workflow-types";
import { duration } from "../Timing";
import { StatusMark } from "./WorkflowCanvas";
import { WorkflowEditor } from "./WorkflowEditor";
import { WorkflowLaunch, WorkflowRunView } from "./WorkflowRun";
import { ago, runStatusLabel, workflowOutline } from "./workflow-labels";
import { agentBound, duplicateWorkflow, newWorkflow, workflowIssues } from "./workflow-model";
import "./workflows.css";

/** Where the workflows page is. It lives above the page so leaving and coming back keeps an
 * unsaved edit or the run on screen. */
export type WorkflowScreen =
  | { name: "library"; tab: "workflows" | "runs" }
  /** `baseline` is the saved copy as JSON; `null` for a workflow the library does not hold yet. */
  | { name: "editor"; definition: WorkflowDefinition; baseline: string | null; task: string }
  | { name: "launch"; definition: WorkflowDefinition; baseline: string | null; task: string; projectId: string; from: "library" | "editor" }
  | { name: "run"; runId: string };

export const workflowHome: WorkflowScreen = { name: "library", tab: "workflows" };

interface WorkflowViewProps {
  client: WorkflowClient;
  screen: WorkflowScreen;
  onScreenChange: (screen: WorkflowScreen) => void;
  projects: Project[];
  /** The project a run starts in unless the user picks another. */
  defaultProjectId: string;
  onNotify: (message: string, tone?: "success" | "error") => void;
  onCopyText: (text: string) => void;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Purpose: The workflows page: the saved workflows and past runs, the editor, the confirmation
 * before a run, and the run itself. */
export function WorkflowView({ client, screen, onScreenChange, projects, defaultProjectId, onNotify, onCopyText }: WorkflowViewProps) {
  const [library, setLibrary] = useState<WorkflowLibrary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftTask, setDraftTask] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const requests = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++requests.current;
    try {
      const loaded = await client.library();
      if (request === requests.current) { setLibrary(loaded); setLoadError(null); }
    } catch (error) {
      if (request === requests.current) setLoadError(message(error));
    }
  }, [client]);
  useEffect(() => { void refresh(); }, [refresh]);
  // The list follows runs that are still going while it is on screen.
  const anyRunning = Boolean(library?.runs.some((run) => run.status === "running"));
  useEffect(() => {
    if (screen.name !== "library" || !anyRunning) return;
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [screen.name, anyRunning, refresh]);
  useEffect(() => { setActionError(null); }, [screen.name]);

  const runProjects = projectsInSpace(projects, "productivity");
  const startProjectId = runProjects.some((project) => project.id === defaultProjectId) ? defaultProjectId : runProjects[0]?.id ?? "";

  if (!library) {
    return (
      <main className="workflow-view" data-testid="workflow-view">
        {loadError ? <div className="wf-banner failed" role="alert"><CircleAlert size={16} /><div><strong>{tr("workflows.load_failed")}</strong><span>{loadError}</span></div>
          <button type="button" className="wf-button" onClick={() => void refresh()}>{tr("app.retry")}</button></div>
          : <div className="wf-loading" role="status"><LoaderCircle size={16} className="spin" />{tr("overlays.loading")}</div>}
      </main>
    );
  }

  const inLibrary = (definition: WorkflowDefinition) => library.workflows.some((item) => item.id === definition.id);
  const baselineOf = (definition: WorkflowDefinition) => {
    const saved = library.workflows.find((item) => item.id === definition.id);
    return saved ? JSON.stringify(saved) : null;
  };
  const save = async (definition: WorkflowDefinition) => {
    const saved = await client.save(definition);
    await refresh();
    onNotify(tr("workflows.saved_toast", { p0: saved.name }));
    return saved;
  };
  const launch = (definition: WorkflowDefinition, task: string, from: "library" | "editor", projectId = startProjectId) =>
    onScreenChange({ name: "launch", definition, baseline: baselineOf(definition), task, projectId, from });

  if (screen.name === "editor") {
    const dirty = screen.baseline === null || JSON.stringify(screen.definition) !== screen.baseline;
    const untouched = screen.baseline === null && !screen.definition.nodes.length;
    return (
      <main className="workflow-view" data-testid="workflow-view">
        <WorkflowEditor definition={screen.definition} executors={library.executors} saved={screen.baseline !== null} dirty={dirty}
          saving={saving} error={actionError} onNotify={onNotify}
          onChange={(definition) => onScreenChange({ ...screen, definition })}
          onSave={() => {
            setSaving(true);
            setActionError(null);
            void save(screen.definition)
              .then((saved) => onScreenChange({ ...screen, definition: saved, baseline: JSON.stringify(saved) }))
              .catch((error: unknown) => setActionError(message(error)))
              .finally(() => setSaving(false));
          }}
          onRun={() => onScreenChange({ name: "launch", definition: screen.definition, baseline: screen.baseline, task: screen.task, projectId: startProjectId, from: "editor" })}
          onBack={() => {
            if (dirty && !untouched && !window.confirm(tr("workflows.discard_confirm"))) return;
            onScreenChange(workflowHome);
          }} />
      </main>
    );
  }

  if (screen.name === "launch") {
    return (
      <main className="workflow-view" data-testid="workflow-view">
        <WorkflowLaunch definition={screen.definition} reviewDraft={screen.definition.origin === "drafted" && screen.baseline === null}
          executors={library.executors} projects={runProjects}
          task={screen.task} onTaskChange={(task) => onScreenChange({ ...screen, task })}
          projectId={screen.projectId} onProjectChange={(projectId) => onScreenChange({ ...screen, projectId })}
          starting={starting} error={actionError}
          onStart={() => {
            setStarting(true);
            setActionError(null);
            void client.start(screen.definition, screen.task, screen.projectId)
              .then((run) => { onScreenChange({ name: "run", runId: run.id }); void refresh(); })
              .catch((error: unknown) => setActionError(message(error)))
              .finally(() => setStarting(false));
          }}
          onBack={() => onScreenChange(screen.from === "editor"
            ? { name: "editor", definition: screen.definition, baseline: screen.baseline, task: screen.task } : workflowHome)} />
      </main>
    );
  }

  if (screen.name === "run") {
    return (
      <main className="workflow-view" data-testid="workflow-view">
        <WorkflowRunView key={screen.runId} client={client} runId={screen.runId} executors={library.executors} projects={projects}
          saved={inLibrary} onBack={() => onScreenChange({ name: "library", tab: "runs" })}
          onRunAgain={(run) => launch(run.definition, run.task, "library", run.projectId)}
          onSaveDefinition={async (definition) => { await save(definition).catch((error: unknown) => onNotify(message(error), "error")); }}
          onSettled={() => void refresh()}
          onCopy={(text) => { onCopyText(text); onNotify(tr("workflows.copied")); }} />
      </main>
    );
  }

  const draft = (event: FormEvent) => {
    event.preventDefault();
    const task = draftTask.trim();
    if (!task || drafting) return;
    setDrafting(true);
    setDraftError(null);
    void client.draft(task)
      .then((definition) => { setDraftTask(""); onScreenChange({ name: "editor", definition, baseline: null, task }); })
      .catch((error: unknown) => setDraftError(message(error)))
      .finally(() => setDrafting(false));
  };
  const lastRun = (workflowId: string) => library.runs.find((run) => run.workflowId === workflowId);
  const running = library.runs.filter((run) => run.status === "running").length;

  return (
    <main className="workflow-view" data-testid="workflow-view">
      <header className="wf-library-header">
        <div>
          <h2>{tr("workflows.title")}</h2>
          <div className="memory-tabs" role="tablist" aria-label={tr("workflows.title")}>
            {([["workflows", tr("workflows.tab_workflows"), library.workflows.length], ["runs", tr("workflows.tab_runs"), library.runs.length]] as const).map(([tab, label, count]) => (
              <button key={tab} type="button" role="tab" aria-selected={screen.tab === tab} className={screen.tab === tab ? "active" : ""}
                data-testid={`workflow-tab-${tab}`} onClick={() => onScreenChange({ name: "library", tab })}>
                {label}<small>{count}</small>
                {tab === "runs" && running ? <span className="wf-running-dot" title={tr("workflows.running_count", { p0: running })} /> : null}
              </button>
            ))}
          </div>
        </div>
        <button type="button" className="wf-button primary" data-testid="new-workflow"
          onClick={() => onScreenChange({ name: "editor", definition: newWorkflow(tr("workflows.untitled")), baseline: null, task: "" })}>
          <Plus size={14} />{tr("workflows.new")}
        </button>
      </header>

      {screen.tab === "workflows" ? (
        <>
          <form className="wf-draft-bar" onSubmit={draft} aria-busy={drafting}>
            <Sparkles size={16} />
            <input value={draftTask} disabled={drafting} maxLength={400} placeholder={tr("workflows.draft_placeholder")}
              aria-label={tr("workflows.draft_label")} data-testid="workflow-draft-input" onChange={(event) => setDraftTask(event.target.value)} />
            <button type="submit" className="wf-button" disabled={drafting || !draftTask.trim()} data-testid="workflow-draft-submit">
              {drafting ? <><LoaderCircle size={14} className="spin" />{tr("workflows.drafting")}</> : tr("workflows.draft")}
            </button>
          </form>
          {draftError ? <p className="wf-inline-error" role="alert">{draftError}</p> : null}

          {library.workflows.length ? (
            <div className="wf-list" data-testid="workflow-list">
              {library.workflows.map((definition) => {
                const issues = workflowIssues(definition, library.executors);
                const last = lastRun(definition.id);
                const outline = workflowOutline(definition);
                return (
                  <article className="wf-card" key={definition.id} data-testid="workflow-card">
                    <button type="button" className="wf-card-main" title={tr("workflows.edit")}
                      onClick={() => onScreenChange({ name: "editor", definition, baseline: JSON.stringify(definition), task: "" })}>
                      <span className="wf-card-title"><strong>{definition.name}</strong>
                        {definition.origin === "drafted" ? <em><Sparkles size={11} />{tr("workflows.drafted_tag")}</em> : null}</span>
                      {definition.description ? <p>{definition.description}</p> : null}
                      <span className="wf-outline">
                        {outline.map((part, index) => (
                          <Fragment key={index}>{index ? <ArrowRight size={12} aria-hidden="true" /> : null}<span>{part}</span></Fragment>
                        ))}
                      </span>
                      <small>
                        {tr("workflows.agent_bound", { p0: agentBound(definition) })}
                        {" · "}{last ? `${tr("workflows.last_run")}${runStatusLabel(last.status)} · ${ago(last.startedAt)}` : tr("workflows.never_run")}
                      </small>
                    </button>
                    <div className="wf-card-actions">
                      <button type="button" className="wf-button primary" disabled={issues.length > 0} data-testid="workflow-card-run"
                        title={issues.length ? tr("workflows.fix_issues_first") : undefined} onClick={() => launch(definition, "", "library")}>
                        <Play size={13} />{tr("workflows.run")}
                      </button>
                      <button type="button" className="icon-button" aria-label={tr("workflows.duplicate_value", { p0: definition.name })} title={tr("workflows.duplicate")}
                        onClick={() => void save(duplicateWorkflow(definition, tr("workflows.copy_name", { p0: definition.name })))
                          .catch((error: unknown) => onNotify(message(error), "error"))}><Copy size={14} /></button>
                      <button type="button" className="icon-button" aria-label={tr("workflows.delete_value", { p0: definition.name })} title={tr("workflows.delete")}
                        onClick={() => {
                          if (!window.confirm(tr("workflows.delete_confirm", { p0: definition.name }))) return;
                          void client.remove(definition.id).then(refresh).then(() => onNotify(tr("workflows.deleted_toast", { p0: definition.name })))
                            .catch((error: unknown) => onNotify(message(error), "error"));
                        }}><Trash2 size={14} /></button>
                    </div>
                    {issues.length ? <p className="wf-card-issue"><CircleAlert size={13} />{tr("workflows.card_issues", { p0: issues.length })}</p> : null}
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="wf-empty" data-testid="workflow-empty">
              <Workflow size={20} />
              <strong>{tr("workflows.empty_title")}</strong>
              <span>{tr("workflows.empty_hint")}</span>
            </div>
          )}
        </>
      ) : library.runs.length ? (
        <div className="wf-run-list" data-testid="workflow-run-list">
          {library.runs.map((run) => <RunRow key={run.id} run={run} onOpen={() => onScreenChange({ name: "run", runId: run.id })} />)}
        </div>
      ) : (
        <div className="wf-empty"><Workflow size={20} /><strong>{tr("workflows.no_runs_title")}</strong><span>{tr("workflows.no_runs_hint")}</span></div>
      )}
    </main>
  );
}

function RunRow({ run, onOpen }: { run: WorkflowRunSummary; onOpen: () => void }) {
  const status = run.status === "completed" ? "done" : run.status;
  return (
    <button type="button" className="wf-run-row" onClick={onOpen} data-status={run.status} data-testid="workflow-run-row">
      <StatusMark status={status} />
      <span className="wf-run-row-copy"><strong>{run.name}</strong><small>{run.task}</small></span>
      <small className="wf-run-row-meta">
        {runStatusLabel(run.status)}{run.finishedAt ? ` · ${duration(run.finishedAt - run.startedAt)}` : ""} · {ago(run.startedAt)}
      </small>
    </button>
  );
}
