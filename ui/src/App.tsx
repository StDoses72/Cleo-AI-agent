import { t as tr } from "../electron/i18n.mjs";
import { DependencySetup } from "./components/DependencySetup";
import { modifierKey } from "./platform";
import { QuestionDialog } from "./components/QuestionDialog";
import { EvolutionPanel } from "./components/EvolutionPanel";
import { useEvolution } from "./useEvolution";
import { useInspectorResize } from "./useInspectorResize";
import "./components/evolution.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { renderBadge } from "./badge";
import { harnessLabel, projectLabel } from "./runtime-labels";
import { Conversation } from "./components/Conversation";
import { Inspector, noteVersion, type InspectorTab } from "./components/Inspector";
import { reviewCommentsPrompt, type ReviewComment } from "./components/ReviewActions";
import { isComputerTool } from "./components/ComputerPanel";
import type { FileReveal } from "./components/FilesPanel";
import { MemoryView } from "./components/MemoryView";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import {
  CommandPalette,
  DeleteThreadDialog,
  LoadingScreen,
  RemoveProjectDialog,
  SettingsModal,
  Toast,
  ConfigNotice,
  UpdateNotice,
  commandIcons,
  type CommandAction,
} from "./components/Overlays";
import { ThreadSidebar } from "./components/ThreadSidebar";
import { projectBranchName, useCleoWorkspace } from "./useCleoWorkspace";
import { cleoClient } from "./services/cleoClient";
import { useLanguage, setLanguage, type UiLanguage } from "./i18n";
import type { ConfigStatus, MemoryViewMode, Project, RepositoryFiles, Thread, UpdateState, WorkspaceSpace } from "./types";

