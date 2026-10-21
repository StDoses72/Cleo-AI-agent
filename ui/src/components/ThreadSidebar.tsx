import { modifierKey } from "../platform";
import { harnessLabel, isGeneralProject, projectLabel, projectsInSpace } from "../runtime-labels";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Brain,
  CircleAlert,
  FileClock,
  Folder,
  FolderGit2,
  FolderOpen,
  History,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import type { MemoryOverview, MemoryViewMode, Project, Thread, WorkspaceSpace } from "../types";

interface ThreadSidebarProps {
  space: WorkspaceSpace;
  projects: Project[];
  threads: Thread[];
  activeProjectId: string;
  activeThreadId: string | null;
  /** Start an empty draft in a folder project (the "+" on its header). */
  onStartThread: (projectId: string) => void;
  onRemoveProject: (project: Project) => void;
  onSelectThread: (threadId: string) => void;
  onDeleteThread: (thread: Thread) => void;
  /** Start an empty draft where the user currently is. */
  onCreateThread: () => void;
  recoverableChatBackups: number;
  onRestoreChatHistory: () => void;
  memoryOverview: MemoryOverview;
  memoryView: MemoryViewMode;
  onMemoryViewChange: (view: MemoryViewMode) => void;
  backendMode: "local" | "mock";
  unreadThreadIds?: string[];
}

const COLLAPSED_KEY = "cleo-collapsed-folders";
/** Rows shown before "显示更多" takes over, at the top level and inside a folder. */
const TOP_LIMIT = 8;
const FOLDER_LIMIT = 5;

