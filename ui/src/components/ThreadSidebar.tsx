import { t as tr } from "../../electron/i18n.mjs";
import { modifierKey } from "../platform";
import { harnessLabel, isGeneralProject, projectLabel, projectsInSpace } from "../runtime-labels";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Brain,
  CornerDownRight,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileClock,
  Folder,
  FolderOpen,
  GitBranch,
  History,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  SquarePen,
  Trash2,
} from "lucide-react";
import type { Project, Thread, ThreadSpace, WorkspaceSpace } from "../types";

export type SidebarView = WorkspaceSpace | "evolution";

interface ThreadSidebarProps {
  /** What the main pane shows; the matching nav entry or thread is highlighted. */
  view: SidebarView;
  projects: Project[];
  threads: Thread[];
  activeProjectId: string;
  activeThreadId: string | null;
  /** Start an empty draft in a folder project (the "+" on its header). */
  onStartThread: (projectId: string) => void;
  onRemoveProject: (project: Project) => void;
  /** Remove a Cleo worktree (folder and project); offered on worktree folders only. */
  onRemoveWorktree?: (project: Project) => void;
  onSelectThread: (threadId: string) => void;
  onDeleteThread: (thread: Thread) => void;
  /** Start an empty draft of the kind on screen (development task, or chat while a chat is open). */
  onCreateThread: () => void;
  /** Start an empty development task, whatever kind is on screen. */
  onCreateDevTask: () => void;
  /** Start an empty chat with Cleo. */
  onCreateChat: () => void;
  onOpenSearch: () => void;
  onOpenMemory: () => void;
  onOpenEvolution: () => void;
  onOpenSettings: () => void;
  /** Memory sources waiting for consolidation, shown on the Memory entry. */
  memoryPending?: number;
  evolutionUnread?: boolean;
  recoverableChatBackups: number;
  onRestoreChatHistory: () => void;
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
  /** Cleo worktrees of this project, shown as nested folders. */
  worktrees: FolderGroup[];
}

/** Waiting on the user (approval, answer) or stopped needing a look. */
function needsYou(thread: Thread) {
  return Boolean(thread.waitingFor) || thread.status === "attention";
}

function isActive(thread: Thread) {
  return thread.status === "running" || needsYou(thread);
}

const WORKTREE_MARK = "/.cleo/worktrees/";
/** The repository a Cleo worktree belongs to, from its path (`<repo>/.cleo/worktrees/<slug>`). */
function worktreeParentPath(project: Project) {
  const path = project.path.replaceAll("\\", "/");
  const at = path.indexOf(WORKTREE_MARK);
  return at > 0 ? path.slice(0, at) : null;
}

/** Purpose: The one navigation column. Primary actions and the two secondary destinations
 * (memory, self-evolution) sit at the top; below, every conversation is listed exactly once:
 * work that is running or waiting on the user under "in progress" (with its project named),
 * everything else under development tasks grouped by project, then chats with Cleo. Rows stay
 * flat; indentation alone shows what belongs where.
 */
