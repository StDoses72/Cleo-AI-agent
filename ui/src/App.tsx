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
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("changes");
  const [commandOpen, setCommandOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [threadPendingDeletion, setThreadPendingDeletion] = useState<Thread | null>(null);
  const [deletingThread, setDeletingThread] = useState(false);
  const [projectPendingRemoval, setProjectPendingRemoval] = useState<Project | null>(null);
  const [removingProject, setRemovingProject] = useState(false);
  const [memoryView, setMemoryView] = useState<MemoryViewMode>("all");
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    localStorage.getItem("cleo-theme") === "light" ? "light" : "dark",
  );
  const [toast, setToast] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState>({
    phase: window.cleoDesktop ? "idle" : "unsupported",
    currentVersion: "dev",
    latestVersion: null,
    downloadedBytes: 0,
    totalBytes: 0,
    error: null,
  });
  const toastTimerRef = useRef<number | null>(null);

  const notify = (message: string) => {
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600);
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cleo-theme", theme);
  }, [theme]);

  useEffect(() => {
    const compactLayout = window.matchMedia("(max-width: 1180px)");
    const closeInspectorForCompactLayout = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setInspectorOpen(false);
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
    const operation = action === "check"
      ? desktop.checkForUpdates()
      : action === "download"
        ? desktop.downloadUpdate()
        : desktop.installUpdate();
    void operation.catch((error: unknown) => {
      notify(error instanceof Error ? error.message : "更新操作失败");
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
        shortcut: "Ctrl N",
        run: () => void workspace.createThread(),
      },
      {
        id: "workspace",
        label: "打开工作目录",
        hint: "选择本地文件夹并创建开发任务",
        icon: commandIcons.code,
        run: () => void workspace.chooseWorkspace().catch((error: unknown) => notify(error instanceof Error ? error.message : "无法打开工作目录")),
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
        onChooseWorkspace={() => void workspace.chooseWorkspace().catch((error: unknown) => notify(error instanceof Error ? error.message : "无法打开工作目录"))}
        onOpenCommand={() => setCommandOpen(true)}
        recoverableChatBackups={workspace.snapshot.backend?.recoverableChatBackups ?? 0}
        onRestoreChatHistory={() => void workspace.restoreChatHistory().catch((error: unknown) => notify(error instanceof Error ? error.message : "无法恢复旧对话"))}
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
          thread={workspace.activeThread}
          project={workspace.activeProject}
          space={workspace.activeSpace === "chat" ? "chat" : "productivity"}
          runtime={activeRuntime}
          runtimeCatalog={workspace.runtimeCatalog}
          productivityModels={workspace.productivityModels}
          runtimeModelsLoading={workspace.runtimeModelsLoading}
          runtimeModelsError={workspace.runtimeModelsError}
          running={workspace.runningThreadId !== null && workspace.runningThreadId === workspace.activeThreadId}
          sidebarCollapsed={sidebarCollapsed}
          inspectorOpen={showInspector}
          onToggleSidebar={() => setSidebarCollapsed((collapsed) => !collapsed)}
          onToggleInspector={() => setInspectorOpen((open) => !open)}
          onOpenCommand={() => setCommandOpen(true)}
          onSend={(prompt) => void workspace.sendPrompt(prompt)}
          onCancel={workspace.cancelRun}
          onSelectNonProductivityProfile={(profileId) => {
            void workspace.selectNonProductivityProfile(profileId).catch(
              (error: unknown) => notify(error instanceof Error ? error.message : "无法切换模型"),
            );
          }}
          onLoadProductivityModels={workspace.loadProductivityModels}
          onSelectProductivityRuntime={workspace.selectProductivityRuntime}
          onEffortChange={(effort) => workspace.updateRuntime({ effort })}
          attachments={workspace.attachments}
          onPickAttachments={() => void workspace.pickAttachments()}
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
          onThreadCommand={(command) => void workspace.sendPrompt(command)}
          commands={workspace.snapshot.backend?.commands[workspace.activeSpace === "chat" ? "chat" : "productivity"] ?? []}
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
        runtime={settingsRuntime}
        supportedEfforts={supportedEfforts}
        memoryOverview={workspace.snapshot.memoryOverview}
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
              notify(error instanceof Error ? error.message : "无法删除 thread");
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
              notify(error instanceof Error ? error.message : "无法移除项目");
            })
            .finally(() => setRemovingProject(false));
        }}
      />
      <UpdateNotice
        state={updateState}
        onDownload={() => runUpdateAction("download")}
        onInstall={() => runUpdateAction("install")}
      />
      {toast ? <Toast message={toast} /> : null}
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
