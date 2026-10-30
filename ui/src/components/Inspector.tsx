import { t as tr } from "../../electron/i18n.mjs";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  Braces,
  Check,
  Circle,
  CircleAlert,
  CircleCheck,
  Clock3,
  Copy,
  Cpu,
  FileCode2,
  GitBranch,
  ShieldCheck,
  Terminal,
  X,
  FolderMinus,
} from "lucide-react";
import type { MemoryEntry, Project, RuntimeProfile, Thread } from "../types";
import { accessLabel, approvalLabel, effortLabels, isGeneralProject, projectLabel, projectPathLabel } from "../runtime-labels";
import { Timing } from "./Timing";
import { ComputerPanel } from "./ComputerPanel";
import { FilesPanel, type FileReveal } from "./FilesPanel";

export type InspectorTab = "changes" | "context" | "run" | "files" | "computer";

interface InspectorProps {
  running: boolean;
  onStop: () => void;
  resizeHandle?: ReactNode;
  thread: Thread | null;
  project: Project | null;
  runtime: RuntimeProfile;
  memories: MemoryEntry[];
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  onClose: () => void;
  onNotify: (message: string) => void;
  onCopyText: (value: string) => void;
  onRevealPath: (value: string) => void;
  fileReveal?: FileReveal | null;
  onOpenExternalPath?: (absolutePath: string) => void;
}

export function Inspector({
  running,
  onStop,
  resizeHandle,
  thread,
  project,
  runtime,
  memories,
  activeTab,
  onTabChange,
  onClose,
  onNotify,
  onCopyText,
  onRevealPath,
  fileReveal = null,
  onOpenExternalPath,
}: InspectorProps) {
  return (
    <aside className="inspector" data-testid="inspector">
      {resizeHandle}
      <header className="inspector-header">
        <div className="inspector-tabs" role="tablist">
          <button className={activeTab === "changes" ? "active" : ""} type="button" onClick={() => onTabChange("changes")}>{tr("inspector.changes")}{thread?.changes.length ? <small>{thread.changes.length}</small> : null}</button>
          <button className={activeTab === "context" ? "active" : ""} type="button" onClick={() => onTabChange("context")}>{tr("inspector.context")}</button>
          <button className={activeTab === "run" ? "active" : ""} type="button" onClick={() => onTabChange("run")}>{tr("inspector.run")}</button>
          <button className={activeTab === "files" ? "active" : ""} type="button" onClick={() => onTabChange("files")}>{tr("approvalprompt.file")}</button>
          <button className={activeTab === "computer" ? "active" : ""} type="button" onClick={() => onTabChange("computer")}>{tr("inspector.computer")}</button>
        </div>
        <button className="icon-button" type="button" aria-label={tr("app.close_inspector")} onClick={onClose}><X size={16} /></button>
      </header>
      {activeTab === "computer" ? (
        <ComputerPanel thread={thread} running={running} onStop={onStop} />
      ) : activeTab === "files" ? (
        <FilesPanel root={project?.path || null} threadId={thread?.id ?? null} reveal={fileReveal} onNotify={onNotify} onCopyText={onCopyText}
          onOpenExternal={(path) => (onOpenExternalPath ? onOpenExternalPath(path) : onRevealPath(path))}
          onOpenBrowser={() => onTabChange("computer")} />
      ) : activeTab === "changes" ? (
        <ChangesPanel thread={thread} onNotify={onNotify} onCopyText={onCopyText} />
      ) : activeTab === "context" ? (
        <ContextPanel thread={thread} project={project} runtime={runtime} memories={memories} onRevealPath={onRevealPath} />
      ) : (
        <RunPanel thread={thread} project={project} />
      )}
    </aside>
  );
}