export function ThreadSidebar({
  view,
  projects,
  threads,
  activeProjectId,
  activeThreadId,
  onStartThread,
  onRemoveProject,
  onRemoveWorktree,
  onSelectThread,
  onDeleteThread,
  onCreateThread,
  onCreateDevTask,
  onCreateChat,
  onOpenSearch,
  onOpenMemory,
  onOpenEvolution,
  onOpenSettings,
  memoryPending = 0,
  evolutionUnread = false,
  recoverableChatBackups,
  onRestoreChatHistory,
  backendMode,
  unreadThreadIds = [],
}: ThreadSidebarProps) {
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<string[]>(readCollapsed);
  const [expanded, setExpanded] = useState<string[]>([]);
  // Closing a folder or section forgets its "显示更多", so it reopens on the short list.
  const toggleCollapsed = (id: string) => {
    if (!collapsed.includes(id)) setExpanded((current) => current.filter((value) => value !== id));
    setCollapsed((current) => {
      const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
      return next;
    });
  };
  const threadView = view === "chat" || view === "productivity";
  const draftSpace: ThreadSpace | null = threadView && activeThreadId === null ? view : null;
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  // Landing in a collapsed folder or section (a thread, or a draft started there) opens it.
  useEffect(() => {
    const space = activeThread?.space ?? draftSpace;
    for (const id of [activeProjectId, space ? `section:${space}` : ""]) {
      if (id && collapsed.includes(id)) toggleCollapsed(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, activeThreadId, draftSpace]);

  // Subtasks that subtask routing delegated (they carry a routing task id) are listed under the
  // conversation that started them, at any depth, never as tasks of their own. A fork also records
  // its parent but is the user's own task, so it stays a normal row; so does a subtask whose
  // parent is not listed.
  const { childrenOf, topLevel } = useMemo(() => {
    const ids = new Set(threads.map((thread) => thread.id));
    const children = new Map<string, Thread[]>();
    for (const thread of threads) {
      if (!thread.parentId || !thread.routingTaskId || !ids.has(thread.parentId) || thread.parentId === thread.id) continue;
      children.set(thread.parentId, [...children.get(thread.parentId) ?? [], thread]);
    }
    const nestedIds = new Set([...children.values()].flat().map((thread) => thread.id));
    return { childrenOf: children, topLevel: threads.filter((thread) => !nestedIds.has(thread.id)) };
  }, [threads]);
  const sections = useMemo(() => (["productivity", "chat"] as const).map((space) => {
    const ordered = projectsInSpace(projects, space);
    const folderProjects = ordered.filter((project) => !isGeneralProject(project));
    const folderIds = new Set(folderProjects.map((project) => project.id));
    // Work that is running or waiting on the user is listed once, at the top, until it settles.
    const inSpace = topLevel.filter((thread) => thread.space === space && !isActive(thread));
    // Folder-less threads, and threads whose folder is no longer listed, are plain rows.
    const loose = inSpace.filter((thread) => !folderIds.has(thread.projectId));
    const group = (project: Project): FolderGroup => ({
      project, threads: inSpace.filter((thread) => thread.projectId === project.id), worktrees: [],
    });
    const normalized = (project: Project) => project.path.replaceAll("\\", "/").replace(/\/+$/, "");
    const parents = new Map(folderProjects.map((project) => [normalized(project), project.id]));
    const groups = new Map(folderProjects.map((project) => [project.id, group(project)]));
    // A Cleo worktree nests under the project it came from instead of becoming another top-level folder.
    for (const project of folderProjects) {
      const parentId = parents.get(worktreeParentPath(project) ?? "");
      if (parentId && parentId !== project.id) groups.get(parentId)!.worktrees.push(groups.get(project.id)!);
    }
    const nested = new Set([...groups.values()].flatMap((entry) => entry.worktrees.map((child) => child.project.id)));
    const folders = folderProjects.filter((project) => !nested.has(project.id)).map((project) => groups.get(project.id)!);
    return { space, loose, folders, count: inSpace.length };
  }), [projects, topLevel]);
  const waitingOnYou = useMemo(() => topLevel.filter(needsYou), [topLevel]);
  const running = useMemo(() => topLevel.filter((thread) => thread.status === "running" && !needsYou(thread)), [topLevel]);
  /** The subtasks of one conversation, indented under its row; a subtask's own subtasks nest below it. */
  const renderChildren = (parent: Thread, depth = 0): ReactNode => {
    const children = childrenOf.get(parent.id);
    if (!children?.length || depth > 6) return null;
    return (
      <div className="thread-children" role="group" aria-label={tr("sidebar.subtasks_of_value", { p0: parent.title })}>
        {children.map((child) => (
          <Fragment key={child.id}>
            <ThreadRow thread={child} child active={threadView && child.id === activeThreadId}
              unread={unreadThreadIds.includes(child.id)} onClick={() => onSelectThread(child.id)} onDelete={() => onDeleteThread(child)} />
            {renderChildren(child, depth + 1)}
          </Fragment>
        ))}
      </div>
    );
  };
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  const renderFolder = (group: FolderGroup, space: ThreadSpace, noun: string, draftProject: Project | undefined, worktree: boolean): ReactNode => {
    const folderLabel = worktree ? (group.project.branch ?? projectLabel(group.project)) : projectLabel(group.project);
    const open = !collapsed.includes(group.project.id);
    const draftHere = draftSpace === space && draftProject?.id === group.project.id;
    return (
      <section className={`folder-group ${worktree ? "worktree-group" : ""}`} key={group.project.id} data-project-id={group.project.id} aria-label={folderLabel}>
        <div className="folder-group-header">
          <button className="folder-group-toggle" type="button" aria-expanded={open} title={group.project.path}
            onClick={() => toggleCollapsed(group.project.id)}>
            {worktree ? <GitBranch size={13} /> : open ? <FolderOpen size={14} /> : <Folder size={14} />}
            <strong>{folderLabel}</strong>
            {worktree ? <small className="worktree-badge">{tr("sidebar.worktree")}</small>
              : group.project.branch ? (
                <small title={group.project.dirtyFiles ? tr("threadsidebar.value_value_changed_files", { p0: group.project.branch, p1: group.project.dirtyFiles }) : group.project.branch}>
                  {group.project.branch}{group.project.dirtyFiles ? ` · ${group.project.dirtyFiles}` : ""}
                </small>
              ) : null}
          </button>
          <div className="folder-group-actions">
            <button type="button" aria-label={tr("threadsidebar.create_a_new_value_in_value", { p0: folderLabel, p1: noun })}
              title={tr("threadsidebar.create_a_new_value_in_value", { p0: folderLabel, p1: noun })}
              onClick={() => onStartThread(group.project.id)} data-testid="new-thread-in-project">
              <Plus size={14} />
            </button>
            {worktree && onRemoveWorktree ? (
              <button className="folder-group-remove" type="button" aria-label={tr("sidebar.remove_worktree_value", { p0: folderLabel })}
                title={tr("sidebar.remove_worktree_value", { p0: folderLabel })} onClick={() => onRemoveWorktree(group.project)}
                data-testid="remove-worktree">
                <Trash2 size={13} />
              </button>
            ) : group.project.removable ? (
              <button className="folder-group-remove" type="button" aria-label={tr("threadsidebar.remove_project_value", { p0: folderLabel })}
                title={tr("threadsidebar.remove_project_without_deleting_local_files")} onClick={() => onRemoveProject(group.project)}>
                <Trash2 size={13} />
              </button>
            ) : null}
          </div>
        </div>
        {open ? (
          <div className="thread-nested">
            {draftHere ? <DraftRow noun={noun} /> : null}
            {group.threads.length ? renderRows(group.project.id, group.threads, FOLDER_LIMIT)
              : draftHere || group.worktrees.length ? null : <div className="folder-empty">{tr("threadsidebar.no_value_yet", { p0: noun })}</div>}
            {group.worktrees.map((child) => renderFolder(child, space, noun, draftProject, true))}
          </div>
        ) : null}
      </section>
    );
  };

  const renderRows = (id: string, rows: Thread[], limit: number) => (
    <ThreadRows
      id={id}
      threads={rows}
      limit={limit}
      expanded={expanded}
      onExpand={(value) => setExpanded((current) => [...current, value])}
      activeThreadId={threadView ? activeThreadId : null}
      unreadThreadIds={unreadThreadIds}
      onSelectThread={onSelectThread}
      onDeleteThread={onDeleteThread}
      renderChildren={renderChildren}
    />
  );

  return (
    <aside className="thread-sidebar" aria-label={tr("sidebar.navigation")}>
      <nav className="sidebar-nav" aria-label={tr("sidebar.navigation")}>
        <button className="sidebar-nav-item primary" type="button" onClick={onCreateThread} data-testid="new-thread">
          <SquarePen size={15} />
          <span>{view === "chat" ? tr("conversation.new_chat") : tr("conversation.new_task")}</span>
          <kbd>{modifierKey} N</kbd>
        </button>
        <button className="sidebar-nav-item" type="button" onClick={onOpenSearch} data-testid="open-search">
          <Search size={15} />
          <span>{tr("sidebar.search")}</span>
          <kbd>{modifierKey} K</kbd>
        </button>
        <button className={`sidebar-nav-item ${view === "memory" ? "active" : ""}`} type="button" onClick={onOpenMemory}
          aria-current={view === "memory" ? "page" : undefined} aria-label={tr("app.memory")}>
          <Brain size={15} />
          <span>{tr("app.memory")}</span>
          {memoryPending ? <small title={tr("memoryview.pending_sources")}>{memoryPending}</small> : null}
        </button>
        <button className={`sidebar-nav-item ${view === "evolution" ? "active" : ""}`} type="button" onClick={onOpenEvolution}
          aria-current={view === "evolution" ? "page" : undefined} aria-label={tr("app.evolution")} title={tr("sidebar.evolution_hint")}
          data-unread={evolutionUnread || undefined}>
          <GitBranch size={15} />
          <span>{tr("app.evolution")}</span>
        </button>
      </nav>

      <div className="thread-list" data-testid="thread-list">
        {([["section:attention", tr("sidebar.needs_you"), waitingOnYou], ["section:working", tr("sidebar.running"), running]] as const)
          .map(([id, label, rows]) => rows.length ? (
            <SidebarSection key={id} id={id} label={label} count={rows.length}
              collapsed={collapsed.includes(id)} onToggle={() => toggleCollapsed(id)}>
              {rows.map((thread) => (
                <Fragment key={`${id}-${thread.id}`}>
                  <ThreadRow
                    thread={thread}
                    context={projectLabel(projectById.get(thread.projectId)) || (thread.space === "chat" ? tr("app.chat") : "")}
                    active={threadView && thread.id === activeThreadId}
                    unread={unreadThreadIds.includes(thread.id)}
                    onClick={() => onSelectThread(thread.id)}
                    onDelete={() => onDeleteThread(thread)}
                  />
                  {renderChildren(thread)}
                </Fragment>
              ))}
            </SidebarSection>
          ) : null)}

        {sections.map(({ space, loose, folders, count }) => {
          const sectionId = `section:${space}`;
          const label = space === "chat" ? tr("app.chat") : tr("app.development");
          const noun = space === "chat" ? tr("app.chat") : tr("computerpanel.task");
          const draftProject = draftSpace === space ? projects.find((project) => project.id === activeProjectId) : undefined;
          const draftIsLoose = draftSpace === space && (!draftProject || isGeneralProject(draftProject));
          const empty = !count && draftSpace !== space;
          return (
            <SidebarSection key={space} id={sectionId} label={label} count={count}
              collapsed={collapsed.includes(sectionId)} onToggle={() => toggleCollapsed(sectionId)}
              action={space === "chat" ? (
                <button type="button" onClick={onCreateChat} aria-label={tr("conversation.new_chat")} title={tr("conversation.new_chat")}
                  data-testid="new-chat"><Plus size={14} /></button>
              ) : (
                <button type="button" onClick={onCreateDevTask} aria-label={tr("conversation.new_task")} title={tr("conversation.new_task")}
                  data-testid="new-task-in-section"><Plus size={14} /></button>
              )}
              menu={space === "chat" && recoverableChatBackups > 0 ? (
                <div className="sidebar-actions-wrap">
                  <button type="button" aria-label={tr("conversation.more")} title={tr("conversation.more")}
                    aria-expanded={actionsMenuOpen} onClick={() => setActionsMenuOpen((open) => !open)}>
                    <MoreHorizontal size={14} />
                  </button>
                  {actionsMenuOpen ? (
                    <div className="sidebar-actions-menu surface-popover">
                      <button type="button" onClick={() => { setActionsMenuOpen(false); onRestoreChatHistory(); }}>
                        <History size={15} />
                        <span>
                          <strong>{tr("threadsidebar.restore_previous_chats")}</strong>
                          <small>{tr("threadsidebar.found")}{recoverableChatBackups} {tr("threadsidebar.recoverable_records")}</small>
                        </span>
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}>
              {folders.map((group) => renderFolder(group, space, noun, draftProject, false))}
              {folders.length && (loose.length || draftIsLoose) ? <div className="list-section-label">{tr("threadsidebar.standalone_value", { p0: noun })}</div> : null}
              {draftIsLoose ? <DraftRow noun={noun} /> : null}
              {renderRows(`loose:${space}`, loose, TOP_LIMIT)}
              {empty && !folders.length ? (
                <div className="sidebar-empty">
                  <FileClock size={16} />
                  <span>{tr("threadsidebar.no_value_yet", { p0: noun })}</span>
                </div>
              ) : null}
            </SidebarSection>
          );
        })}
      </div>

      <footer className="sidebar-footer">
        <button className="sidebar-nav-item" type="button" onClick={onOpenSettings} aria-label={tr("overlays.settings")}>
          <Settings2 size={15} />
          <span>{tr("overlays.settings")}</span>
        </button>
        {backendMode === "mock" && <span className="sidebar-mode-badge">{tr("threadsidebar.demo_mode")}</span>}
      </footer>
    </aside>
  );
}

function SidebarSection({ id, label, count, collapsed, onToggle, action, menu, children }: {
  id: string;
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  action?: ReactNode;
  menu?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="sidebar-section" data-section={id} aria-label={label}>
      <div className="sidebar-section-header">
        <button type="button" className="sidebar-section-toggle" aria-expanded={!collapsed} onClick={onToggle}>
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span>{label}</span>
          {count ? <small>{count}</small> : null}
        </button>
        <div className="sidebar-section-actions">{menu}{action}</div>
      </div>
      {collapsed ? null : <div className="sidebar-section-body">{children}</div>}
    </section>
  );
}

/** The unsent draft reads as the row it is about to become; it scrolls into view so a draft
 * parked below long folders is never out of sight. */
function DraftRow({ noun }: { noun: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollIntoView({ block: "nearest" }); }, []);
  return (
    <div className="thread-draft-row" aria-current="true" data-testid="draft-row" ref={ref}>
      <span className="thread-title-line"><strong>{tr("threadsidebar.unsent_value", { p0: noun })}</strong></span>
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
  renderChildren,
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
  renderChildren?: (parent: Thread) => ReactNode;
}) {
  // The selected thread is never hidden behind "显示更多": past the limit it is listed on its
  // own, after the short list, rather than unfolding every row.
  const activeIndex = threads.findIndex((thread) => thread.id === activeThreadId);
  const shown = expanded.includes(id) ? threads
    : activeIndex >= limit ? [...threads.slice(0, limit), threads[activeIndex]] : threads.slice(0, limit);
  return (
    <>
      {shown.map((thread) => (
        <Fragment key={thread.id}>
          <ThreadRow
            thread={thread}
            active={thread.id === activeThreadId}
            unread={unreadThreadIds.includes(thread.id)}
            onClick={() => onSelectThread(thread.id)}
            onDelete={() => onDeleteThread(thread)}
          />
          {renderChildren?.(thread)}
        </Fragment>
      ))}
      {shown.length < threads.length ? (
        <button className="thread-more" type="button" onClick={() => onExpand(id)}>
          {tr("threadsidebar.show_more_value", { p0: threads.length - shown.length })}
        </button>
      ) : null}
    </>
  );
}

function ThreadRow({
  thread,
  context,
  child = false,
  active,
  unread = false,
  onClick,
  onDelete,
}: {
  thread: Thread;
  /** Where the thread lives, shown in the "in progress" list where rows leave their folders.
   * Such rows take two lines, so the title is never squeezed by the project and state. */
  context?: string;
  /** A delegated subtask, indented under its parent with its harness and model. */
  child?: boolean;
  active: boolean;
  unread?: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  // Chats show no harness: their model name is noise next to a title; tasks show Codex/Claude.
  const harness = thread.space === "chat" ? "" : harnessLabel(thread.runtime, thread.space);
  const status = thread.waitingFor ? "attention" : thread.status;
  const hint = [thread.summary, thread.runtime?.model
    ? `${thread.runtime.provider} · ${thread.runtime.model}` : harness, thread.updatedAt].filter(Boolean).join(" · ");
  const stateLabel = thread.waitingFor === "approval" ? tr("threadsidebar.awaiting_approval")
    : thread.waitingFor === "question" ? tr("conversation.waiting_for_an_answer")
    : thread.status === "running" ? tr("conversation.running")
    : thread.status === "attention" ? tr("threadsidebar.needs_attention")
    : unread ? tr("threadsidebar.new_reply") : "";
  const childModel = child ? [thread.runtime?.provider, thread.runtime?.model].filter(Boolean).join(" · ") : "";
  return (
    <div
      className={`thread-row ${active ? "active" : ""} ${unread ? "unread" : ""} ${context ? "two-line" : ""} ${child ? "child-row" : ""}`}
      data-status={status}
      data-unread={unread || undefined}
      data-testid={child ? "subtask-row" : undefined}
    >
      <button className="thread-row-select" type="button" onClick={onClick} title={hint}
        aria-label={stateLabel ? `${thread.title}（${stateLabel}）` : undefined}>
        {/* Status sits before the title so running and waiting rows read at a glance. */}
        <span className="thread-meta" title={stateLabel || undefined}>
          {child && status !== "running" && status !== "attention" ? <CornerDownRight size={12} className="thread-child-mark" />
            : status === "running" ? <span className="thread-status-dot" />
            : status === "attention" ? <CircleAlert size={13} />
            : unread ? <span className="thread-unread-dot" /> : null}
        </span>
        <span className="thread-title-line"><strong>{thread.title}</strong></span>
        {/* Work that needs the user or is still running says so in words, not only with a dot. */}
        {context ? (
          <span className="thread-subline">
            <small className="thread-context">{context}</small>
            {stateLabel ? <small className={`thread-state ${status}`}>{stateLabel}</small> : null}
          </span>
        ) : status === "running" || status === "attention"
          ? <small className={`thread-state ${status}`}>{stateLabel}</small>
          : harness ? <small className="thread-harness" title={childModel || undefined}>{harness}</small> : null}
      </button>
      <button
        className="thread-delete-button"
        type="button"
        aria-label={tr("threadsidebar.delete_value", { p0: thread.title })}
        title={thread.status === "running" ? tr("threadsidebar.stop_the_run_first") : tr("threadsidebar.delete_task")}
        disabled={thread.status === "running"}
        onClick={onDelete}
        data-testid="delete-thread"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}
