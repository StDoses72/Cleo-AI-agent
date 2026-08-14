import { useMemo, useState, type CSSProperties } from "react";
import {
  Brain,
  ChevronDown,
  CircleAlert,
  FileClock,
  FolderOpen,
  FolderGit2,
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
  onSelectProject: (projectId: string) => void;
  onSelectThread: (threadId: string) => void;
  onDeleteThread: (thread: Thread) => void;
  onCreateThread: () => void;
  onChooseWorkspace: () => void;
  onOpenCommand: () => void;
  recoverableChatBackups: number;
  onRestoreChatHistory: () => void;
  memoryOverview: MemoryOverview;
  memoryView: MemoryViewMode;
  onMemoryViewChange: (view: MemoryViewMode) => void;
  backendMode: "local" | "mock";
}

const statusLabel = {
  idle: "",
  running: "运行中",
  completed: "",
  attention: "需要查看",
};

export function ThreadSidebar({
  space,
  projects,
  threads,
  activeProjectId,
  activeThreadId,
  onSelectProject,
  onSelectThread,
  onDeleteThread,
  onCreateThread,
  onChooseWorkspace,
  onOpenCommand,
  recoverableChatBackups,
  onRestoreChatHistory,
  memoryOverview,
  memoryView,
  onMemoryViewChange,
  backendMode,
}: ThreadSidebarProps) {
  const [query, setQuery] = useState("");
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? projects[0];
  const visibleThreads = useMemo(() => {
    if (space === "memory") return [];
    const normalized = query.trim().toLocaleLowerCase();
    return threads.filter(
      (thread) =>
        thread.space === space &&
        thread.projectId === activeProjectId &&
        (!normalized ||
          thread.title.toLocaleLowerCase().includes(normalized) ||
          thread.summary.toLocaleLowerCase().includes(normalized)),
    );
  }, [activeProjectId, query, space, threads]);

  return (
    <aside className="thread-sidebar">
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">{space === "chat" ? "CLEO CHAT" : space === "memory" ? "MEMORY" : "WORKSPACE"}</span>
          <h1>{space === "chat" ? "对话" : space === "memory" ? "记忆" : "开发任务"}</h1>
        </div>
        {space !== "memory" ? (
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
                {space === "chat" && recoverableChatBackups > 0 ? (
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
                ) : (
                  <span className="sidebar-actions-empty">没有可恢复的历史记录</span>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {space === "memory" ? (
        <MemorySidebar overview={memoryOverview} activeView={memoryView} onViewChange={onMemoryViewChange} />
      ) : (
        <>
          <div className="project-picker-wrap">
            <button
              className="project-picker"
              type="button"
              aria-expanded={projectMenuOpen}
              onClick={() => setProjectMenuOpen((open) => !open)}
            >
              <span className="project-glyph" style={{ "--project-accent": activeProject?.accent } as CSSProperties}>
                {activeProject?.name.slice(0, 1)}
              </span>
              <span className="project-picker-copy">
                <strong>{activeProject?.name}</strong>
                <small>{activeProject?.branch ?? "memory project"}</small>
              </span>
              <ChevronDown size={15} />
            </button>
            {projectMenuOpen ? (
              <div className="project-menu surface-popover">
                {space === "productivity" ? (
                  <button
                    className="project-menu-action"
                    type="button"
                    onClick={() => {
                      setProjectMenuOpen(false);
                      onChooseWorkspace();
                    }}
                    data-testid="choose-workspace"
                  >
                    <span className="project-glyph compact"><FolderOpen size={14} /></span>
                    <span><strong>打开工作目录</strong><small>选择任意本地文件夹</small></span>
                  </button>
                ) : null}
                {projects
                  .filter((project) =>
                    project.space
                      ? project.space === space
                      : space === "chat"
                        ? project.id === "general"
                        : project.id !== "general",
                  )
                  .map((project) => (
                    <button
                      type="button"
                      key={project.id}
                      onClick={() => {
                        onSelectProject(project.id);
                        setProjectMenuOpen(false);
                      }}
                    >
                      <span className="project-glyph compact" style={{ "--project-accent": project.accent } as CSSProperties}>
                        {project.name.slice(0, 1)}
                      </span>
                      <span>
                        <strong>{project.name}</strong>
                        <small>{project.path}</small>
                      </span>
                    </button>
                  ))}
              </div>
            ) : null}
          </div>

          <button className="new-thread-button" type="button" onClick={onCreateThread} data-testid="new-thread">
            <Plus size={16} />
            <span>{space === "chat" ? "新对话" : "新任务"}</span>
            <kbd>Ctrl N</kbd>
          </button>

          <label className="sidebar-search">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索 thread"
              aria-label="搜索 thread"
            />
            <button type="button" onClick={onOpenCommand} title="命令面板">
              <kbd>Ctrl K</kbd>
            </button>
          </label>

          <div className="thread-list" data-testid="thread-list">
            <div className="list-section-label">最近</div>
            {visibleThreads.length ? (
              visibleThreads.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  active={thread.id === activeThreadId}
                  onClick={() => onSelectThread(thread.id)}
                  onDelete={() => onDeleteThread(thread)}
                />
              ))
            ) : (
              <div className="sidebar-empty">
                <FileClock size={20} />
                <span>{query ? "没有匹配的 thread" : "这个项目还没有 thread"}</span>
              </div>
            )}
          </div>
        </>
      )}

      <footer className="sidebar-footer">
        <span className="connection-pulse" />
        <span>本地运行时</span>
        <small>{backendMode === "local" ? "connected" : "mock"}</small>
      </footer>
    </aside>
  );
}

function ThreadRow({
  thread,
  active,
  onClick,
  onDelete,
}: {
  thread: Thread;
  active: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`thread-row ${active ? "active" : ""}`}
      data-status={thread.status}
    >
      <button className="thread-row-select" type="button" onClick={onClick}>
        <span className="thread-status-dot" />
        <span className="thread-copy">
          <span className="thread-title-line">
            <strong>{thread.title}</strong>
            <time>{thread.updatedAt}</time>
          </span>
          <span className="thread-summary">{thread.summary}</span>
          {statusLabel[thread.status] ? (
            <span className={`thread-status-label ${thread.status}`}>
              {thread.status === "attention" ? <CircleAlert size={11} /> : null}
              {statusLabel[thread.status]}
            </span>
          ) : null}
        </span>
      </button>
      <button
        className="thread-delete-button"
        type="button"
        aria-label={`删除 ${thread.title}`}
        title={thread.status === "running" ? "请先停止运行" : "删除 thread"}
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
      <div className="dream-status">
        <span className="dream-orbit" />
        <div>
          <strong>DreamAgent</strong>
          <small>{overview.dream_agent.last_processed_at ? "已完成最近整理" : "等待首次整理"}</small>
        </div>
      </div>
    </div>
  );
}