function ChangesPanel({ thread, onNotify, onCopyText }: { thread: Thread | null; onNotify: (message: string) => void; onCopyText: (value: string) => void }) {
  const [selectedSetId, setSelectedSetId] = useState("workspace");
  const history = thread?.changeHistory ?? [];
  const selectedSet = history.find((changeSet) => changeSet.id === selectedSetId);
  const changes = selectedSet?.changes ?? thread?.changes ?? [];
  const [selectedPath, setSelectedPath] = useState(changes[0]?.path ?? "");
  useEffect(() => {
    setSelectedSetId("workspace");
  }, [thread?.id]);
  useEffect(() => {
    setSelectedPath((current) => (
      changes.some((file) => file.path === current) ? current : changes[0]?.path ?? ""
    ));
  }, [changes, selectedSetId]);
  const selected = changes.find((file) => file.path === selectedPath) ?? changes[0];

  if (!thread?.changes.length && !history.length) {
    return (
      <div className="inspector-empty">
        <GitBranch size={22} />
        <strong>{tr("inspector.no_file_changes")}</strong>
      </div>
    );
  }

  return (
    <div className="changes-panel">
      <div className="change-history-picker">
        <Clock3 size={14} />
        <select
          aria-label={tr("inspector.choose_change_snapshot")}
          data-testid="change-history-picker"
          value={selectedSetId}
          onChange={(event) => setSelectedSetId(event.target.value)}
        >
          <option value="workspace">{tr("inspector.current_workspace")}{thread?.changes.length ?? 0} {tr("inspector.files")}</option>
          {history.map((changeSet) => (
            <option value={changeSet.id} key={changeSet.id}>
              {changeSet.title} · {changeSet.createdAt} · {changeSet.changes.length} {tr("inspector.files_2")}</option>
          ))}
        </select>
      </div>
      {!changes.length ? (
        <div className="inspector-empty change-snapshot-empty">
          <GitBranch size={22} />
          <strong>{tr("inspector.no_changes_in_the_current_workspace")}</strong>
        </div>
      ) : (
        <>
          <div className="change-summary">
            <span>{changes.length} {tr("inspector.files")}</span>
            <div><strong>+{changes.reduce((total, file) => total + file.additions, 0)}</strong><em>-{changes.reduce((total, file) => total + file.deletions, 0)}</em></div>
          </div>
          <div className="changed-files">
            {changes.map((file) => (
              <button className={file.path === selected?.path ? "active" : ""} type="button" key={file.path} onClick={() => setSelectedPath(file.path)}>
                <FileCode2 size={14} />
                <span>{file.path}</span>
                <small className={file.status}>{file.status.slice(0, 1).toUpperCase()}</small>
              </button>
            ))}
          </div>
          {selected ? (
            <div className="diff-viewer">
              <header>
                <div><Braces size={14} /><span title={selected.path}>{selected.path.split("/").at(-1)}</span></div>
                <button type="button" title={tr("filespanel.copy_path")} onClick={() => {
                  onCopyText(selected.path);
                  onNotify(tr("filespanel.file_path_copied"));
                }}><Copy size={14} /></button>
              </header>
              <pre tabIndex={0} role="region" aria-label={tr("inspector.code_diff")}>
                {selected.diff.split("\n").map((line, index) => (
                  <span className={line.startsWith("+") ? "added" : line.startsWith("-") ? "deleted" : line.startsWith("@@") ? "hunk" : ""} key={`${index}-${line}`}>
                    <i>{index + 1}</i><code>{line || " "}</code>
                  </span>
                ))}
              </pre>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function ContextPanel({
  thread,
  project,
  runtime,
  memories,
  onRevealPath,
}: {
  thread: Thread | null;
  project: Project | null;
  runtime: RuntimeProfile;
  memories: MemoryEntry[];
  onRevealPath: (value: string) => void;
}) {
  const ratio = thread?.usage.used != null && thread.usage.limit > 0
    ? Math.round((thread.usage.used / thread.usage.limit) * 100) : null;
  const relevantMemories = useMemo(() => memories.slice(0, 3), [memories]);
  return (
    <div className="context-panel">
      <section className="inspector-section">
        <div className="section-kicker"><Cpu size={14} /><span>{tr("inspector.run_settings")}</span></div>
        <dl className="property-list">
          <div><dt>{tr("conversation.provider")}</dt><dd>{runtime.provider}</dd></div>
          <div><dt>{tr("inspector.model")}</dt><dd>{runtime.model}</dd></div>
          <div><dt>{tr("conversation.reasoning_effort")}</dt><dd>{runtime.effort ? effortLabels[runtime.effort] ?? runtime.effort : tr("conversation.determined_by_the_model")}</dd></div>
          <div><dt>{tr("inspector.access")}</dt><dd title={runtime.access}>{accessLabel(runtime.access)}</dd></div>
          <div><dt>{tr("inspector.approval")}</dt><dd title={runtime.approval}>{approvalLabel(runtime.approval)}</dd></div>
        </dl>
      </section>
      <section className="inspector-section">
        <div className="section-kicker"><Clock3 size={14} /><span>{tr("inspector.context_window")}</span><small>{ratio === null ? "—" : `${ratio}%`}</small></div>
        {ratio !== null && <div className="usage-track"><span style={{ width: `${Math.min(100, ratio)}%` }} /></div>}
        <div className="usage-copy"><span>{thread?.usage.used == null || thread.usage.limit <= 0 ? tr("inspector.context_usage_unknown") : `${(thread.usage.used / 1000).toFixed(1)}k / ${(thread.usage.limit / 1000).toFixed(0)}k`}</span><small>{tr("inspector.input")}{thread?.usage.input ?? "—"} {tr("inspector.output")}{thread?.usage.output ?? "—"}</small></div>
      </section>
      <section className="inspector-section">
        <div className="section-kicker"><ShieldCheck size={14} /><span>{tr("inspector.workspace")}</span></div>
        <button className="workspace-context-row" type="button" onClick={() => project?.path && onRevealPath(project.path)}><span className={`project-glyph compact ${isGeneralProject(project) ? "plain" : ""}`} style={{ "--project-accent": project?.accent } as CSSProperties}>{isGeneralProject(project) ? <FolderMinus size={12} /> : projectLabel(project).slice(0, 1)}</span><div><strong>{projectLabel(project) || tr("inspector.no_project")}</strong><small>{projectPathLabel(project) || tr("inspector.standalone_task_without_a_project_directory")}</small></div></button>
      </section>
      <section className="inspector-section memory-context">
        <div className="section-kicker"><CircleCheck size={14} /><span>{tr("inspector.memory_preview")}</span><small>{relevantMemories.length}</small></div>
        {relevantMemories.map((memory) => (
          <details key={memory.id}><summary>{memory.title}</summary><p>{memory.content}</p></details>
        ))}
      </section>
    </div>
  );
}

function RunPanel({ thread, project }: { thread: Thread | null; project: Project | null }) {
  const running = thread?.status === "running";
  const hasIssue = thread?.status === "attention";
  const completed = thread?.status === "completed";
  return (
    <div className="run-panel">
      <section className="run-status">
        <span className={running ? "running" : hasIssue ? "issue" : completed ? "complete" : "idle"}>{running ? <Circle size={12} /> : hasIssue ? <CircleAlert size={12} /> : completed ? <Check size={12} /> : <Clock3 size={12} />}</span>
        <div><strong>{running ? tr("inspector.agent_is_running") : hasIssue ? tr("inspector.the_last_run_needs_attention") : completed ? tr("inspector.the_last_run_completed") : tr("inspector.not_run_yet")}</strong>{(running || hasIssue || completed) && <small>{thread?.updatedAt}</small>}</div>
      </section>
      <Timing key={thread?.currentTiming?.id ?? thread?.id} summary={thread?.currentTiming} error={thread?.timingError} />
      <div className="terminal-head"><Terminal size={14} /><span>cleo · {project?.name ?? "workspace"}</span></div>
      <pre className="terminal-output" tabIndex={0} role="region" aria-label={tr("inspector.terminal_output")}>{thread?.terminal?.length ? thread.terminal.join("") : <span className="muted">{tr("inspector.no_execution_output_yet")}</span>}{running && <span className="cursor">▋</span>}</pre>
      <div className="run-events">
        {thread?.items.filter((item) => item.type === "tool").slice(-8).map((item) => item.type === "tool" ? <div className={item.status === "error" ? "issue" : ""} key={item.id}>{item.status === "error" ? <CircleAlert size={14} /> : item.status === "running" ? <Circle size={14} /> : <CircleCheck size={14} />}<span>{item.name}</span><time>{item.status === "running" ? tr("conversation.running") : item.status === "error" ? tr("conversation.failed") : tr("conversation.done")}</time></div> : null)}
        {!thread?.items.some((item) => item.type === "tool") ? <div><Clock3 size={14} /><span>{tr("inspector.no_tools_have_run_yet")}</span></div> : null}
      </div>
    </div>
  );
}