function readCollapsed(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

interface FolderGroup {
  project: Project;
  threads: Thread[];
}

/** Purpose: The sidebar list, shaped like a coding agent's: each project is a header with its
 * threads indented beneath it, and standalone threads (no project) are ordinary rows below.
 * Nothing is boxed; indentation alone shows what belongs where. Projects are added from the
 * composer's project pill or the command palette, not from here.
 */
export function ThreadSidebar({
  space,
  projects,
  threads,
  activeProjectId,
  activeThreadId,
  onStartThread,
  onRemoveProject,
  onSelectThread,
  onDeleteThread,
  onCreateThread,
  recoverableChatBackups,
  onRestoreChatHistory,
  memoryOverview,
  memoryView,
  onMemoryViewChange,
  backendMode,
  unreadThreadIds = [],
}: ThreadSidebarProps) {
  const [query, setQuery] = useState("");
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<string[]>(readCollapsed);
  const [expanded, setExpanded] = useState<string[]>([]);
  const toggleFolder = (projectId: string) => {
    setCollapsed((current) => {
      const next = current.includes(projectId)
        ? current.filter((value) => value !== projectId)
        : [...current, projectId];
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
      return next;
    });
  };
  // Landing in a collapsed folder (a thread, or a draft started there) opens it.
  useEffect(() => {
    if (activeProjectId && collapsed.includes(activeProjectId)) toggleFolder(activeProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, activeThreadId]);

  const searching = Boolean(query.trim());
  const noun = space === "chat" ? "对话" : "任务";
  const { loose, folders } = useMemo(() => {
    if (space === "memory") return { loose: [] as Thread[], folders: [] as FolderGroup[] };
    const normalized = query.trim().toLocaleLowerCase();
    const matches = (thread: Thread) =>
      thread.space === space
      && (!normalized
        || thread.title.toLocaleLowerCase().includes(normalized)
        || thread.summary.toLocaleLowerCase().includes(normalized));
    const ordered = projectsInSpace(projects, space);
    const folderProjects = ordered.filter((project) => !isGeneralProject(project));
    const folderIds = new Set(folderProjects.map((project) => project.id));
    // Folder-less threads, and threads whose folder is no longer listed, are plain rows.
    const loose = threads.filter((thread) => !folderIds.has(thread.projectId) && matches(thread));
    const folders = folderProjects
      .map((project) => ({ project, threads: threads.filter((thread) => thread.projectId === project.id && matches(thread)) }))
      .filter((group) => !normalized || group.threads.length);
    return { loose, folders };
  }, [projects, query, space, threads]);

  const drafting = activeThreadId === null && space !== "memory";
  const draftProject = projects.find((project) => project.id === activeProjectId);
  const draftIsLoose = drafting && (!draftProject || isGeneralProject(draftProject));
  const nothing = !loose.length && !folders.length && !drafting;

  return (
    <aside className="thread-sidebar">
      <div className="sidebar-heading">
        <div>
          <h1>{space === "chat" ? "对话" : space === "memory" ? "记忆" : "开发任务"}</h1>
        </div>
        {space === "chat" && recoverableChatBackups > 0 ? (
          <div className="sidebar-actions-wrap">
            <button
              className="icon-button"
              type="button"
              aria-label="更多"
              title="更多"
              aria-expanded={actionsMenuOpen}
              onClick={() => setActionsMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={17} />
            </button>
            {actionsMenuOpen ? (
              <div className="sidebar-actions-menu surface-popover">
                  <button
                    type="button"
                    onClick={() => {
                      setActionsMenuOpen(false);
                      onRestoreChatHistory();
                    }}
                  >
                    <History size={15} />
                    <span>
                      <strong>恢复旧对话</strong>
                      <small>找到 {recoverableChatBackups} 条可恢复记录</small>
                    </span>
                  </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {space === "memory" ? (
        <MemorySidebar overview={memoryOverview} activeView={memoryView} onViewChange={onMemoryViewChange} />
      ) : (
        <>
          <button className="new-thread-button" type="button" onClick={onCreateThread} data-testid="new-thread">
            <Plus size={16} />
            <span>{space === "chat" ? "新对话" : "新任务"}</span>
            <kbd>{modifierKey} N</kbd>
          </button>

          <label className="sidebar-search">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={space === "chat" ? "搜索对话" : "搜索任务"}
              aria-label={space === "chat" ? "搜索对话" : "搜索任务"}
            />
          </label>

          <div className="thread-list" data-testid="thread-list">
            {folders.map((group) => {
              const label = projectLabel(group.project);
              const open = searching || !collapsed.includes(group.project.id);
              const draftHere = drafting && draftProject?.id === group.project.id;
              return (
                <section className="folder-group" key={group.project.id} data-project-id={group.project.id} aria-label={label}>
                  <div className="folder-group-header">
                    <button
                      className="folder-group-toggle"
                      type="button"
                      aria-expanded={open}
                      title={group.project.path}
                      onClick={() => toggleFolder(group.project.id)}
                    >
                      {open ? <FolderOpen size={15} /> : <Folder size={15} />}
                      <strong>{label}</strong>
                      {group.project.branch ? (
                        <small title={group.project.dirtyFiles ? `${group.project.branch} · ${group.project.dirtyFiles} 个文件有改动` : group.project.branch}>
                          {group.project.branch}{group.project.dirtyFiles ? ` · ${group.project.dirtyFiles}` : ""}
                        </small>
                      ) : null}
                    </button>
                    <div className="folder-group-actions">
                      <button
                        type="button"
                        aria-label={`在 ${label} 中新建${noun}`}
                        title={`在 ${label} 中新建${noun}`}
                        onClick={() => onStartThread(group.project.id)}
                        data-testid="new-thread-in-project"
                      >
                        <Plus size={14} />
                      </button>
                      {group.project.removable ? (
                        <button
                          className="folder-group-remove"
                          type="button"
                          aria-label={`移除项目 ${label}`}
                          title="移除项目（不删除本地文件）"
                          onClick={() => onRemoveProject(group.project)}
                        >
                          <Trash2 size={13} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {open ? (
                    <div className="thread-nested">
                      {draftHere ? <DraftRow noun={noun} /> : null}
                      {group.threads.length ? (
                        <ThreadRows
                          id={group.project.id}
                          threads={group.threads}
                          limit={searching ? Infinity : FOLDER_LIMIT}
                          expanded={expanded}
                          onExpand={(id) => setExpanded((current) => [...current, id])}
                          activeThreadId={activeThreadId}
                          unreadThreadIds={unreadThreadIds}
                          onSelectThread={onSelectThread}
                          onDeleteThread={onDeleteThread}
                        />
                      ) : draftHere ? null : (
                        <div className="folder-empty">{`还没有${noun}`}</div>
                      )}
                    </div>
                  ) : null}
                </section>
              );
            })}
            {/* Standalone work sits under the projects; the label only separates it from them. */}
            {folders.length && (loose.length || draftIsLoose) ? <div className="list-section-label">{`独立${noun}`}</div> : null}
            {draftIsLoose ? <DraftRow noun={noun} /> : null}
            <ThreadRows
              id="loose"
              threads={loose}
              limit={searching ? Infinity : TOP_LIMIT}
              expanded={expanded}
              onExpand={(id) => setExpanded((current) => [...current, id])}
              activeThreadId={activeThreadId}
              unreadThreadIds={unreadThreadIds}
              onSelectThread={onSelectThread}
              onDeleteThread={onDeleteThread}
            />
            {nothing ? (
              <div className="sidebar-empty">
                <FileClock size={20} />
                <span>{searching ? `没有匹配的${noun}` : `还没有${noun}`}</span>
              </div>
            ) : null}
          </div>

        </>
      )}

      {backendMode === "mock" && <footer className="sidebar-footer">演示模式</footer>}
    </aside>
  );
}

/** The unsent draft reads as the row it is about to become; it scrolls into view so a draft
 * parked below long folders is never out of sight. */
function DraftRow({ noun }: { noun: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollIntoView({ block: "nearest" }); }, []);
  return (
    <div className="thread-draft-row" aria-current="true" data-testid="draft-row" ref={ref}>
      <span className="thread-title-line"><strong>{`未发送的${noun}`}</strong></span>
    </div>
  );
}

function ThreadRows({
  id,
  threads,
  limit,
  expanded,
  onExpand,
  activeThreadId,
  unreadThreadIds,
  onSelectThread,
  onDeleteThread,
}: {
  id: string;
  threads: Thread[];
  limit: number;
  expanded: string[];
  onExpand: (id: string) => void;
  activeThreadId: string | null;
  unreadThreadIds: string[];
  onSelectThread: (threadId: string) => void;
  onDeleteThread: (thread: Thread) => void;
}) {
  // The selected thread is never hidden behind "显示更多".
  const activeIndex = threads.findIndex((thread) => thread.id === activeThreadId);
  const shown = expanded.includes(id) || activeIndex >= limit ? threads : threads.slice(0, limit);
  return (
    <>
      {shown.map((thread) => (
        <ThreadRow
          key={thread.id}
          thread={thread}
          active={thread.id === activeThreadId}
          unread={unreadThreadIds.includes(thread.id)}
          onClick={() => onSelectThread(thread.id)}
          onDelete={() => onDeleteThread(thread)}
        />
      ))}
      {shown.length < threads.length ? (
        <button className="thread-more" type="button" onClick={() => onExpand(id)}>
          {`显示更多（${threads.length - shown.length}）`}
        </button>
      ) : null}
    </>
  );
}

function ThreadRow({
  thread,
  active,
  unread = false,
  onClick,
  onDelete,
}: {
  thread: Thread;
  active: boolean;
  unread?: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  const harness = harnessLabel(thread.runtime, thread.space);
  const status = thread.waitingFor ? "attention" : thread.status;
  const hint = [thread.summary, thread.runtime?.model
    ? `${thread.runtime.provider} · ${thread.runtime.model}` : harness, thread.updatedAt].filter(Boolean).join(" · ");
  const stateLabel = thread.waitingFor === "approval" ? "等待审批"
    : thread.waitingFor === "question" ? "等待回答"
    : thread.status === "running" ? "运行中"
    : thread.status === "attention" ? "需要查看"
    : unread ? "新回复" : "";
  return (
    <div
      className={`thread-row ${active ? "active" : ""} ${unread ? "unread" : ""}`}
      data-status={status}
      data-unread={unread || undefined}
    >
      <button className="thread-row-select" type="button" onClick={onClick} title={hint}
        aria-label={stateLabel ? `${thread.title}（${stateLabel}）` : undefined}>
        <span className="thread-title-line"><strong>{thread.title}</strong></span>
        {/* Status sits before the harness so every harness label lines up at the right edge. */}
        {stateLabel ? (
          <span className="thread-meta" title={stateLabel}>
            {status === "running" ? <span className="thread-status-dot" />
              : status === "attention" ? <CircleAlert size={13} />
              : <span className="thread-unread-dot" />}
          </span>
        ) : null}
        {harness ? <small className="thread-harness">{harness}</small> : null}
      </button>
      <button
        className="thread-delete-button"
        type="button"
        aria-label={`删除 ${thread.title}`}
        title={thread.status === "running" ? "请先停止运行" : "删除任务"}
        disabled={thread.status === "running"}
        onClick={onDelete}
        data-testid="delete-thread"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function MemorySidebar({
  overview,
  activeView,
  onViewChange,
}: {
  overview: MemoryOverview;
  activeView: MemoryViewMode;
  onViewChange: (view: MemoryViewMode) => void;
}) {
  return (
    <div className="memory-sidebar-groups">
      <button className={`memory-nav-row ${activeView === "all" ? "active" : ""}`} type="button" onClick={() => onViewChange("all")} data-testid="memory-nav-all">
        <Brain size={16} />
        <span>全部记忆</span>
        <small>{overview.summary.active_memories}</small>
      </button>
      <button className={`memory-nav-row ${activeView === "projects" ? "active" : ""}`} type="button" onClick={() => onViewChange("projects")} data-testid="memory-nav-projects">
        <FolderGit2 size={16} />
        <span>项目记忆</span>
        <small>{overview.summary.project_memories}</small>
      </button>
      <button className={`memory-nav-row ${activeView === "pending" ? "active" : ""}`} type="button" onClick={() => onViewChange("pending")} data-testid="memory-nav-pending">
        <CircleAlert size={16} />
        <span>待确认</span>
        <small>{overview.summary.pending_sources}</small>
      </button>
    </div>
  );
}
