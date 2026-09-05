import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  Braces,
  Check,
  ChevronRight,
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
} from "lucide-react";
import type { MemoryEntry, Project, RuntimeProfile, Thread } from "../types";

export type InspectorTab = "changes" | "context" | "run";

interface InspectorProps {
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
}

export function Inspector({
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
}: InspectorProps) {
  return (
    <aside className="inspector" data-testid="inspector">
      <header className="inspector-header">
        <div className="inspector-tabs" role="tablist">
          <button className={activeTab === "changes" ? "active" : ""} type="button" onClick={() => onTabChange("changes")}>变更 {thread?.changes.length ? <small>{thread.changes.length}</small> : null}</button>
          <button className={activeTab === "context" ? "active" : ""} type="button" onClick={() => onTabChange("context")}>上下文</button>
          <button className={activeTab === "run" ? "active" : ""} type="button" onClick={() => onTabChange("run")}>运行</button>
        </div>
        <button className="icon-button" type="button" aria-label="关闭检查器" onClick={onClose}><X size={16} /></button>
      </header>
      {activeTab === "changes" ? (
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
        <strong>没有文件变更</strong>
        <span>Agent 的修改会在这里按文件展示。</span>
      </div>
    );
  }

  return (
    <div className="changes-panel">
      <div className="change-history-picker">
        <Clock3 size={14} />
        <select
          aria-label="选择变更快照"
          data-testid="change-history-picker"
          value={selectedSetId}
          onChange={(event) => setSelectedSetId(event.target.value)}
        >
          <option value="workspace">当前工作区 · {thread?.changes.length ?? 0} 个文件</option>
          {history.map((changeSet) => (
            <option value={changeSet.id} key={changeSet.id}>
              {changeSet.title} · {changeSet.createdAt} · {changeSet.changes.length} 个文件
            </option>
          ))}
        </select>
      </div>
      {!changes.length ? (
        <div className="inspector-empty change-snapshot-empty">
          <GitBranch size={22} />
          <strong>当前工作区没有变更</strong>
          <span>可从上方选择之前的 Agent 修改继续审查。</span>
        </div>
      ) : (
        <>
          <div className="change-summary">
            <span>{changes.length} 个文件</span>
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
                <div><Braces size={14} /><span>{selected.path.split("/").at(-1)}</span></div>
                <button type="button" title="复制路径" onClick={() => {
                  onCopyText(selected.path);
                  onNotify("文件路径已复制");
                }}><Copy size={14} /></button>
              </header>
              <pre>
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
  const ratio = thread ? Math.round((thread.usage.used / thread.usage.limit) * 100) : 0;
  const relevantMemories = useMemo(() => memories.slice(0, 3), [memories]);
  return (
    <div className="context-panel">
      <section className="inspector-section">
        <div className="section-kicker"><Cpu size={14} /><span>运行参数</span></div>
        <dl className="property-list">
          <div><dt>Provider</dt><dd>{runtime.provider}</dd></div>
          <div><dt>Model</dt><dd>{runtime.model}</dd></div>
          <div><dt>推理</dt><dd>{runtime.effort}</dd></div>
          <div><dt>访问</dt><dd>{runtime.access}</dd></div>
          <div><dt>确认</dt><dd>{runtime.approval}</dd></div>
        </dl>
      </section>
      <section className="inspector-section">
        <div className="section-kicker"><Clock3 size={14} /><span>上下文窗口</span><small>{ratio}%</small></div>
        <div className="usage-track"><span style={{ width: `${ratio}%` }} /></div>
        <div className="usage-copy"><span>{((thread?.usage.used ?? 0) / 1000).toFixed(1)}k / {((thread?.usage.limit ?? 128000) / 1000).toFixed(0)}k</span><small>in {thread?.usage.input ?? 0} · out {thread?.usage.output ?? 0}</small></div>
      </section>
      <section className="inspector-section">
        <div className="section-kicker"><ShieldCheck size={14} /><span>工作区</span></div>
        <button className="workspace-context-row" type="button" onClick={() => project?.path && onRevealPath(project.path)}><span className="project-glyph compact" style={{ "--project-accent": project?.accent } as CSSProperties}>{project?.name.slice(0, 1)}</span><div><strong>{project?.name}</strong><small>{project?.path}</small></div></button>
      </section>
      <section className="inspector-section memory-context">
        <div className="section-kicker"><CircleCheck size={14} /><span>已附加记忆</span><small>{relevantMemories.length}</small></div>
        {relevantMemories.map((memory) => (
          <button type="button" key={memory.id}><span>{memory.title}</span><ChevronRight size={13} /></button>
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
        <div><strong>{running ? "Agent 正在执行" : hasIssue ? "上次运行需要查看" : completed ? "上次运行已完成" : "尚未运行"}</strong><small>{running || hasIssue || completed ? thread?.updatedAt : "发送第一条消息后，可在这里查看进度。"}</small></div>
      </section>
      <div className="terminal-head"><Terminal size={14} /><span>cleo · {project?.name ?? "workspace"}</span></div>
      <pre className="terminal-output"><span className="prompt">PS {project?.path ?? "D:\\workspace"}&gt;</span>{"\n"}{thread?.terminal?.length ? thread.terminal.join("") : <span className="muted">终端输出会在 Agent 执行命令时实时显示。</span>}{"\n\n"}<span className="cursor">▋</span></pre>
      <div className="run-events">
        {thread?.items.filter((item) => item.type === "tool").slice(-8).map((item) => item.type === "tool" ? <div className={item.status === "error" ? "issue" : ""} key={item.id}>{item.status === "error" ? <CircleAlert size={14} /> : item.status === "running" ? <Circle size={14} /> : <CircleCheck size={14} />}<span>{item.name}</span><time>{item.status === "running" ? "running" : item.status}</time></div> : null)}
        {!thread?.items.some((item) => item.type === "tool") ? <div><Clock3 size={14} /><span>尚无工具运行</span><time>—</time></div> : null}
      </div>
    </div>
  );
}