export function App() {
  const language = useLanguage();
  const changeLanguage = async (value: UiLanguage) => {
    setLanguage(await cleoClient.setUiLanguage(value));
    await workspace.refreshLanguage();
  };
  const evolution = useEvolution();
  const [evolutionOpen, setEvolutionOpen] = useState(() => localStorage.getItem("cleo-view") === "evolution");
  const workspace = useCleoWorkspace(evolutionOpen);
  // Actions that must run against the workspace view (not evolution) wait until evolution has closed,
  // then call the latest hook instance, whose handlers no longer see the evolution view as open.
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const afterLeavingEvolution = useRef<(() => void) | null>(null);
  const inWorkspace = (action: (current: typeof workspace) => void) => {
    if (!evolutionOpen) { action(workspace); return; }
    afterLeavingEvolution.current = () => action(workspaceRef.current);
    setEvolutionOpen(false);
  };
  useEffect(() => {
    if (evolutionOpen || !afterLeavingEvolution.current) return;
    const action = afterLeavingEvolution.current;
    afterLeavingEvolution.current = null;
    action();
  }, [evolutionOpen]);
  const newTask = () => inWorkspace(current => {
    if (current.activeSpace === "memory") current.selectSpace("productivity");
    void current.createThread();
  });
  const newChat = () => inWorkspace(current => {
    current.selectSpace("chat");
    void current.createThread();
  });
  // The "+" on the development section always starts a development task, even while a chat is open.
  const newDevTask = () => inWorkspace(current => {
    current.selectSpace("productivity");
    void current.createThread();
  });
  const openMemory = () => {
    setEvolutionOpen(false);
    setMemoryView("all");
    workspace.selectSpace("memory");
  };
  const openEvolution = () => {
    setEvolutionOpen(true);
    void evolution.refresh().catch(() => {});
  };
  const [improvementDraft, setImprovementDraft] = useState<string | null>(null);
  const openingEvolution = useRef(false);
  const [openingEvolutionUi, setOpeningEvolutionUi] = useState(false);
  const [evolutionIssue, setEvolutionIssue] = useState<string | null>(null);
  const preparingEvolution = useRef(false);
  const [preparingTurn, setPreparingTurn] = useState(false);
  const retryEvolution = useRef<(() => void) | null>(null);
  const evolutionThread = evolutionOpen && Boolean(evolution.state?.threadId)
    && workspace.activeThreadId === evolution.state?.threadId;

  const startEvolution = async (newThread = false): Promise<Thread | null> => {
    if (openingEvolution.current) return null;
    openingEvolution.current = true;
    setOpeningEvolutionUi(true);
    setEvolutionIssue(null);
    try {
      if (!evolution.state?.prepared) await evolution.run("prepare");
      const thread = await workspace.openEvolutionThread(newThread ? null : evolution.state?.threadId);
      await evolution.run("thread", { id: thread.id });
      return thread;
    } catch (error) {
      setEvolutionIssue(error instanceof Error ? error.message : tr("app.could_not_open_the_evolution_chat"));
      return null;
    } finally {
      openingEvolution.current = false;
      setOpeningEvolutionUi(false);
    }
  };
  /** Purpose: Send ordinary instructions directly to the selected evolution harness.
   * Input: user text and optional existing task. Output: one coding turn, no acceptance planning.
   */
  const sendEvolutionPrompt = async (prompt: string, preserveDraft = false, threadId?: string) => {
    if (!prompt.trim() || preparingEvolution.current) return;
    preparingEvolution.current = true;
    setPreparingTurn(true);
    setEvolutionIssue(null);
    try {
      const thread = threadId ? await workspace.openEvolutionThread(threadId)
        : evolutionThread ? workspace.activeThread : await startEvolution(true);
      if (!thread) return;
      retryEvolution.current = () => { void sendEvolutionPrompt(prompt, true, thread.id); };
      await evolution.run("thread", { id: thread.id });
      await workspace.sendPrompt(prompt, thread, { preserveDraft });
    } catch (error) {
      setEvolutionIssue(error instanceof Error ? error.message : tr("app.could_not_start_editing"));
    } finally { preparingEvolution.current = false; setPreparingTurn(false); await evolution.refresh(); }
  };
  /** Purpose: Return compiler/runtime diagnostics to the same agent. Input: none. Output: repair turn. */
  const repairEvolution = async () => {
    retryEvolution.current = () => { void repairEvolution(); };
    try {
      const prompt = await evolution.run<string>("repairPrompt");
      await sendEvolutionPrompt(prompt, true, evolution.state?.threadId || undefined);
    } catch (error) { setEvolutionIssue(error instanceof Error ? error.message : tr("app.could_not_start_the_repair")); }
  };
  const evolutionAction = (action: string, params: Record<string, unknown> = {}) => {
    if (["releasePermission", "previewMergedRelease", "contributionBranches", "checkContribution", "mergeAssistance", "releases"].includes(action)) return evolution.inspect(action, params);
    retryEvolution.current = () => evolutionAction(action, params);
    setEvolutionIssue(null);
    if (action === "repairContribution") {
      return evolution.run<string>("contributionRepairPrompt", params).then(async (prompt) => {
        setEvolutionOpen(true);
        await sendEvolutionPrompt(prompt, true);
      }).catch((error: unknown) => setEvolutionIssue(error instanceof Error ? error.message : tr("app.could_not_start_the_pr_repair")));
    }
    return evolution.run(action, params).then((result) => {
      if (action === "discard" || action === "select") workspace.beginEvolutionDraft();
      return result;
    }).catch((error: unknown) => {
      setEvolutionIssue(error instanceof Error ? error.message : tr("app.operation_failed"));
      if (["previewRelease", "publishRelease", "publishMergedRelease", "previewMergedRelease", "releaseBuilds", "publishReleasePackages", "releasePackageStatus", "releasePermission", "startRelease", "submit", "requestBranch"].includes(action)) throw error;
    });
  };

  useEffect(() => {
    if (!evolutionOpen || !improvementDraft) return;
    workspace.setPrompt(improvementDraft);
    setImprovementDraft(null);
  }, [evolutionOpen, improvementDraft]);

  useEffect(() => {
    localStorage.setItem("cleo-view", evolutionOpen ? "evolution" : "workspace");
  }, [evolutionOpen]);
  useEffect(() => {
    if (evolutionOpen && workspace.snapshot && evolution.state && !evolution.state.threadId
        && !openingEvolution.current && !preparingEvolution.current) workspace.beginEvolutionDraft();
  }, [evolutionOpen, Boolean(workspace.snapshot), evolution.state?.threadId]);
  useEffect(() => {
    if (workspace.snapshot) void window.cleoDesktop?.confirmHealthy().then(() => evolution.refresh()).catch(() => {});
  }, [Boolean(workspace.snapshot)]);
  useEffect(() => {
    if (evolutionOpen && workspace.snapshot && evolution.state?.prepared && evolution.state.threadId && !evolutionThread
        && !openingEvolution.current && !preparingEvolution.current && !evolutionIssue) {
      void startEvolution();
    }
  }, [evolutionOpen, Boolean(workspace.snapshot), evolution.state?.prepared, evolution.state?.threadId,
    openingEvolutionUi, preparingTurn]);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [compactColumns, setCompactColumns] = useState(() => window.matchMedia("(max-width: 1010px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1010px)");
    const changed = () => setCompactColumns(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  // The details panel's open/closed choice is remembered per kind of conversation.
  const [inspectorBySpace, setInspectorBySpace] = useState(() => {
    const fallback = { chat: false, productivity: true, evolution: false };
    try { return { ...fallback, ...JSON.parse(localStorage.getItem("cleo-inspector") ?? "{}") } as typeof fallback; } catch { return fallback; }
  });
  const inspectorSpace = evolutionOpen ? "evolution" : workspace.activeSpace === "chat" ? "chat" : "productivity";
  // An unsent draft has nothing to inspect, so it starts with the panel closed; opening it there
  // does not change the remembered choice for saved tasks.
  const drafting = !evolutionOpen && workspace.activeSpace !== "memory" && Boolean(workspace.snapshot) && !workspace.activeThread;
  const [draftInspectorOpen, setDraftInspectorOpen] = useState(false);
  useEffect(() => { if (drafting) setDraftInspectorOpen(false); }, [drafting, workspace.activeProjectId]);
  const inspectorOpen = drafting ? draftInspectorOpen : inspectorBySpace[inspectorSpace];
  const setInspectorOpen = (value: boolean | ((open: boolean) => boolean)) => {
    if (drafting) {
      setDraftInspectorOpen((current) => typeof value === "function" ? value(current) : value);
      return;
    }
    setInspectorBySpace((current) => {
      const next = { ...current, [inspectorSpace]: typeof value === "function" ? value(current[inspectorSpace]) : value };
      // Only the user's own open/close is remembered; automatic changes (compact windows) are not.
      try { localStorage.setItem("cleo-inspector", JSON.stringify(next)); } catch { /* per-viewer convenience */ }
      return next;
    });
  };
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("changes");
  // Each conversation opens on what matters for it: its changes if it has any, otherwise its run details.
  const inspectedThreadId = workspace.activeThread?.id ?? null;
  const inspectedChanges = workspace.activeThread?.changes.length ?? 0;
  // A tab the user picked for this conversation is kept; otherwise new changes bring Changes forward.
  const tabChosenFor = useRef<string | null>(null);
  const chooseInspectorTab = (tab: InspectorTab) => { tabChosenFor.current = inspectedThreadId; setInspectorTab(tab); };
  useEffect(() => {
    tabChosenFor.current = null;
    setInspectorTab(current => current === "computer" && computerRunRef.current ? current
      : workspace.activeThread?.changes.length ? "changes" : "details");
  }, [inspectedThreadId]);
  useEffect(() => {
    if (inspectedChanges && tabChosenFor.current !== inspectedThreadId) setInspectorTab(current => current === "details" ? "changes" : current);
  }, [inspectedChanges]);
  const [fileReveal, setFileReveal] = useState<FileReveal | null>(null);
  const [changeReveal, setChangeReveal] = useState<{ path: string; nonce: number } | null>(null);
  const previewOpenedFor = useRef<string | null>(null);
  const computerRun = workspace.running && workspace.activeThread?.items.some(
    item => isComputerTool(item) && item.status === "running",
  ) ? `${workspace.activeThread.id}:${workspace.activeThread.activeRunId ?? workspace.activeThread.items.filter(item => item.type === "message" && item.role === "user").at(-1)?.id}` : null;
  const computerRunRef = useRef(computerRun);
  computerRunRef.current = computerRun;
  useEffect(() => {
    if (!computerRun || previewOpenedFor.current === computerRun) return;
    let cancelled = false;
    // Browser tasks show the shared built-in browser; local-computer tasks act on real windows.
    const threadId = computerRun.split(":")[0];
    void window.cleoDesktop?.computer?.("state").then(state => {
      if (cancelled) return;
      previewOpenedFor.current = computerRun;
      if (state.threads[threadId]?.mode === "host") return;
      setInspectorTab("computer");
      setInspectorBySpace(current => ({ ...current, [inspectorSpace]: true }));
    }).catch(() => { /* The task timeline reports connection failures. */ });
    return () => { cancelled = true; };
  }, [computerRun, inspectorSpace]);
  const showInspector = inspectorOpen && (evolutionOpen || workspace.activeSpace !== "memory");
  const sidebarHidden = sidebarCollapsed || (compactColumns && showInspector);
  const inspectorResize = useInspectorResize(`${sidebarHidden}:${evolutionOpen}`, showInspector);
  const [commandOpen, setCommandOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [threadPendingDeletion, setThreadPendingDeletion] = useState<Thread | null>(null);
  const [deletingThread, setDeletingThread] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [projectPendingRemoval, setProjectPendingRemoval] = useState<Project | null>(null);
  const [removingProject, setRemovingProject] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [undoingChanges, setUndoingChanges] = useState(false);
  const [memoryView, setMemoryView] = useState<MemoryViewMode>("all");
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    localStorage.getItem("cleo-theme") === "dark" ? "dark" : "light",
  );
  const [motionEnabled, setMotionEnabled] = useState(() => localStorage.getItem("cleo-motion") !== "reduced");
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  // Review notes per conversation, kept until they are sent to the agent or discarded.
  // Review notes survive a restart on this device (they are the reviewer's drafts, not shared data).
  const [reviewComments, setReviewComments] = useState<Record<string, ReviewComment[]>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem("cleo-review-notes") ?? "{}");
      return saved && typeof saved === "object" && !Array.isArray(saved) ? saved as Record<string, ReviewComment[]> : {};
    } catch { return {}; }
  });
  useEffect(() => {
    try {
      const kept = Object.fromEntries(Object.entries(reviewComments).filter(([, notes]) => notes.length));
      localStorage.setItem("cleo-review-notes", JSON.stringify(kept));
    } catch { /* a convenience only; notes still work for this session */ }
  }, [reviewComments]);
  // Whether the unsent draft should start in a new git worktree.
  const [isolateDraft, setIsolateDraft] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>({
    phase: window.cleoDesktop ? "idle" : "unsupported",
    currentVersion: "dev",
    latestVersion: null,
    downloadedBytes: 0,
    totalBytes: 0,
    error: null,
  });
  const localCandidate = evolution.state?.builds.find(build => build.id === evolution.state?.candidate);
  const unfinishedEvolution = evolution.state?.iteration || evolution.state?.draftDirty
    || (localCandidate?.kind === "local" && !localCandidate.savedAt);
  const displayedUpdateState: UpdateState = { ...updateState,
    installBlocked: workspace.anyRunning ? tr("app.wait_for_the_running_tasks_to_finish")
      : unfinishedEvolution ? tr("app.save_or_discard_the_current_evolution_changes_before_installing_an_update") : null,
  };
  const toastTimerRef = useRef<number | null>(null);
  // Configuration edits apply live; surface the ones that did not load or need a restart.
  const [configStatus, setConfigStatus] = useState<ConfigStatus | null>(null);
  const snapshotConfig = workspace.snapshot?.backend?.config;
  const hotReload = workspace.snapshot?.backend?.hotReload === true;
  useEffect(() => {
    setConfigStatus(snapshotConfig ?? null);
  }, [snapshotConfig?.version, snapshotConfig?.error, snapshotConfig?.restartRequired]);
  const refreshConfigStatus = () => {
    void cleoClient.getConfigStatus().then(setConfigStatus).catch(() => {});
  };
  useEffect(() => {
    if (!hotReload) return;
    // Returning to Cleo after editing a configuration file applies and checks the edit.
    const refresh = () => { if (!document.hidden) refreshConfigStatus(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [hotReload]);

  const notify = (message: string, tone: "success" | "error" = "success") => {
    setToast({ message, tone });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600);
  };

  useEffect(() => window.cleoWindow?.onOpenMemory?.(() => {
    setEvolutionOpen(false);
    setSettingsOpen(false);
    setCommandOpen(false);
    setMemoryView("all");
    workspace.selectSpace("memory");
  }), [workspace.selectSpace]);

  // Finished replies the user has not opened yet show as a count on the app icon.
  useEffect(() => {
    const count = workspace.unreadThreadIds.length;
    window.cleoWindow?.setBadge?.(count, count ? renderBadge(count) : null);
  }, [workspace.unreadThreadIds]);
  // A system notification when a task you are not looking at finishes or starts waiting on you.
  const [notificationsOn, setNotificationsOn] = useState(() => {
    try { return localStorage.getItem("cleo-notify") !== "off"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("cleo-notify", notificationsOn ? "on" : "off"); } catch { /* per-viewer convenience */ }
  }, [notificationsOn]);
  const threadStates = useRef(new Map<string, string>());
  useEffect(() => {
    for (const thread of workspace.snapshot?.threads ?? []) {
      const state = thread.waitingFor ? `waiting:${thread.waitingFor}` : thread.status;
      const before = threadStates.current.get(thread.id);
      threadStates.current.set(thread.id, state);
      if (before !== "running" || state === "running" || !notificationsOn || typeof Notification === "undefined") continue;
      const watching = !document.hidden && document.hasFocus() && thread.id === workspace.activeThreadId;
      if (watching) continue;
      const body = state === "waiting:approval" ? tr("notify.needs_approval") : state === "waiting:question" ? tr("notify.needs_answer")
        : state === "attention" ? tr("notify.needs_attention") : tr("notify.finished");
      const show = () => {
        const notice = new Notification(thread.title, { body, tag: `cleo-${thread.id}` });
        notice.onclick = () => { window.focus(); setEvolutionOpen(false); workspaceRef.current.selectThread(thread.id); };
      };
      if (Notification.permission === "granted") show();
      else if (Notification.permission === "default") void Notification.requestPermission().then(result => { if (result === "granted") show(); });
    }
  }, [workspace.snapshot?.threads, notificationsOn]);
  // Unread evolution replies mark the sidebar's evolution entry; other threads carry their own dot.
  const unreadSpaces = useMemo(() => {
    const spaces = new Set<WorkspaceSpace | "evolution">();
    for (const id of workspace.unreadThreadIds) {
      const thread = workspace.snapshot?.threads.find(item => item.id === id);
      if (thread) spaces.add(thread.projectId === "productivity:cleo-evolution" ? "evolution" : thread.space);
    }
    return spaces;
  }, [workspace.unreadThreadIds, workspace.snapshot?.threads]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cleo-theme", theme);
    window.cleoWindow?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    const motion = motionEnabled ? "full" : "reduced";
    document.documentElement.dataset.motion = motion;
    localStorage.setItem("cleo-motion", motion);
  }, [motionEnabled]);

  useEffect(() => {
    // Start compact windows with space for the conversation, but let an opened
    // inspector stay available when resizing the window or dragging its boundary.
    if (window.matchMedia("(max-width: 1180px)").matches)
      setInspectorBySpace({ chat: false, productivity: false, evolution: false });
  }, []);

  useEffect(() => {
    const desktop = window.cleoDesktop;
    if (!desktop) return;
    let active = true;
    void desktop.getUpdateState().then((state) => {
      if (active) setUpdateState(state);
    });
    const unsubscribe = desktop.onUpdateState((state) => {
      if (active) setUpdateState(state);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const runUpdateAction = (action: "download" | "install") => {
    const desktop = window.cleoDesktop;
    if (!desktop) return;
    const operation: Promise<UpdateState | boolean> = action === "download"
      ? desktop.downloadUpdate() : desktop.installUpdate();
    void operation
      .then((result) => {
        if (typeof result !== "boolean" && result.phase === "error") {
          notify(result.error || tr("app.update_failed"), "error");
        }
      })
      .catch((error: unknown) => {
        notify(error instanceof Error ? error.message : tr("app.update_failed"), "error");
      });
  };

  const toggleSidebar = () => {
    if (compactColumns && showInspector) { setInspectorOpen(false); setSidebarCollapsed(false); }
    else setSidebarCollapsed(collapsed => !collapsed);
  };
  /** Step through conversations in the order the palette lists them (newest first). */
  const cycleThread = (step: number) => {
    const ids = (workspace.snapshot?.threads ?? []).filter(thread => thread.projectId !== "productivity:cleo-evolution").map(thread => thread.id);
    if (!ids.length) return;
    const index = ids.indexOf(workspace.activeThreadId ?? "");
    const next = ids[(index + step + ids.length) % ids.length] ?? ids[0];
    setEvolutionOpen(false);
    workspace.selectThread(next);
  };
  const openComposerMenu = (selector: string) => {
    const trigger = document.querySelector<HTMLButtonElement>(`.composer ${selector}`);
    if (!trigger) { notify(tr("app.open_a_task_first"), "error"); return; }
    if (trigger.disabled) return;
    if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
  };
  const focusComposer = () => {
    const input = document.querySelector<HTMLTextAreaElement>('.composer [data-testid="composer-input"]');
    if (!input) { notify(tr("app.open_a_task_first"), "error"); return; }
    input.focus();
  };
  // The global shortcuts always call this render's handlers, so they never act on a stale view.
  const shortcuts = useRef<Record<string, () => void>>({});
  shortcuts.current = {
    palette: () => setCommandOpen((open) => !open),
    // A new task from the keyboard stays out of the evolution view, which owns its own drafts.
    task: () => { if (!evolutionOpen) newTask(); },
    chat: newChat,
    sidebar: toggleSidebar,
    details: () => setInspectorOpen((open) => !open),
    settings: () => setSettingsOpen(true),
    next: () => cycleThread(1),
    previous: () => cycleThread(-1),
    shortcuts: () => setShortcutsOpen(true),
    // The composer's own menus, from anywhere: model and effort, then file access and approval. Where
    // no composer is on screen (memory library, settings) the shortcut says so instead of doing nothing.
    model: () => openComposerMenu('[data-testid="runtime-selector"]'),
    access: () => openComposerMenu('[data-testid="permission-selector"]'),
    composer: focusComposer,
  };
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector("dialog[open]")) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLocaleLowerCase();
      const action = key === "k" && !event.shiftKey ? "palette"
        : key === "/" && !event.shiftKey ? "shortcuts"
        : key === "n" ? (event.shiftKey ? "chat" : "task")
        : key === "b" && !event.shiftKey ? "sidebar"
        : key === "d" && event.shiftKey ? "details"
        : key === "m" && event.shiftKey ? "model"
        : key === "a" && event.shiftKey ? "access"
        : key === "l" && !event.shiftKey ? "composer"
        : key === "," && !event.shiftKey ? "settings"
        : key === "tab" ? (event.shiftKey ? "previous" : "next") : null;
      if (!action) return;
      event.preventDefault();
      shortcuts.current[action]?.();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const showInspectorTab = (tab: InspectorTab) => {
    chooseInspectorTab(tab);
    setInspectorOpen(true);
  };
  /** Revert the latest reply's file changes after confirmation; changes that predate it stay. */
  const undoLatestTurn = () => {
            if (!workspace.activeProject?.branch) {
              notify(tr("app.the_working_directory_is_not_a_git_repository_so_changes_cannot_be_reverted"), "error");
              return;
            }
            if (!window.confirm(tr("app.revert_the_file_changes_made_by_the_latest_reply_while_preserving_changes_that_existe"))) return;
            setUndoingChanges(true);
            void workspace.undoChanges()
              .then((result) => {
                notify(result.restoredFiles > 0
                  ? tr("app.reverted_this_reply_s_changes_to_value_files", { p0: result.restoredFiles })
                  : tr("app.the_latest_reply_made_no_file_changes"));
              })
              .catch((error: unknown) => {
                notify(error instanceof Error ? error.message : tr("app.could_not_revert_git_changes"), "error");
              })
              .finally(() => setUndoingChanges(false));
  };

  const commandActions = useMemo<CommandAction[]>(
    () => [
      {
        id: "new",
        label: tr("app.new_task"),
        hint: tr("app.create_a_task_in_the_current_project"),
        icon: commandIcons.plus,
        shortcut: `${modifierKey} N`,
        run: newTask,
      },
      {
        id: "new-chat",
        label: tr("app.new_chat"),
        hint: tr("app.everyday_conversation"),
        icon: commandIcons.chat,
        shortcut: `${modifierKey} Shift N`,
        run: newChat,
      },
      {
        id: "workspace",
        label: tr("app.add_project"),
        hint: tr("app.choose_a_local_folder_tasks_run_in_that_directory"),
        icon: commandIcons.folder,
        run: () => void workspace.chooseWorkspace().catch((error: unknown) => notify(error instanceof Error ? error.message : tr("app.could_not_open_the_working_directory"), "error")),
      },
      {
        id: "memory",
        label: tr("app.view_memories"),
        hint: tr("app.view_saved_memories"),
        icon: commandIcons.memory,
        run: openMemory,
      },
      {
        id: "evolution",
        label: tr("app.open_evolution"),
        hint: tr("sidebar.evolution_hint"),
        icon: commandIcons.evolution,
        run: openEvolution,
      },
      {
        id: "inspector",
        label: inspectorOpen ? tr("app.close_inspector") : tr("app.open_inspector"),
        hint: tr("app.view_file_changes_context_and_execution_output"),
        icon: commandIcons.inspector,
        shortcut: `${modifierKey} Shift D`,
        run: () => setInspectorOpen((open) => !open),
      },
      {
        id: "focus-composer",
        label: tr("app.focus_composer"),
        hint: tr("app.focus_composer_hint"),
        icon: commandIcons.keyboard,
        shortcut: `${modifierKey} L`,
        // After the palette closes, so its own focus restore does not take the cursor back.
        run: () => requestAnimationFrame(focusComposer),
      },
      {
        id: "show-changes",
        label: tr("app.show_changes_tab"),
        hint: tr("app.show_changes_tab_hint"),
        icon: commandIcons.inspector,
        run: () => showInspectorTab("changes"),
      },
      ...(window.cleoDesktop?.files ? [{
        id: "show-files",
        label: tr("app.show_files_tab"),
        hint: tr("app.show_files_tab_hint"),
        icon: commandIcons.folder,
        run: () => showInspectorTab("files"),
      }] : []),
      {
        id: "model-menu",
        label: tr("shortcuts.model_menu"),
        hint: tr("app.composer_menu_hint"),
        icon: commandIcons.settings,
        shortcut: `${modifierKey} Shift M`,
        run: () => requestAnimationFrame(() => openComposerMenu('[data-testid="runtime-selector"]')),
      },
      {
        id: "access-menu",
        label: tr("shortcuts.access_menu"),
        hint: tr("app.composer_menu_hint"),
        icon: commandIcons.settings,
        shortcut: `${modifierKey} Shift A`,
        run: () => requestAnimationFrame(() => openComposerMenu('[data-testid="permission-selector"]')),
      },
      {
        id: "sidebar",
        label: sidebarHidden ? tr("conversation.expand_sidebar") : tr("conversation.collapse_sidebar"),
        hint: tr("app.toggle_sidebar_hint"),
        icon: commandIcons.sidebar,
        shortcut: `${modifierKey} B`,
        run: toggleSidebar,
      },
      {
        id: "theme",
        label: theme === "dark" ? tr("app.switch_to_light_theme") : tr("app.switch_to_dark_theme"),
        hint: tr("overlays.appearance"),
        icon: theme === "dark" ? commandIcons.light : commandIcons.dark,
        run: () => setTheme(theme === "dark" ? "light" : "dark"),
      },
      {
        id: "next-thread",
        label: tr("app.next_conversation"),
        hint: tr("app.switch_conversation_hint"),
        icon: commandIcons.next,
        shortcut: `${modifierKey} Tab`,
        run: () => cycleThread(1),
      },
      {
        id: "notifications",
        label: notificationsOn ? tr("app.turn_off_notifications") : tr("app.turn_on_notifications"),
        hint: tr("app.notifications_hint"),
        icon: commandIcons.bell,
        run: () => setNotificationsOn((value) => !value),
      },
      {
        id: "settings",
        label: tr("app.open_settings"),
        hint: tr("app.change_appearance_models_and_data_settings"),
        icon: commandIcons.settings,
        shortcut: `${modifierKey} ,`,
        run: () => setSettingsOpen(true),
      },
      {
        id: "shortcuts",
        label: tr("shortcuts.title"),
        hint: tr("app.keyboard_shortcuts_hint"),
        icon: commandIcons.keyboard,
        shortcut: `${modifierKey} /`,
        run: () => setShortcutsOpen(true),
      },
    ],
    [inspectorOpen, sidebarHidden, theme, workspace, evolutionOpen, notificationsOn, language],
  );
  // Every conversation is reachable from the palette by name, newest first.
  const threadCommands = useMemo<CommandAction[]>(() => {
    const snapshot = workspace.snapshot;
    if (!snapshot) return [];
    return snapshot.threads.filter(thread => thread.projectId !== "productivity:cleo-evolution").map(thread => {
      const project = snapshot.projects.find(item => item.id === thread.projectId);
      return {
        id: `thread-${thread.id}`,
        label: thread.title,
        hint: thread.summary,
        detail: [projectLabel(project) || (thread.space === "chat" ? tr("app.chat") : ""), harnessLabel(thread.runtime, thread.space)]
          .filter(Boolean).join(" · "),
        icon: thread.space === "chat" ? commandIcons.chat : commandIcons.code,
        run: () => { setEvolutionOpen(false); workspace.selectThread(thread.id); },
      };
    });
  }, [workspace.snapshot?.threads, workspace.snapshot?.projects, workspace.selectThread, language]);

  if (!workspace.snapshot) return <><DependencySetup /><LoadingScreen error={workspace.loadingError} onRetry={workspace.retryLoading} /></>;

  const activeRuntime = evolutionOpen && !evolutionThread ? workspace.draftRuntime : workspace.activeThreadRuntime ?? workspace.draftRuntime;
  const selectedThread = evolutionOpen && !evolutionThread ? null : workspace.activeThread;
  const conversationThread = selectedThread;
  const conversationProject: Project | null = evolutionOpen
    ? { id: "productivity:cleo-evolution", space: "productivity", name: "Cleo", path: evolution.state?.source || "", accent: "cyan" }
    : workspace.activeProject;
  // Git actions and worktrees are offered for development tasks in a real repository folder.
  const gitProject = !evolutionOpen && Boolean(conversationProject && !conversationProject.managed && conversationProject.branch);
  // Review notes belong to a task in one repository and on one branch: a task moved elsewhere, or a
  // checkout switched to another branch, does not show them on unrelated code (they come back).
  // When git reports another branch than the workspace's record (a checkout switched outside Cleo),
  // notes wait until the workspace has caught up: none shown, sent or added on the wrong branch.
  const liveBranch = conversationProject ? workspace.liveBranches[conversationProject.id] : undefined;
  const branchSettled = liveBranch === undefined || liveBranch === projectBranchName(conversationProject?.branch);
  const threadComments = conversationThread && branchSettled ? (reviewComments[conversationThread.id] ?? [])
    .filter((comment) => (!comment.repository || comment.repository === conversationProject?.path)
      && (!comment.branch || comment.branch === conversationProject?.branch)) : [];
  const updateThreadComments = (update: (comments: ReviewComment[]) => ReviewComment[]) => {
    if (!conversationThread) return;
    const threadId = conversationThread.id;
    setReviewComments((current) => ({ ...current, [threadId]: update(current[threadId] ?? []) }));
  };
  /** Send the review notes to the agent as one message (queued if a turn is running); the draft is kept. */
  const sendReviewComments = () => {
    if (!threadComments.length || !conversationThread) return;
    // A running delegated subtask belongs to its parent's run: notes wait, like its composer does.
    if (conversationThread.routingTaskId && conversationThread.status === "running" && !workspace.running) {
      notify(tr("conversation.subtask_runs_in_parent"), "error");
      return;
    }
    const sent = threadComments;
    // Notes written on an earlier version of the change say so in the message.
    const text = reviewCommentsPrompt(sent, (comment) =>
      noteVersion(comment, conversationThread.changes.find((file) => file.path === comment.path)?.diff));
    // The composer's own draft and attachments stay where they are; the notes are cleared only
    // once the message is accepted, so a failed send leaves them to retry.
    const threadId = conversationThread.id;
    const clearSent = (accepted: boolean) => {
      if (accepted) setReviewComments((current) => ({ ...current,
        [threadId]: (current[threadId] ?? []).filter(comment => !sent.some(item => item.id === comment.id)) }));
      else notify(tr("review.comments_not_sent"), "error");
    };
    if (workspace.running) clearSent(workspace.queueMessage(text, { fromDraft: false }));
    else void workspace.sendPrompt(text, conversationThread, { preserveDraft: true }).then(clearSent, () => clearSent(false));
  };
  const selectedRuntimeModel = workspace.activeSpace === "productivity"
    ? workspace.productivityModels[activeRuntime.provider]?.models.find(
        (model) => model.id === activeRuntime.model,
      )
    : undefined;
  const supportedEfforts = selectedRuntimeModel?.supportedEfforts ?? [];
  const settingsRuntime = activeRuntime.effort || !selectedRuntimeModel?.defaultEffort
    ? activeRuntime
    : { ...activeRuntime, effort: selectedRuntimeModel.defaultEffort };
  const evolutionUnavailable = !evolutionOpen ? null : !evolution.state
    ? evolution.loadError ? tr("app.could_not_load_evolution_status_try_again") : tr("app.loading_evolution_status")
    : !evolution.state.supported ? tr("app.local_evolution_is_unavailable_in_this_environment") : null;
  let composerBlocked = workspace.harnessSwitchStatus || evolutionUnavailable;
  if (!composerBlocked && (updateState.blocksTasks || (evolutionOpen && updateState.operationBusy))) {
    composerBlocked = tr("app.wait_for_the_current_version_operation_to_finish");
  }
  if (!composerBlocked && evolutionOpen && (evolution.state?.phase !== "idle"
      || (!workspace.running && (preparingTurn || openingEvolutionUi || evolution.pending)))) {
    composerBlocked = tr("app.wait_for_the_current_operation_to_finish");
  }
  if (!composerBlocked && workspace.startingRun) composerBlocked = tr("app.submitting_please_wait");
  if (!composerBlocked && workspace.creatingWorktree) composerBlocked = tr("sourcecontrol.creating_worktree");
  // A delegated subtask that is running belongs to its parent's run: it is stopped or continued
  // from the parent, so its own composer waits instead of starting a second, unrelated run.
  if (!composerBlocked && !evolutionOpen && conversationThread?.routingTaskId && conversationThread.status === "running" && !workspace.running) {
    composerBlocked = tr("conversation.subtask_runs_in_parent");
  }
  const appClasses = [
    "app-shell",
    evolutionOpen ? "evolution-open" : "",
    sidebarHidden ? "sidebar-collapsed" : "",
    showInspector ? "inspector-open" : "inspector-closed",
    inspectorResize.dragging ? "inspector-resizing" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={inspectorResize.setShell} className={appClasses} style={inspectorResize.style} data-theme={theme}>
      <TitleBar />
      {workspace.loadingError && <div className="workspace-error" role="alert">
        <span>{workspace.loadingError}</span><button onClick={workspace.retryLoading}>{tr("app.retry")}</button>
        <button onClick={workspace.clearLoadingError}>{tr("app.close")}</button>
      </div>}
      <DependencySetup />
      <ThreadSidebar
        view={evolutionOpen ? "evolution" : workspace.activeSpace}
        projects={workspace.snapshot.projects.filter((project) => project.id !== "productivity:cleo-evolution")}
        threads={workspace.snapshot.threads.filter((thread) => thread.projectId !== "productivity:cleo-evolution")}
        activeProjectId={workspace.activeProjectId}
        activeThreadId={evolutionOpen ? null : workspace.activeThreadId}
        onStartThread={(projectId) => inWorkspace(current => {
          if (current.activeSpace !== "productivity") current.selectSpace("productivity");
          void current.createThread(projectId);
        })}
        onRemoveProject={project => { setRemoveError(null); setProjectPendingRemoval(project); }}
        onRemoveWorktree={project => {
          if (!window.confirm(tr("sidebar.remove_worktree_confirm", { p0: project.branch ?? project.name }))) return;
          void workspace.removeWorktreeProject(project).then(() => notify(tr("sidebar.worktree_removed")))
            .catch((error: unknown) => {
              // git refuses a worktree with uncommitted work; a second, explicit confirmation discards it.
              const message = error instanceof Error ? error.message : tr("app.operation_failed");
              if (!(project.dirtyFiles ?? 0) && !/modified|untracked|uncommitted|contains/i.test(message)) { notify(message, "error"); return; }
              if (!window.confirm(tr("sidebar.remove_dirty_worktree_confirm", { p0: project.branch ?? project.name }))) return;
              void workspace.removeWorktreeProject(project, true).then(() => notify(tr("sidebar.worktree_removed")))
                .catch((forced: unknown) => notify(forced instanceof Error ? forced.message : tr("app.operation_failed"), "error"));
            });
        }}
        onSelectThread={(threadId) => { setEvolutionOpen(false); workspace.selectThread(threadId); }}
        onDeleteThread={thread => { setDeleteError(null); setThreadPendingDeletion(thread); }}
        onCreateThread={newTask}
        onCreateDevTask={newDevTask}
        onCreateChat={newChat}
        onOpenSearch={() => setCommandOpen(true)}
        onOpenMemory={openMemory}
        onOpenEvolution={openEvolution}
        onOpenSettings={() => setSettingsOpen(true)}
        memoryPending={workspace.snapshot.memoryOverview.summary.pending_sources}
        evolutionUnread={unreadSpaces.has("evolution")}
        recoverableChatBackups={workspace.snapshot.backend?.recoverableChatBackups ?? 0}
        onRestoreChatHistory={() => void workspace.restoreChatHistory().catch((error: unknown) => notify(error instanceof Error ? error.message : tr("app.could_not_restore_previous_chats"), "error"))}
        backendMode={workspace.snapshot.backend?.mode ?? "mock"}
        unreadThreadIds={workspace.unreadThreadIds}
      />
      {!evolutionOpen && workspace.activeSpace === "memory" ? (
        <MemoryView
          overview={workspace.snapshot.memoryOverview}
          mode={memoryView}
          onModeChange={setMemoryView}
          refreshError={workspace.memoryError}
          refreshing={workspace.memoryRefreshing}
          onRetryRefresh={() => void workspace.refreshMemory()}
          onLoadReviewDetails={workspace.loadMemoryReviewDetails}
          onRetrySource={workspace.retryMemorySource}
        />
      ) : (
          <Conversation
          header={evolutionOpen ? <EvolutionPanel state={evolution.state} error={evolutionIssue || evolution.error}
            busy={openingEvolutionUi || evolution.pending || updateState.operationBusy || Boolean(evolution.state && evolution.state.phase !== "idle")}
            running={workspace.running} otherTasksRunning={workspace.anyRunning && !workspace.running} inspectorOpen={showInspector} onToggleInspector={() => setInspectorOpen((open) => !open)}
            onAction={evolutionAction} onRetry={() => {
              if (evolution.loadError || !retryEvolution.current) void evolution.refresh().catch(() => {});
              else retryEvolution.current();
            }} onRepair={() => { void repairEvolution(); }} /> : undefined}
          onImprove={!evolutionOpen && conversationThread && window.cleoDesktop ? () => { setImprovementDraft(tr("app.please_improve_cleo")); setEvolutionOpen(true); } : undefined}
          prompt={workspace.prompt}
          skills={workspace.skills}
          onPromptChange={workspace.setPrompt}
          sendError={workspace.sendError}
          harnessSwitchStatus={workspace.harnessSwitchStatus}
          pendingHarnessSwitch={evolutionOpen && !evolutionThread ? null : workspace.pendingHarnessSwitch}
          sendBlocked={composerBlocked}
          onRename={workspace.renameThread}
          onMoveToProject={conversationThread && !evolutionOpen ? async (projectId) => {
            const target = workspace.snapshot?.projects.find((project) => project.id === projectId);
            await workspace.moveThread(conversationThread.id, projectId);
            notify(tr("app.conversation_moved_to_value", { p0: target ? projectLabel(target) : projectId }));
          } : undefined}
          thread={conversationThread}
          project={conversationProject}
          projects={evolutionOpen ? [] : workspace.snapshot.projects.filter((project) => project.id !== "productivity:cleo-evolution")}
          activeProjectId={workspace.activeProjectId}
          onSelectProject={workspace.retargetDraft}
          onChooseWorkspace={() => void workspace.chooseWorkspace().catch((error: unknown) => notify(error instanceof Error ? error.message : tr("app.could_not_open_the_working_directory"), "error"))}
          choosingWorkspace={workspace.choosingWorkspace}
          space={!evolutionOpen && workspace.activeSpace === "chat" ? "chat" : "productivity"}
          runtime={activeRuntime}
          runtimeCatalog={workspace.runtimeCatalog}
          productivityModels={workspace.productivityModels}
          runtimeModelsLoading={workspace.runtimeModelsLoading}
          runtimeModelsError={workspace.runtimeModelsError}
          running={workspace.running}
          waitingForAnswer={Boolean(workspace.questions.current)}
          undoing={undoingChanges}
          sidebarCollapsed={sidebarHidden}
          inspectorOpen={showInspector}
          onToggleSidebar={toggleSidebar}
          onToggleInspector={() => setInspectorOpen((open) => !open)}
          onOpenCommand={() => setCommandOpen(true)}
          onSend={(prompt) => void (workspace.running ? workspace.queueMessage(prompt)
            : evolutionOpen ? sendEvolutionPrompt(prompt)
            : drafting && isolateDraft && gitProject ? workspace.sendInWorktree(prompt).then((sent) => {
              // The worktree choice belongs to this one draft; the next new task starts in the folder again.
              if (sent) setIsolateDraft(false);
            }).catch((error: unknown) => {
              notify(error instanceof Error ? error.message : tr("app.operation_failed"), "error");
            })
            : workspace.sendPrompt(prompt))}
          worktree={drafting && gitProject && workspace.activeSpace === "productivity"
            ? { enabled: isolateDraft, onToggle: () => setIsolateDraft((value) => !value) } : undefined}
          onListFiles={gitProject && workspace.activeSpace === "productivity"
            ? () => workspace.runSourceControl<RepositoryFiles>("listFiles").then((result) => result.files) : undefined}
          onSteerDraft={evolutionOpen ? undefined : (text) => void workspace.steerDraft(text)}
          // Delegated subtasks carry a routing task id; a fork records its parent too but is not a subtask.
          subtasks={conversationThread ? workspace.snapshot.threads.filter((thread) => thread.parentId === conversationThread.id && thread.routingTaskId) : []}
          parentThread={conversationThread?.parentId && conversationThread.routingTaskId
            ? workspace.snapshot.threads.find((thread) => thread.id === conversationThread.parentId) ?? null : null}
          onOpenThread={(threadId) => { setEvolutionOpen(false); workspace.selectThread(threadId); }}
          changesVisible={showInspector && inspectorTab === "changes"}
          queuedMessages={workspace.queuedMessages}
          onSteerQueued={id => void workspace.steerQueued(id)}
          onSendQueued={workspace.sendQueued}
          onEditQueued={workspace.editQueued}
          onRemoveQueued={workspace.removeQueued}
          onEditMessage={evolutionOpen ? undefined : workspace.editMessage}
          onRetrySteer={receipt => void workspace.retrySteer(receipt)}
          onRestoreSteer={workspace.restoreSteer}
          steeringBusy={workspace.steeringBusy}
          onCancel={workspace.cancelRun}
          onUndo={undoLatestTurn}
          onSelectNonProductivityProfile={(profileId) => {
            void workspace.selectNonProductivityProfile(profileId).catch(
              (error: unknown) => notify(error instanceof Error ? error.message : tr("app.could_not_switch_models"), "error"),
            );
          }}
          onLoadProductivityModels={(provider, refresh, background) => workspace.loadProductivityModels(
            provider, conversationProject?.path, refresh, background,
          )}
          onSelectProductivityRuntime={(provider, model) => {
            void workspace.selectProductivityRuntime(provider, model);
          }}
          onRoutingModeChange={(routingMode) => workspace.updateRuntime({ routingMode })}
          onEffortChange={(effort) => workspace.updateRuntime({ effort })}
          onServiceTierChange={(serviceTier) => workspace.updateRuntime({ serviceTier })}
          onPermissionChange={workspace.activeThread?.id ? (update) => workspace.updatePermissions(workspace.activeThread!.id, update)
            : evolutionOpen ? undefined : workspace.setDraftPermissions}
          attachments={workspace.attachments}
          onPickAttachments={workspace.pickAttachments}
          onPrepareAttachments={workspace.prepareAttachments}
          onRemoveAttachment={workspace.removeAttachment}
          onShowRun={() => showInspectorTab("details")}
          onShowContext={() => showInspectorTab("details")}
          onShowChanges={() => showInspectorTab("changes")}
          onShowChangeFile={(path) => { setChangeReveal({ path, nonce: Date.now() }); showInspectorTab("changes"); }}
          onRevealPath={(path) => void workspace.revealPath(path)}
          onOpenPath={(href, workspacePath) => {
            void (async () => {
              // Files inside the task workspace open in the Files sidebar; others use the system app.
              const located = workspacePath && window.cleoDesktop?.files
                ? await window.cleoDesktop.files<{ path: string; line: number | null } | null>("locate", { root: workspacePath, href }).catch(() => null)
                : null;
              if (located) {
                setFileReveal({ ...located, nonce: Date.now() });
                setInspectorTab("files");
                setInspectorOpen(true);
                return;
              }
              await workspace.openLocalPath(href, workspacePath);
            })().catch((error: unknown) => {
              notify(error instanceof Error ? error.message : tr("app.could_not_open_the_local_file"), "error");
            });
          }}
          onThreadCommand={(command) => void workspace.sendPrompt(command)}
          commands={workspace.snapshot.backend?.commands[workspace.activeSpace === "chat" ? "chat" : "productivity"] ?? []}
          history={workspace.history}
          questionUI={<QuestionDialog questions={workspace.questions} />}
          approvalRequest={workspace.pendingApprovals.find(q => q.threadId === workspace.activeThreadId) ?? null}
          approvalPending={workspace.approvalPendingId !== null}
          approvalError={workspace.approvalError}
          onResolveApproval={(decision) => void workspace.resolveApproval(decision)}
        />
      )}
      {showInspector ? (
        <Inspector
          running={workspace.running}
          onStop={() => void workspace.cancelRun()}
          resizeHandle={<div className="inspector-resize-handle" {...inspectorResize.handleProps} />}
          wide={inspectorResize.wide}
          onToggleWide={inspectorResize.toggleWide}
          // The snapshot copy carries waitingFor, so the details header can say "waiting" rather than "running".
          thread={workspace.snapshot.threads.find((thread) => thread.id === conversationThread?.id) ?? conversationThread}
          project={conversationProject}
          runtime={activeRuntime}
          memories={workspace.snapshot.memories}
          activeTab={inspectorTab}
          onTabChange={chooseInspectorTab}
          onClose={() => setInspectorOpen(false)}
          onNotify={notify}
          onCopyText={(value) => void workspace.copyText(value)}
          onRevealPath={(value) => void workspace.revealPath(value)}
          fileReveal={fileReveal}
          changeReveal={changeReveal}
          onOpenExternalPath={(path) => void workspace.openLocalPath(path, conversationProject?.path ?? "").catch((error: unknown) => {
            notify(error instanceof Error ? error.message : tr("app.could_not_open_the_local_file"), "error");
          })}
          onOpenFile={(path) => { setFileReveal({ path, line: null, nonce: Date.now() }); setInspectorTab("files"); }}
          onUndo={conversationThread?.space === "productivity" && conversationThread.canUndo ? undoLatestTurn : undefined}
          undoing={undoingChanges}
          computerAvailable={Boolean(window.cleoDesktop?.computer)}
          sourceBusy={Boolean(conversationProject && !evolutionOpen && workspace.checkoutBusy(conversationProject.id) && !workspace.running)}
          runSourceControl={gitProject && conversationThread?.space === "productivity" ? workspace.runSourceControl : undefined}
          reviewComments={threadComments}
          onAddReviewComment={conversationThread && branchSettled ? (comment) => updateThreadComments((comments) => [...comments,
            { ...comment, id: crypto.randomUUID(), repository: conversationProject?.path ?? "", branch: conversationProject?.branch ?? "" }]) : undefined}
          onRemoveReviewComment={(id) => updateThreadComments((comments) => comments.filter((comment) => comment.id !== id))}
          onSendReviewComments={sendReviewComments}
          // Only the notes on screen: notes kept for another branch or folder of this task stay.
          onClearReviewComments={() => updateThreadComments((comments) => comments.filter((comment) => !threadComments.some((shown) => shown.id === comment.id)))}
          onPermissionsChange={evolutionOpen ? undefined : workspace.updatePermissions}
        />
      ) : null}
      <CommandPalette open={commandOpen} actions={commandActions} threads={threadCommands} onClose={() => setCommandOpen(false)} />
      <ShortcutsDialog open={shortcutsOpen} modifierKey={modifierKey} onClose={() => setShortcutsOpen(false)} />
      <SettingsModal
        language={language}
        onLanguageChange={changeLanguage}
        notificationsOn={notificationsOn}
        onNotificationsChange={setNotificationsOn}
        open={settingsOpen}
        theme={theme}
        motionEnabled={motionEnabled}
        onMotionChange={setMotionEnabled}
        runtime={settingsRuntime}
        runtimeThread={selectedThread}
        onPermissionsChange={workspace.updatePermissions}
        supportedEfforts={supportedEfforts}
        modelSettings={workspace.modelSettings}
        modelSettingsLoading={workspace.modelSettingsLoading}
        modelSettingsError={workspace.modelSettingsError}
        agentInstructions={workspace.agentInstructions}
        agentInstructionsLoading={workspace.agentInstructionsLoading}
        agentInstructionsError={workspace.agentInstructionsError}
        updateState={displayedUpdateState}
        onThemeChange={setTheme}
        onRuntimeChange={workspace.updateRuntime}
        onLoadModelSettings={workspace.loadModelSettings}
        onApplyModelSettings={workspace.applyModelSettings}
        onLoadAgentInstructions={workspace.loadAgentInstructions}
        onSaveAgentInstructions={workspace.saveAgentInstructions}
        onCheckForUpdates={async (tag) => {
          return window.cleoDesktop?.checkForUpdates(tag);
        }}
        onDownloadUpdate={() => runUpdateAction("download")}
        onInstallUpdate={() => runUpdateAction("install")}
        onStorageInventory={window.cleoDesktop?.storageInventory ? () => window.cleoDesktop!.storageInventory!() : undefined}
        onReclaimStorage={window.cleoDesktop?.reclaimStorage ? () => window.cleoDesktop!.reclaimStorage!() : undefined}
        storageBlocked={workspace.anyRunning ? tr("app.wait_for_running_tasks_to_finish_before_reclaiming_storage") : null}
        onRevealPath={(path) => void workspace.revealPath(path)}
        onCopyConfigTemplate={(kind) => {
          void workspace.copyConfigTemplate(kind).then(() => notify(tr("app.configuration_template_copied")));
        }}
        onResetWorkspace={() => {
          void workspace.resetWorkspace()
            .then(() => notify(tr("app.workspace_reset_to_main")))
            .catch((error) => notify(error instanceof Error ? error.message : tr("app.reset_failed_try_again"), "error"));
        }}
        onClose={() => setSettingsOpen(false)}
      />
      <DeleteThreadDialog
        threadTitle={threadPendingDeletion?.title ?? null}
        productivity={threadPendingDeletion?.space === "productivity"}
        deleting={deletingThread}
        error={deleteError}
        onCancel={() => setThreadPendingDeletion(null)}
        onConfirm={() => {
          if (!threadPendingDeletion) return;
          setDeletingThread(true);
          setDeleteError(null);
          const deletedId = threadPendingDeletion.id;
          void workspace.deleteThread(deletedId)
            .then(() => {
              // A deleted task's review notes go with it. The task list is not a complete inventory
              // (it is capped and skips unreadable records), so notes are never pruned against it.
              setReviewComments((current) => {
                if (!(deletedId in current)) return current;
                const rest = { ...current };
                delete rest[deletedId];
                return rest;
              });
              setThreadPendingDeletion(null);
              notify(tr("app.task_deleted"));
            })
            .catch((error: unknown) => {
              setDeleteError(error instanceof Error ? error.message : tr("app.could_not_delete_the_task"));
            })
            .finally(() => setDeletingThread(false));
        }}
      />
      <RemoveProjectDialog
        project={projectPendingRemoval}
        removing={removingProject}
        error={removeError}
        onCancel={() => setProjectPendingRemoval(null)}
        onConfirm={() => {
          if (!projectPendingRemoval) return;
          setRemovingProject(true);
          setRemoveError(null);
          void workspace.removeProject(projectPendingRemoval.id)
            .then(() => {
              setProjectPendingRemoval(null);
              notify(tr("app.project_removed_from_the_sidebar"));
            })
            .catch((error: unknown) => {
              setRemoveError(error instanceof Error ? error.message : tr("app.could_not_remove_the_project"));
            })
            .finally(() => setRemovingProject(false));
        }}
      />
      <ConfigNotice status={configStatus} onRecheck={refreshConfigStatus} />
      <UpdateNotice
        state={displayedUpdateState}
        onDownload={() => runUpdateAction("download")}
        onInstall={() => runUpdateAction("install")}
      />
      {toast ? <Toast message={toast.message} tone={toast.tone} /> : null}
    </div>
  );
}

/** The window's drag region and brand; where the user is shows in the sidebar and the pane header. */
function TitleBar() {
  return (
    <header className="titlebar">
      <div className="titlebar-brand"><span className="mini-brand" aria-hidden="true" /><strong>Cleo</strong></div>
    </header>
  );
}
