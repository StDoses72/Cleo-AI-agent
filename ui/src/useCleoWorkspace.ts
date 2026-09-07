import { useEffect, useMemo, useRef, useState } from "react";
import { cleoClient } from "./services/cleoClient";
import type {
  AgentInstructions,
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  ApplyModelSettings,
  ModelSettings,
  MemoryReviewAction,
  MemoryReviewSource,
  ProductivityModelCatalog,
  RuntimeCatalog,
  RuntimeProfile,
  Thread,
  ThreadSpace,
  TimelineItem,
  WorkspaceSnapshot,
  WorkspaceSpace,
} from "./types";

function currentTime() {
  return new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function mergeAttachments(current: Attachment[], selected: Attachment[]) {
  const paths = new Set(current.map((attachment) => attachment.path));
  return [...current, ...selected.filter((attachment) => {
    if (paths.has(attachment.path)) return false;
    paths.add(attachment.path);
    return true;
  })];
}

interface ComposerDraft {
  prompt: string;
  attachments: Attachment[];
  error?: string;
}

const emptyDraft: ComposerDraft = { prompt: "", attachments: [] };

export function useCleoWorkspace() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [activeSpace, setActiveSpace] = useState<WorkspaceSpace>("productivity");
  const [activeProjectId, setActiveProjectId] = useState("cleo-agent");
  const [activeThreadId, setActiveThreadId] = useState<string | null>("desktop-ui");
  const [runningThreadId, setRunningThreadId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({});
  const [startingRun, setStartingRun] = useState(false);
  const runLockRef = useRef(false);
  const [modelSettings, setModelSettings] = useState<ModelSettings | null>(null);
  const [modelSettingsLoading, setModelSettingsLoading] = useState(false);
  const [agentInstructions, setAgentInstructions] = useState<AgentInstructions | null>(null);
  const [agentInstructionsLoading, setAgentInstructionsLoading] = useState(false);
  const [runtimeCatalog, setRuntimeCatalog] = useState<RuntimeCatalog | null>(null);
  const [productivityModels, setProductivityModels] = useState<Record<string, ProductivityModelCatalog>>({});
  const [runtimeModelsLoading, setRuntimeModelsLoading] = useState<string | null>(null);
  const [runtimeModelsError, setRuntimeModelsError] = useState<string | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [approvalPendingId, setApprovalPendingId] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [draftProfileId, setDraftProfileId] = useState("");
  const [draftProvider, setDraftProvider] = useState("");
  const [draftModel, setDraftModel] = useState("");
  const [draftEffort, setDraftEffort] = useState<RuntimeProfile["effort"]>(null);
  const generationRef = useRef(0);
  const selectionRef = useRef(0);
  const draftKey = activeThreadId ?? `new:${activeSpace}:${activeProjectId}`;
  const draft = drafts[draftKey] ?? emptyDraft;
  const updateDraft = (key: string, update: (draft: ComposerDraft) => ComposerDraft) => {
    setDrafts((current) => ({ ...current, [key]: update(current[key] ?? emptyDraft) }));
  };
  const setPrompt = (prompt: string) => {
    updateDraft(draftKey, (current) => ({ ...current, prompt, error: undefined }));
  };
  const appendAttachments = (selected: Attachment[], key = draftKey) => {
    updateDraft(key, (current) => ({ ...current, attachments: mergeAttachments(current.attachments, selected) }));
  };

  useEffect(() => {
    let active = true;
    Promise.all([cleoClient.loadWorkspace(), cleoClient.getRuntimeCatalog()])
      .then(([loaded, catalog]) => {
        if (!active) return;
        setSnapshot(loaded);
        setRuntimeCatalog(catalog);
        setDraftProfileId(catalog.defaultNonProductivityProfile);
        setDraftProvider(catalog.defaultProductivityProvider);
        setDraftModel(
          catalog.productivityProviders.find(
            (provider) => provider.id === catalog.defaultProductivityProvider,
          )?.defaultModel ?? "",
        );
        const initialThread = loaded.threads.find(
          (thread) => thread.id === loaded.activeThreadId,
        ) ?? loaded.threads[0];
        if (initialThread) {
          setActiveSpace(initialThread.space);
          setActiveProjectId(initialThread.projectId);
          setActiveThreadId(initialThread.id);
        } else {
          const initialSpace = loaded.activeSpace ?? "productivity";
          const initialProject = loaded.projects.find((project) => project.space === initialSpace);
          setActiveSpace(initialSpace);
          setActiveProjectId(initialProject?.id ?? loaded.projects[0]?.id ?? "");
          setActiveThreadId(null);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setLoadingError(error instanceof Error ? error.message : "无法加载本地工作区");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const activeThread = useMemo(
    () => snapshot?.threads.find((thread) => thread.id === activeThreadId) ?? null,
    [activeThreadId, snapshot],
  );
  const activeProject = useMemo(
    () => snapshot?.projects.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, snapshot],
  );
  const draftRuntime = useMemo<RuntimeProfile>(() => {
    if (activeSpace === "chat") {
      const profile = runtimeCatalog?.nonProductivityProfiles.find(
        (candidate) => candidate.id === draftProfileId,
      ) ?? runtimeCatalog?.nonProductivityProfiles[0];
      return {
        profileId: profile?.id,
        provider: profile?.provider ?? "Cleo",
        model: profile?.model ?? "选择模型",
        effort: "high",
        access: "workspace-write",
        approval: "Cleo 工具策略",
        contextWindow: profile?.maxTokens,
        editable: false,
      };
    }
    const provider = runtimeCatalog?.productivityProviders.find(
      (candidate) => candidate.id === draftProvider,
    );
    return {
      provider: (provider?.id ?? draftProvider) || "选择 SDK / ACP",
      model: draftModel || provider?.defaultModel || "选择模型",
      effort: draftEffort,
      access: "workspace-write",
      approval: "default",
      contextWindow: 128000,
      editable: false,
    };
  }, [activeSpace, draftEffort, draftModel, draftProfileId, draftProvider, runtimeCatalog]);

  const updateThread = (threadId: string, update: (thread: Thread) => Thread) => {
    setSnapshot((current) =>
      current
        ? {
            ...current,
            threads: current.threads.map((thread) =>
              thread.id === threadId ? update(thread) : thread,
            ),
          }
        : current,
    );
  };

  const selectSpace = (space: WorkspaceSpace) => {
    selectionRef.current += 1;
    setActiveSpace(space);
    if (space === "memory" || !snapshot) return;
    const projectForSpace = snapshot.projects.find((project) => project.space === space);
    const preferredProjectId =
      activeProject?.space === space ? activeProjectId : projectForSpace?.id ?? activeProjectId;
    const next =
      snapshot.threads.find(
        (thread) => thread.space === space && thread.projectId === preferredProjectId,
      ) ?? snapshot.threads.find((thread) => thread.space === space);
    if (next) {
      setActiveProjectId(next.projectId);
      setActiveThreadId(next.id);
    } else {
      if (projectForSpace) setActiveProjectId(projectForSpace.id);
      setActiveThreadId(null);
    }
  };

  const selectProject = (projectId: string) => {
    selectionRef.current += 1;
    setActiveProjectId(projectId);
    if (!snapshot || activeSpace === "memory") return;
    const next = snapshot.threads.find(
      (thread) => thread.space === activeSpace && thread.projectId === projectId,
    );
    setActiveThreadId(next?.id ?? null);
  };

  const selectThread = (threadId: string) => {
    const thread = snapshot?.threads.find((candidate) => candidate.id === threadId);
    if (!thread) return;
    const selection = ++selectionRef.current;
    setActiveSpace(thread.space);
    setActiveProjectId(thread.projectId);
    setActiveThreadId(threadId);
    void cleoClient
      .loadThread(threadId)
      .then((loaded) => {
        if (selectionRef.current !== selection) return;
        updateThread(threadId, () => loaded);
        setActiveSpace(loaded.space);
        setActiveProjectId(loaded.projectId);
      })
      .catch((error: unknown) => {
        if (selectionRef.current !== selection) return;
        setLoadingError(error instanceof Error ? error.message : "无法恢复历史记录");
      });
  };

  const startNewThread = () => {
    selectionRef.current += 1;
    if (activeSpace === "chat" && runtimeCatalog?.defaultNonProductivityProfile) {
      setDraftProfileId(runtimeCatalog.defaultNonProductivityProfile);
    }
    if (activeThread?.space === "productivity") {
      setDraftProvider(activeThread.runtime?.provider ?? draftProvider);
      setDraftModel(activeThread.runtime?.model ?? draftModel);
      setDraftEffort(activeThread.runtime?.effort ?? draftEffort);
    }
    setActiveThreadId(null);
  };

  const createThread = async () => {
    const selection = ++selectionRef.current;
    const space: ThreadSpace = activeSpace === "chat" ? "chat" : "productivity";
    const project = snapshot?.projects.find(
      (candidate) => candidate.id === activeProjectId && candidate.space === space,
    ) ?? snapshot?.projects.find((candidate) => candidate.space === space);
    if (!project) throw new Error("请先打开一个工作目录。");
    const thread = await cleoClient.createThread(
      space,
      project.id,
      space === "chat"
        ? {
            projectPath: project.path,
            profileId: draftProfileId || runtimeCatalog?.defaultNonProductivityProfile,
          }
        : {
            projectPath: project.path,
            provider: draftProvider || runtimeCatalog?.defaultProductivityProvider,
            model: draftModel || undefined,
            effort: draftEffort ?? undefined,
          },
    );
    setSnapshot((current) =>
      current ? { ...current, threads: [thread, ...current.threads] } : current,
    );
    if (selectionRef.current === selection) setActiveThreadId(thread.id);
    return thread;
  };

  const chooseWorkspace = async () => {
    const projectPath = await cleoClient.pickWorkspace();
    if (!projectPath) return null;
    const space: ThreadSpace = activeSpace === "chat" ? "chat" : "productivity";
    const name = projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace";
    const projectId = `${space}:${name}`;
    const refreshed = await cleoClient.addProject(space, projectPath);
    setSnapshot(refreshed);
    setActiveSpace(space);
    setActiveProjectId(projectId);
    setActiveThreadId(null);
    return projectPath;
  };

  const sendPrompt = async (rawPrompt: string) => {
    const prompt = rawPrompt.trim();
    if (!prompt || runLockRef.current) return;

    runLockRef.current = true;
    setStartingRun(true);
    const sourceDraftKey = draftKey;
    const pendingAttachments = draft.attachments;
    updateDraft(sourceDraftKey, (current) => ({ ...current, error: undefined }));

    let thread = activeThread;
    try {
      if (!thread) thread = await createThread();
    } catch (error) {
      updateDraft(sourceDraftKey, (current) => ({
        ...current,
        error: error instanceof Error ? error.message : "无法创建对话，请重试。",
      }));
      runLockRef.current = false;
      setStartingRun(false);
      return;
    }

    const threadId = thread.id;
    const generation = ++generationRef.current;
    const userItem: TimelineItem = {
      id: `${threadId}-user-${Date.now()}`,
      type: "message",
      role: "user",
      content: prompt,
      time: currentTime(),
    };
    setRunningThreadId(threadId);
    setStartingRun(false);
    updateDraft(sourceDraftKey, (current) => ({
      prompt: current.prompt === draft.prompt ? "" : current.prompt,
      attachments: current.attachments.filter((item) => !pendingAttachments.some((sent) => sent.path === item.path)),
    }));
    updateThread(threadId, (current) => ({
      ...current,
      title: current.items.length === 0 ? prompt.slice(0, 26) : current.title,
      summary: prompt.slice(0, 64),
      status: "running",
      updatedAt: "刚刚",
      items: [...current.items, userItem],
    }));

    let failed = false;
    try {
      for await (const event of cleoClient.streamTurn(threadId, prompt, pendingAttachments)) {
        if (generationRef.current !== generation) return;
        if (event.type === "upsert-item") {
          updateThread(threadId, (current) => {
            const index = current.items.findIndex((item) => item.id === event.item.id);
            const items = [...current.items];
            if (index >= 0) items[index] = event.item;
            else items.push(event.item);
            return { ...current, items };
          });
        } else if (event.type === "changes") {
          updateThread(threadId, (current) => ({ ...current, changes: event.changes }));
        } else if (event.type === "change-history") {
          updateThread(threadId, (current) => ({
            ...current,
            changeHistory: [
              event.changeSet,
              ...(current.changeHistory ?? []).filter(
                (changeSet) => changeSet.id !== event.changeSet.id,
              ),
            ],
          }));
        } else if (event.type === "usage") {
          updateThread(threadId, (current) => ({ ...current, usage: event.usage }));
        } else if (event.type === "terminal") {
          updateThread(threadId, (current) => ({
            ...current,
            terminal: [...(current.terminal ?? []), event.chunk],
          }));
        } else if (event.type === "refresh") {
          const refreshed = await cleoClient.loadWorkspace();
          setSnapshot(refreshed);
          const next = refreshed.threads.find((item) => item.id === event.activeThreadId);
          setActiveSpace(event.space);
          setActiveThreadId(event.activeThreadId);
          if (next) setActiveProjectId(next.projectId);
        } else if (event.type === "navigate-space") {
          selectSpace(event.space);
        } else if (event.type === "request-attachment") {
          const selected = await cleoClient.pickAttachments();
          appendAttachments(selected, threadId);
        } else if (event.type === "approval-request") {
          const request = { ...event.request, threadId };
          setPendingApprovals((current) => [
            ...current.filter((candidate) => candidate.id !== request.id),
            request,
          ]);
          setApprovalError(null);
        } else if (event.type === "approval-resolved") {
          setPendingApprovals((current) => current.filter(
            (candidate) => candidate.id !== event.response.id,
          ));
        } else if (event.type === "done") {
          updateThread(threadId, (current) => ({
            ...current,
            summary: event.summary,
            status: "completed",
          }));
        } else if (event.type === "error") {
          failed = true;
          updateThread(threadId, (current) => ({
            ...current,
            status: "attention",
            items: [
              ...current.items,
              {
                id: `${threadId}-error-${Date.now()}`,
                type: "notice",
                tone: "warning",
                title: "任务已暂停",
                detail: event.message,
              },
            ],
          }));
        }
      }
    } catch (error) {
      failed = true;
      updateThread(threadId, (current) => ({
        ...current,
        status: "attention",
        items: [
          ...current.items,
          {
            id: `${threadId}-error-${Date.now()}`,
            type: "notice",
            tone: "warning",
            title: "运行时暂时不可用",
            detail: error instanceof Error ? error.message : "请稍后重试。",
          },
        ],
      }));
    } finally {
      if (generationRef.current === generation) {
        if (!failed) {
          updateThread(threadId, (current) =>
            current.status === "running" ? { ...current, status: "completed" } : current,
          );
        }
        setRunningThreadId(null);
        runLockRef.current = false;
        setPendingApprovals((current) => current.filter(
          (candidate) => candidate.threadId !== threadId,
        ));
      }
    }
  };

  const cancelRun = () => {
    const threadId = runningThreadId;
    if (!threadId) return;
    generationRef.current += 1;
    runLockRef.current = false;
    setRunningThreadId(null);
    void cleoClient.cancelRun(threadId);
    setPendingApprovals((current) => current.filter(
      (candidate) => candidate.threadId !== threadId,
    ));
    updateThread(threadId, (current) => ({
      ...current,
      status: "attention",
      items: [
        ...current.items,
        {
          id: `${threadId}-cancelled-${Date.now()}`,
          type: "notice",
          tone: "info",
          title: "已停止当前运行",
          detail: "可以修改提示后再次发送。",
        },
      ],
    }));
  };

  const resolveApproval = async (decision: ApprovalDecision) => {
    const request = pendingApprovals[0];
    if (!request || approvalPendingId) return;
    setApprovalPendingId(request.id);
    setApprovalError(null);
    try {
      await cleoClient.resolveApproval(request.threadId, request.id, decision);
      setPendingApprovals((current) => current.filter(
        (candidate) => candidate.id !== request.id,
      ));
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : "无法提交审批决定");
    } finally {
      setApprovalPendingId(null);
    }
  };

  const renameThread = async (title: string) => {
    const threadId = activeThreadId;
    if (!threadId || !title.trim()) throw new Error("请输入会话名称。");
    if (runLockRef.current) throw new Error("请等待当前运行完成后重命名。");
    runLockRef.current = true;
    setStartingRun(true);
    try {
      for await (const event of cleoClient.streamTurn(threadId, `/rename ${title.trim()}`)) {
        if (event.type === "error") throw new Error(event.message);
      }
      const renamed = await cleoClient.loadThread(threadId);
      updateThread(threadId, () => renamed);
    } finally {
      runLockRef.current = false;
      setStartingRun(false);
    }
  };

  const updateRuntime = (update: Partial<RuntimeProfile>) => {
    if (activeSpace === "productivity" && update.effort) {
      setDraftEffort(update.effort);
    }
    const threadId = activeThreadId;
    if (!threadId) return;
    void cleoClient
      .updateRuntime(threadId, update)
      .then((runtime) => {
        setSnapshot((current) =>
          current
            ? {
                ...current,
                runtime,
                threads: current.threads.map((thread) =>
                  thread.id === threadId ? { ...thread, runtime } : thread,
                ),
              }
            : current,
        );
      })
      .catch((error: unknown) => {
        setLoadingError(error instanceof Error ? error.message : "无法更新运行参数");
      });
  };

  const selectNonProductivityProfile = async (profileId: string) => {
    setDraftProfileId(profileId);
    if (activeSpace !== "chat" || !activeThreadId) return;
    const runtime = await cleoClient.updateRuntime(activeThreadId, { profileId });
    setSnapshot((current) => current
      ? {
          ...current,
          runtime,
          threads: current.threads.map((thread) =>
            thread.id === activeThreadId ? { ...thread, runtime } : thread),
        }
      : current);
  };

  const loadProductivityModels = async (provider: string) => {
    const cached = productivityModels[provider];
    if (cached) return cached;
    setRuntimeModelsLoading(provider);
    setRuntimeModelsError(null);
    try {
      const loaded = await cleoClient.getProductivityModels(provider, activeProject?.path);
      setProductivityModels((current) => ({ ...current, [provider]: loaded }));
      if (provider === draftProvider) {
        const selectedModel = loaded.models.find((candidate) => candidate.id === draftModel);
        if (selectedModel) {
          setDraftEffort((current) =>
            current && selectedModel.supportedEfforts.includes(current)
              ? current
              : selectedModel.defaultEffort ?? selectedModel.supportedEfforts[0] ?? null,
          );
        }
      }
      return loaded;
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法读取模型列表";
      setRuntimeModelsError(message);
      throw error;
    } finally {
      setRuntimeModelsLoading(null);
    }
  };

  const selectProductivityRuntime = (provider: string, model: string) => {
    setDraftProvider(provider);
    setDraftModel(model);
    const selectedModel = productivityModels[provider]?.models.find(
      (candidate) => candidate.id === model,
    );
    if (selectedModel && (
      draftEffort === null || !selectedModel.supportedEfforts.includes(draftEffort)
    )) {
      setDraftEffort(selectedModel.defaultEffort ?? selectedModel.supportedEfforts[0] ?? null);
    }
    if (
      activeThread?.space === "productivity"
      && activeThread.runtime?.provider === provider
      && activeThread.runtime?.model === model
    ) return;
    setActiveSpace("productivity");
    setActiveThreadId(null);
  };

  const pickAttachments = async () => {
    const selected = await cleoClient.pickAttachments();
    appendAttachments(selected);
  };

  const prepareAttachments = async (files: File[]) => {
    const selected = await cleoClient.prepareAttachments(files);
    appendAttachments(selected);
  };

  const removeAttachment = (path: string) => {
    updateDraft(draftKey, (current) => ({
      ...current,
      attachments: current.attachments.filter((item) => item.path !== path),
    }));
  };

  const copyText = (value: string) => cleoClient.copyText(value);
  const revealPath = (value: string) => cleoClient.revealPath(value);
  const openLocalPath = (href: string, workspacePath: string) => (
    cleoClient.openLocalPath(href, workspacePath)
  );
  const copyConfigTemplate = async (kind: "cleo" | "harnesses") => {
    const templates = await cleoClient.getConfigTemplates();
    await cleoClient.copyText(templates[kind]);
  };
  const resetWorkspace = async () => {
    await cleoClient.resetWorkspace();
    const refreshed = await cleoClient.loadWorkspace();
    setSnapshot(refreshed);
  };
  const undoChanges = async () => {
    if (!activeThread || activeThread.space !== "productivity") {
      throw new Error("只有开发任务可以回退 Git 改动。");
    }
    if (runningThreadId === activeThread.id) {
      throw new Error("任务正在运行，请先停止后再回退。");
    }
    const result = await cleoClient.undoChanges(activeThread.id);
    setSnapshot(result.workspace);
    return result;
  };
  const restoreChatHistory = async () => {
    const refreshed = await cleoClient.restoreChatBackups();
    setSnapshot(refreshed);
    const restored = refreshed.threads.find(
      (thread) => thread.id === refreshed.activeThreadId && thread.space === "chat",
    ) ?? refreshed.threads.find((thread) => thread.space === "chat");
    setActiveSpace("chat");
    if (restored) {
      setActiveProjectId(restored.projectId);
      setActiveThreadId(restored.id);
    }
    return refreshed;
  };
  const deleteThread = async (threadId: string) => {
    if (runningThreadId === threadId) {
      throw new Error("正在运行的 thread 不能删除，请先停止运行。");
    }
    const deleted = snapshot?.threads.find((thread) => thread.id === threadId);
    const deletedWasActive = activeThreadId === threadId;
    selectionRef.current += 1;
    const refreshed = await cleoClient.deleteThread(threadId);
    setSnapshot(refreshed);
    if (deletedWasActive) {
      const replacement = refreshed.threads.find(
        (thread) =>
          thread.id === refreshed.activeThreadId && thread.space === deleted?.space,
      ) ?? refreshed.threads.find(
        (thread) =>
          thread.space === deleted?.space && thread.projectId === deleted?.projectId,
      ) ?? refreshed.threads.find((thread) => thread.space === deleted?.space);
      setActiveThreadId(replacement?.id ?? null);
      if (replacement) {
        setActiveSpace(replacement.space);
        setActiveProjectId(replacement.projectId);
      }
    }
    return refreshed;
  };
  const removeProject = async (projectId: string) => {
    const removed = snapshot?.projects.find((project) => project.id === projectId);
    if (!removed) throw new Error("找不到要移除的项目。");
    const refreshed = await cleoClient.removeProject(projectId);
    setSnapshot(refreshed);
    const preservedProject = refreshed.projects.find(
      (project) => project.id === activeProjectId,
    );
    if (preservedProject && activeProjectId !== projectId) return refreshed;
    const replacementProject = refreshed.projects.find(
      (project) => project.space === removed.space,
    );
    const replacementThread = replacementProject
      ? refreshed.threads.find((thread) => thread.projectId === replacementProject.id)
      : undefined;
    setActiveProjectId(replacementProject?.id ?? "");
    setActiveThreadId(replacementThread?.id ?? null);
    return refreshed;
  };
  const loadModelSettings = async () => {
    setModelSettingsLoading(true);
    try {
      const loaded = await cleoClient.getModelSettings();
      setModelSettings(loaded);
      return loaded;
    } finally {
      setModelSettingsLoading(false);
    }
  };
  const applyModelSettings: ApplyModelSettings = async (operation) => {
    setModelSettingsLoading(true);
    try {
      const saved = await operation();
      setModelSettings(saved);
      setRuntimeCatalog(current => current && ({
        ...current,
        nonProductivityProfiles: saved.profiles.map(profile => ({
          id: profile.name, provider: profile.provider, model: profile.model,
          maxTokens: profile.maxTokens, active: profile.name === saved.activeAgent,
        })),
        defaultNonProductivityProfile: saved.activeAgent,
      }));
      setDraftProfileId(current => !saved.profiles.some(profile => profile.name === current)
        || (!activeThreadId && saved.activeAgent !== modelSettings?.activeAgent)
        ? saved.activeAgent : current);
      return saved;
    } finally {
      setModelSettingsLoading(false);
    }
  };
  const loadAgentInstructions = async () => {
    setAgentInstructionsLoading(true);
    try {
      const loaded = await cleoClient.getAgentInstructions();
      setAgentInstructions(loaded);
      return loaded;
    } finally {
      setAgentInstructionsLoading(false);
    }
  };
  const saveAgentInstructions = async (content: string) => {
    setAgentInstructionsLoading(true);
    try {
      const saved = await cleoClient.saveAgentInstructions(content);
      setAgentInstructions(saved);
      return saved;
    } finally {
      setAgentInstructionsLoading(false);
    }
  };
  const reviewMemorySource = async (
    source: MemoryReviewSource,
    action: MemoryReviewAction,
  ) => {
    const refreshed = await cleoClient.reviewMemorySource(source, action);
    setSnapshot(refreshed);
    return refreshed;
  };
  const loadMemoryReviewDetails = (source: MemoryReviewSource) =>
    cleoClient.getMemoryReviewDetails(source);

  return {
    snapshot,
    loadingError,
    activeSpace,
    activeProject,
    activeProjectId,
    activeThread,
    activeThreadId,
    runningThreadId,
    draftRuntime,
    attachments: draft.attachments,
    prompt: draft.prompt,
    setPrompt,
    sendError: draft.error,
    startingRun,
    modelSettings,
    modelSettingsLoading,
    agentInstructions,
    agentInstructionsLoading,
    runtimeCatalog,
    productivityModels,
    runtimeModelsLoading,
    runtimeModelsError,
    pendingApprovals,
    approvalPendingId,
    approvalError,
    selectSpace,
    selectProject,
    selectThread,
    createThread: startNewThread,
    chooseWorkspace,
    sendPrompt,
    renameThread,
    cancelRun,
    resolveApproval,
    updateRuntime,
    selectNonProductivityProfile,
    loadProductivityModels,
    selectProductivityRuntime,
    pickAttachments,
    prepareAttachments,
    removeAttachment,
    copyText,
    revealPath,
    openLocalPath,
    copyConfigTemplate,
    undoChanges,
    resetWorkspace,
    restoreChatHistory,
    deleteThread,
    removeProject,
    loadModelSettings,
    applyModelSettings,
    loadAgentInstructions,
    saveAgentInstructions,
    loadMemoryReviewDetails,
    reviewMemorySource,
  };
}
