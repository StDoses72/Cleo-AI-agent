import { useEffect, useMemo, useRef, useState } from "react";
import { cleoClient } from "./services/cleoClient";
import { boundTimeline } from "./timeline-cache";
import { useTimelineHistory } from "./useTimelineHistory";
import { useQuestions } from "./useQuestions";
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
  const modelRequestRef = useRef(0);
  const modelCacheRef = useRef(new Map<string, ProductivityModelCatalog>());
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [approvalPendingId, setApprovalPendingId] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [draftProfileId, setDraftProfileId] = useState("");
  const [draftProvider, setDraftProvider] = useState("");
  const [draftModel, setDraftModel] = useState("");
  const [draftEffort, setDraftEffort] = useState<RuntimeProfile["effort"]>(null);
  const generationRef = useRef(0);
  const cancellingRunRef = useRef(false);
  const selectionRef = useRef(0);
  const selectionBySpaceRef = useRef<Partial<Record<ThreadSpace, {
    projectId: string;
    threadId: string | null;
  }>>>({});
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
  useEffect(() => {
    if (activeSpace === "memory" || activeProject?.space !== activeSpace
        || activeProject.id === "productivity:cleo-evolution") return;
    selectionBySpaceRef.current[activeSpace] = {
      projectId: activeProjectId,
      threadId: activeThreadId,
    };
  }, [activeSpace, activeProject, activeProjectId, activeThreadId]);

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
              thread.id === threadId ? (() => {
                const next = update(thread);
                const items = boundTimeline(next.items);
                return { ...next, items, history: next.history && {
                  ...next.history,
                  before: items.find(i => i.cursor)?.cursor ?? next.history.before,
                  after: [...items].reverse().find(i => i.cursor)?.cursor ?? next.history.after,
                  hasBefore: next.history.hasBefore || items.length < next.items.length,
                } };
              })() : thread,
            ),
          }
        : current,
    );
  };

  const history = useTimelineHistory(activeThread, updateThread);
  const questions = useQuestions(activeThread, updateThread);
  useEffect(() => {
    setSnapshot(current => current && { ...current, threads: current.threads.map(thread =>
      thread.id === activeThreadId ? thread : { ...thread, items: [] }) });
    if (activeThread?.history?.total && !activeThread.items.length) void history.load("latest");
  }, [activeThreadId]);

  const selectSpace = (space: WorkspaceSpace) => {
    if (space === activeSpace && activeProject?.id !== "productivity:cleo-evolution") return;
    selectionRef.current += 1;
    setActiveSpace(space);
    if (space === "memory" || !snapshot) return;
    const saved = selectionBySpaceRef.current[space];
    const savedProject = snapshot.projects.find(
      (project) => project.id === saved?.projectId && project.space === space,
    );
    if (saved && savedProject) {
      const savedThread = snapshot.threads.find(
        (thread) => thread.id === saved.threadId && thread.projectId === savedProject.id
          && thread.space === space,
      );
      const next = savedThread ?? (saved.threadId === null ? null : snapshot.threads.find(
        (thread) => thread.projectId === savedProject.id && thread.space === space,
      ));
      setActiveProjectId(savedProject.id);
      setActiveThreadId(next?.id ?? null);
      return;
    }
    const projectForSpace = snapshot.projects.find((project) => project.space === space
      && project.id !== "productivity:cleo-evolution");
    const preferredProjectId =
      activeProject?.space === space && activeProject.id !== "productivity:cleo-evolution"
        ? activeProjectId : projectForSpace?.id ?? activeProjectId;
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

  /** Purpose: Show an empty evolution composer with the ordinary harness picker.
   * Input: none. Output: a separate draft; existing conversations remain saved.
   */
  const beginEvolutionDraft = () => {
    selectionRef.current += 1;
    setActiveSpace("productivity");
    setActiveProjectId("productivity:cleo-evolution");
    setActiveThreadId(null);
  };

  /** Purpose: Select a managed evolution thread atomically. Input: saved id. Output: selected thread id. */
  const openEvolutionThread = async (threadId: string | null = null) => {
    if (runLockRef.current) throw new Error("请先等待当前任务完成。");
    if (!window.cleoDesktop) throw new Error("本地迭代需要在桌面应用中运行。");
    const selected = ++selectionRef.current;
    const result = await window.cleoDesktop.request<{ thread: Thread; workspace: WorkspaceSnapshot }>(
      "open_evolution_thread", { thread_id: threadId, provider: draftProvider || undefined,
        model: draftModel || undefined, effort: draftEffort ?? undefined },
    );
    if (selectionRef.current !== selected) return result.thread;
    setSnapshot(result.workspace);
    setActiveSpace("productivity");
    setActiveProjectId(result.thread.projectId);
    setActiveThreadId(result.thread.id);
    return result.thread;
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

  /** Purpose: Stream a user turn or diagnostic follow-up into a task.
   * Input: prompt, optional task, and draft preservation for controller-generated diagnostics.
   * Output: updated task timeline; diagnostic follow-ups leave draft text and attachments untouched.
   */
  const sendPrompt = async (rawPrompt: string, targetThread?: Thread, { preserveDraft = false } = {}) => {
    const prompt = rawPrompt.trim();
    if (!prompt || runLockRef.current) return;

    runLockRef.current = true;
    setStartingRun(true);
    const sourceDraftKey = draftKey;
    const pendingAttachments = preserveDraft ? [] : draft.attachments;
    updateDraft(sourceDraftKey, (current) => ({ ...current, error: undefined }));

    let thread = targetThread ?? activeThread;
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
    let turnId = userItem.id;
    userItem.turnId = turnId;
    setRunningThreadId(threadId);
    setStartingRun(false);
    if (!preserveDraft) updateDraft(sourceDraftKey, (current) => ({
      prompt: current.prompt === draft.prompt ? "" : current.prompt,
      attachments: current.attachments.filter((item) => !pendingAttachments.some((sent) => sent.path === item.path)),
    }));
    updateThread(threadId, (current) => ({
      ...current,
      title: current.items.length === 0 ? prompt.slice(0, 26) : current.title,
      summary: prompt.slice(0, 64),
      status: "running",
      updatedAt: "刚刚",
      items: history.isFollowing(threadId) ? [...current.items, userItem] : current.items,
    }));

    let failed = false;
    try {
      for await (const event of cleoClient.streamTurn(threadId, prompt, pendingAttachments)) {
        if (generationRef.current !== generation) return;
        if (event.type === "turn-started") {
          turnId = event.item.turnId ?? event.item.id;
          updateThread(threadId, current => ({ ...current, items: current.items.map(item => item.id === userItem.id ? event.item : item) }));
        } else if (event.type === "upsert-item") {
          const projected = { ...event.item, turnId: event.item.turnId ?? turnId };
          const following = history.isFollowing(threadId);
          if (!following) history.notify(threadId);
          updateThread(threadId, (current) => {
            const index = current.items.findIndex((item) => item.id === projected.id);
            const items = [...current.items];
            if (index >= 0) items[index] = projected;
            else if (following && (projected.order === undefined || items[0]?.order === undefined || projected.order >= items[0].order)) items.push(projected);
            items.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
            const answered = projected.type === "message" && projected.role === "assistant" && projected.content.trim();
            return { ...current, items: answered ? items.map(item => item.turnId === projected.turnId ? { ...item, turnHasAnswer: true } : item) : items,
              history: current.history && { ...current.history, hasAfter: current.history.hasAfter || !following } };
          });
        } else if (event.type === "question-request") {
          if (!history.isFollowing(threadId)) {
            history.notify(threadId);
            updateThread(threadId, current => ({ ...current, history: current.history && { ...current.history, hasAfter: true } }));
          }
          questions.receive({ ...event.request, threadId }, turnId, history.isFollowing(threadId));
        } else if (event.type === "question-resolved") {
          questions.resolve(threadId, event.request);
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
        questions.finish(threadId);
        if (history.isFollowing(threadId) && thread.history) await history.load("latest");
      }
    }
  };

  const cancelRun = async () => {
    const threadId = runningThreadId;
    if (!threadId || cancellingRunRef.current) return;
    cancellingRunRef.current = true;
    const previousGeneration = generationRef.current;
    try {
      await cleoClient.cancelRun(threadId);
    } catch (error) {
      updateThread(threadId, (current) => ({
        ...current,
        items: [...current.items, {
          id: `${threadId}-cancel-error-${Date.now()}`,
          type: "notice",
          tone: "warning",
          title: "停止失败",
          detail: error instanceof Error ? error.message : "请重试停止操作。",
        }],
      }));
      return;
    } finally {
      cancellingRunRef.current = false;
    }
    // A completed stream may already have allowed a newer run to start.
    if (generationRef.current !== previousGeneration) return;
    generationRef.current += 1;
    runLockRef.current = false;
    setRunningThreadId(null);
    questions.finish(threadId);
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
    if (history.isFollowing(threadId)) await history.load("latest");
  };

  const resolveApproval = async (decision: ApprovalDecision) => {
    const request = pendingApprovals.find(candidate => candidate.threadId === activeThreadId);
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

  /** Purpose: Discover models in the task directory without mixing provider responses.
   * Input: harness, project path and explicit refresh. Output: catalog or visible error.
   */
  const loadProductivityModels = async (
    provider: string, projectPath = activeProject?.path, refresh = false,
  ) => {
    const request = ++modelRequestRef.current;
    const cacheKey = JSON.stringify([provider, projectPath]);
    const cached = refresh ? undefined : modelCacheRef.current.get(cacheKey);
    if (cached) {
      setProductivityModels((current) => ({ ...current, [provider]: cached }));
      setRuntimeModelsError(null);
      setRuntimeModelsLoading(null);
      return cached;
    }
    setRuntimeModelsLoading(provider);
    setRuntimeModelsError(null);
    try {
      const loaded = await cleoClient.getProductivityModels(provider, projectPath);
      modelCacheRef.current.set(cacheKey, loaded);
      if (modelRequestRef.current !== request) return loaded;
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
      const message = error instanceof Error && error.message ? error.message : "无法读取模型列表，请重试";
      if (modelRequestRef.current === request) setRuntimeModelsError(message);
      throw error;
    } finally {
      if (modelRequestRef.current === request) setRuntimeModelsLoading(null);
    }
  };

  /** Purpose: Start a task with the chosen harness while retaining its unsent draft.
   * Input: harness and model IDs. Output: updated draft selection; history stays intact.
   */
  const selectProductivityRuntime = (provider: string, model: string) => {
    setDraftProvider(provider);
    setDraftModel(model);
    const selectedModel = productivityModels[provider]?.models.find(
      (candidate) => candidate.id === model,
    );
    setDraftEffort(selectedModel?.defaultEffort ?? null);
    if (
      activeThread?.space === "productivity"
      && activeThread.runtime?.provider === provider
      && activeThread.runtime?.model === model
    ) return;
    updateDraft(`new:productivity:${activeProjectId}`, () => draft);
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
    try {
      const refreshed = await cleoClient.reviewMemorySource(source, action);
      setSnapshot(refreshed);
      return refreshed;
    } catch (error) {
      // Show the persisted failure/checkpoint state while preserving the original error.
      try {
        setSnapshot(await cleoClient.loadWorkspace());
      } catch (refreshError) {
        setLoadingError(refreshError instanceof Error ? refreshError.message : "无法刷新记忆状态");
      }
      throw error;
    }
  };
  const loadMemoryReviewDetails = (source: MemoryReviewSource) =>
    cleoClient.getMemoryReviewDetails(source);

  return {
    history,
    questions,
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
    openEvolutionThread,
    beginEvolutionDraft,
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
