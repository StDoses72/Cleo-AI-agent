import { modifierKey } from "./platform";
import { useEffect, useMemo, useRef, useState } from "react";
import { Command, Minus } from "lucide-react";
import { Conversation } from "./components/Conversation";
import { Inspector, type InspectorTab } from "./components/Inspector";
import { MemoryView } from "./components/MemoryView";
import {
  CommandPalette,
  DeleteThreadDialog,
  LoadingScreen,
  RemoveProjectDialog,
  SettingsModal,
  Toast,
  UpdateNotice,
  commandIcons,
  type CommandAction,
} from "./components/Overlays";
import { ThreadSidebar } from "./components/ThreadSidebar";
import { WorkspaceRail } from "./components/WorkspaceRail";
import { useCleoWorkspace } from "./useCleoWorkspace";
import type { MemoryViewMode, Project, Thread, UpdateState } from "./types";

export function App() {
  const workspace = useCleoWorkspace();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inspectorBySpace, setInspectorBySpace] = useState({ chat: false, productivity: true });
  const inspectorSpace = workspace.activeSpace === "chat" ? "chat" : "productivity";
  const inspectorOpen = inspectorBySpace[inspectorSpace];
  const setInspectorOpen = (value: boolean | ((open: boolean) => boolean)) => {
    setInspectorBySpace((current) => ({
      ...current,
      [inspectorSpace]: typeof value === "function" ? value(current[inspectorSpace]) : value,
    }));
  };
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("changes");
  const [commandOpen, setCommandOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [threadPendingDeletion, setThreadPendingDeletion] = useState<Thread | null>(null);
  const [deletingThread, setDeletingThread] = useState(false);
  const [projectPendingRemoval, setProjectPendingRemoval] = useState<Project | null>(null);
  const [removingProject, setRemovingProject] = useState(false);
  const [undoingChanges, setUndoingChanges] = useState(false);
  const [memoryView, setMemoryView] = useState<MemoryViewMode>("all");
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    localStorage.getItem("cleo-theme") === "light" ? "light" : "dark",
  );
  const [motionEnabled, setMotionEnabled] = useState(() => localStorage.getItem("cleo-motion") !== "reduced");
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState>({
    phase: window.cleoDesktop ? "idle" : "unsupported",
    currentVersion: "dev",
    latestVersion: null,
    downloadedBytes: 0,
    totalBytes: 0,
    error: null,
  });
  const toastTimerRef = useRef<number | null>(null);

  const notify = (message: string, tone: "success" | "error" = "success") => {
    setToast({ message, tone });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600);
  };

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
    const compactLayout = window.matchMedia("(max-width: 1180px)");
    const closeInspectorForCompactLayout = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setInspectorBySpace({ chat: false, productivity: false });
    };
    closeInspectorForCompactLayout(compactLayout);
    compactLayout.addEventListener("change", closeInspectorForCompactLayout);
    return () => compactLayout.removeEventListener("change", closeInspectorForCompactLayout);
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

  const runUpdateAction = (action: "check" | "download" | "install") => {
    const desktop = window.cleoDesktop;
    if (!desktop) return;
    const operation: Promise<UpdateState | boolean> = action === "check"
      ? desktop.checkForUpdates()
      : action === "download"
        ? desktop.downloadUpdate()
        : desktop.installUpdate();
    void operation
      .then((result) => {
        if (typeof result !== "boolean" && result.phase === "error") {
          notify(result.error || "更新操作失败", "error");
        }
      })
      .catch((error: unknown) => {
        notify(error instanceof Error ? error.message : "更新操作失败", "error");
      });
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setCommandOpen(false);
        setSettingsOpen(false);
        if (!deletingThread) setThreadPendingDeletion(null);
        if (!removingProject) setProjectPendingRemoval(null);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "n") {
        event.preventDefault();
        if (workspace.activeSpace === "memory") workspace.selectSpace("productivity");
        void workspace.createThread();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deletingThread, removingProject, workspace.activeSpace, workspace.createThread, workspace.selectSpace]);

  const commandActions = useMemo<CommandAction[]>(
    () => [
      {
        id: "new",
        label: "新建任务",
        hint: "在当前项目中创建一个空 thread",
        icon: commandIcons.plus,
        shortcut: `${modifierKey} N`,
        run: () => void workspace.createThread(),
      },
      {
        id: "workspace",
        label: "打开工作目录",
        hint: "选择本地文件夹并创建开发任务",
        icon: commandIcons.code,
        run: () => void workspace.chooseWorkspace().catch((error: unknown) => notify(error instanceof Error ? error.message : "无法打开工作目录", "error")),
      },
      {
        id: "chat",
        label: "打开 Cleo 对话",
        hint: "切换到 non_productivity 空间",
        icon: commandIcons.chat,
        run: () => workspace.selectSpace("chat"),
      },
      {
        id: "code",
        label: "打开开发任务",
        hint: "切换到 productivity 空间",
        icon: commandIcons.code,
        run: () => workspace.selectSpace("productivity"),
      },
      {
        id: "memory",
        label: "查看记忆",
        hint: "浏览项目记忆与 persona 投影",
        icon: commandIcons.memory,
        run: () => workspace.selectSpace("memory"),
      },
      {
        id: "inspector",
        label: inspectorOpen ? "关闭检查器" : "打开检查器",
        hint: "查看文件变更、上下文与运行输出",
        icon: commandIcons.inspector,
        run: () => setInspectorOpen((open) => !open),
      },
      {
        id: "settings",
        label: "打开设置",
        hint: "修改外观、模型与数据选项",
        icon: commandIcons.settings,
        run: () => setSettingsOpen(true),
      },
    ],
    [inspectorOpen, workspace],
  );

  if (!workspace.snapshot) return <LoadingScreen error={workspace.loadingError} />;

  const activeRuntime = workspace.activeThread?.runtime ?? workspace.draftRuntime;
  const selectedRuntimeModel = workspace.activeSpace === "productivity"
    ? workspace.productivityModels[activeRuntime.provider]?.models.find(
        (model) => model.id === activeRuntime.model,
      )
    : undefined;
  const supportedEfforts = selectedRuntimeModel?.supportedEfforts ?? [];
  const settingsRuntime = activeRuntime.effort || !selectedRuntimeModel?.defaultEffort
    ? activeRuntime
    : { ...activeRuntime, effort: selectedRuntimeModel.defaultEffort };
  const showInspector = inspectorOpen && workspace.activeSpace !== "memory";
  const appClasses = [
    "app-shell",
    sidebarCollapsed ? "sidebar-collapsed" : "",
    showInspector ? "inspector-open" : "inspector-closed",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={appClasses} data-theme={theme}>
      <TitleBar
        projectName={workspace.activeSpace === "memory" ? "记忆" : workspace.activeProject?.name ?? "Cleo"}
        mode={workspace.activeSpace === "productivity" ? "Productivity" : workspace.activeSpace === "chat" ? "Chat" : "Memory"}
      />
      <WorkspaceRail
        activeSpace={workspace.activeSpace}
        onSelectSpace={workspace.selectSpace}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <ThreadSidebar
        space={workspace.activeSpace}
        projects={workspace.snapshot.projects}
        threads={workspace.snapshot.threads}
        activeProjectId={workspace.activeProjectId}
        activeThreadId={workspace.activeThreadId}
        onSelectProject={workspace.selectProject}
        onRemoveProject={setProjectPendingRemoval}
        onSelectThread={workspace.selectThread}
        onDeleteThread={setThreadPendingDeletion}
        onCreateThread={() => void workspace.createThread()}
        onChooseWorkspace={() => void workspace.chooseWorkspace().catch((error: unknown) => notify(error instanceof Error ? error.message : "无法打开工作目录", "error"))}
        onOpenCommand={() => setCommandOpen(true)}
        recoverableChatBackups={workspace.snapshot.backend?.recoverableChatBackups ?? 0}
        onRestoreChatHistory={() => void workspace.restoreChatHistory().catch((error: unknown) => notify(error instanceof Error ? error.message : "无法恢复旧对话", "error"))}
        memoryOverview={workspace.snapshot.memoryOverview}
        memoryView={memoryView}
        onMemoryViewChange={setMemoryView}
        backendMode={workspace.snapshot.backend?.mode ?? "mock"}
      />
      {workspace.activeSpace === "memory" ? (
        <MemoryView
          overview={workspace.snapshot.memoryOverview}
          mode={memoryView}
          onLoadReviewDetails={workspace.loadMemoryReviewDetails}
          onReviewSource={workspace.reviewMemorySource}
        />
      ) : (
        <Conversation
          prompt={workspace.prompt}
          onPromptChange={workspace.setPrompt}
          sendError={workspace.sendError}
          sendBlocked={workspace.startingRun ? "正在提交，请稍候…" : workspace.runningThreadId && workspace.runningThreadId !== workspace.activeThreadId ? "另一个任务正在运行，完成或停止后即可发送。" : null}
          onRename={workspace.renameThread}
          thread={workspace.activeThread}
          project={workspace.activeProject}
          space={workspace.activeSpace === "chat" ? "chat" : "productivity"}
          runtime={activeRuntime}
          runtimeCatalog={workspace.runtimeCatalog}
          productivityModels={workspace.productivityModels}
          runtimeModelsLoading={workspace.runtimeModelsLoading}
          runtimeModelsError={workspace.runtimeModelsError}
          running={workspace.runningThreadId !== null && workspace.runningThreadId === workspace.activeThreadId}
          undoing={undoingChanges}
          sidebarCollapsed={sidebarCollapsed}
          inspectorOpen={showInspector}
          onToggleSidebar={() => setSidebarCollapsed((collapsed) => !collapsed)}
          onToggleInspector={() => setInspectorOpen((open) => !open)}
          onOpenCommand={() => setCommandOpen(true)}
          onSend={(prompt) => void workspace.sendPrompt(prompt)}
          onCancel={workspace.cancelRun}
          onUndo={() => {
            if (!workspace.activeProject?.branch) {
              notify("当前工作目录不是 Git 仓库，无法回退。", "error");
              return;
            }
            if (!window.confirm("将回退最近一次回答产生的文件改动，并保留回答前已有的改动。是否继续？")) return;
            setUndoingChanges(true);
            void workspace.undoChanges()
              .then((result) => {
                notify(result.restoredFiles > 0
                  ? `已回退本次回答对 ${result.restoredFiles} 个文件的改动`
                  : "最近一次回答没有产生文件改动");
              })
              .catch((error: unknown) => {
                notify(error instanceof Error ? error.message : "无法回退 Git 改动", "error");
              })
              .finally(() => setUndoingChanges(false));
          }}
          onSelectNonProductivityProfile={(profileId) => {
            void workspace.selectNonProductivityProfile(profileId).catch(
              (error: unknown) => notify(error instanceof Error ? error.message : "无法切换模型", "error"),
            );
          }}
          onLoadProductivityModels={workspace.loadProductivityModels}
          onSelectProductivityRuntime={workspace.selectProductivityRuntime}
          onEffortChange={(effort) => workspace.updateRuntime({ effort })}
          attachments={workspace.attachments}
          onPickAttachments={workspace.pickAttachments}
          onPrepareAttachments={workspace.prepareAttachments}
          onRemoveAttachment={workspace.removeAttachment}
          onShowRun={() => {
            setInspectorTab("run");
            setInspectorOpen(true);
          }}
          onShowContext={() => {
            setInspectorTab("context");
            setInspectorOpen(true);
          }}
          onRevealPath={(path) => void workspace.revealPath(path)}
          onOpenPath={(href, workspacePath) => {
            void workspace.openLocalPath(href, workspacePath).catch((error: unknown) => {
              notify(error instanceof Error ? error.message : "无法打开本地文件", "error");
            });
          }}
          onThreadCommand={(command) => void workspace.sendPrompt(command)}
          commands={workspace.snapshot.backend?.commands[workspace.activeSpace === "chat" ? "chat" : "productivity"] ?? []}
          approvalRequest={workspace.pendingApprovals[0] ?? null}
          approvalPending={workspace.approvalPendingId !== null}
          approvalError={workspace.approvalError}
          onResolveApproval={(decision) => void workspace.resolveApproval(decision)}
        />
      )}
      {showInspector ? (
        <Inspector
          thread={workspace.activeThread}
          project={workspace.activeProject}
          runtime={activeRuntime}
          memories={workspace.snapshot.memories}
          activeTab={inspectorTab}
          onTabChange={setInspectorTab}
          onClose={() => setInspectorOpen(false)}
          onNotify={notify}
          onCopyText={(value) => void workspace.copyText(value)}
          onRevealPath={(value) => void workspace.revealPath(value)}
        />
      ) : null}
      <CommandPalette open={commandOpen} actions={commandActions} onClose={() => setCommandOpen(false)} />
      <SettingsModal
        open={settingsOpen}
        theme={theme}
        motionEnabled={motionEnabled}
        onMotionChange={setMotionEnabled}
        dreamAgent={workspace.snapshot.memoryOverview.dream_agent}
        runtime={settingsRuntime}
        supportedEfforts={supportedEfforts}
        modelSettings={workspace.modelSettings}
        modelSettingsLoading={workspace.modelSettingsLoading}
        agentInstructions={workspace.agentInstructions}
        agentInstructionsLoading={workspace.agentInstructionsLoading}
        updateState={updateState}
        onThemeChange={setTheme}
        onRuntimeChange={workspace.updateRuntime}
        onLoadModelSettings={workspace.loadModelSettings}
        onSaveModelProfile={workspace.saveModelProfile}
        onLoadAgentInstructions={workspace.loadAgentInstructions}
        onSaveAgentInstructions={workspace.saveAgentInstructions}
        onCheckForUpdates={() => runUpdateAction("check")}
        onDownloadUpdate={() => runUpdateAction("download")}
        onInstallUpdate={() => runUpdateAction("install")}
        onRevealPath={(path) => void workspace.revealPath(path)}
        onCopyConfigTemplate={(kind) => {
          void workspace.copyConfigTemplate(kind).then(() => notify("配置模板已复制"));
        }}
        onResetWorkspace={() => {
          void workspace.resetWorkspace().then(() => notify("工作区已重置到 main"));
        }}
        onClose={() => setSettingsOpen(false)}
      />
      <DeleteThreadDialog
        threadTitle={threadPendingDeletion?.title ?? null}
        productivity={threadPendingDeletion?.space === "productivity"}
        deleting={deletingThread}
        onCancel={() => setThreadPendingDeletion(null)}
        onConfirm={() => {
          if (!threadPendingDeletion) return;
          setDeletingThread(true);
          void workspace.deleteThread(threadPendingDeletion.id)
            .then(() => {
              setThreadPendingDeletion(null);
              notify("Thread 已删除");
            })
            .catch((error: unknown) => {
              notify(error instanceof Error ? error.message : "无法删除 thread", "error");
            })
            .finally(() => setDeletingThread(false));
        }}
      />
      <RemoveProjectDialog
        project={projectPendingRemoval}
        removing={removingProject}
        onCancel={() => setProjectPendingRemoval(null)}
        onConfirm={() => {
          if (!projectPendingRemoval) return;
          setRemovingProject(true);
          void workspace.removeProject(projectPendingRemoval.id)
            .then(() => {
              setProjectPendingRemoval(null);
              notify("项目已从侧边栏移除");
            })
            .catch((error: unknown) => {
              notify(error instanceof Error ? error.message : "无法移除项目", "error");
            })
            .finally(() => setRemovingProject(false));
        }}
      />
      <UpdateNotice
        state={updateState}
        onDownload={() => runUpdateAction("download")}
        onInstall={() => runUpdateAction("install")}
      />
      {toast ? <Toast message={toast.message} tone={toast.tone} /> : null}
    </div>
  );
}

function TitleBar({ projectName, mode }: { projectName: string; mode: string }) {
  return (
    <header className="titlebar">
      <div className="titlebar-brand"><span className="mini-brand">C</span><strong>Cleo</strong><small>Desktop</small></div>
      <div className="titlebar-context"><span>{projectName}</span><Minus size={11} /><small>{mode}</small></div>
      <div className="titlebar-runtime"><span className="runtime-dot" /><small>Local</small><Command size={13} /></div>
    </header>
  );
}
