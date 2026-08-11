import { useEffect, useMemo, useRef, useState } from "react";
import { cleoClient } from "./services/cleoClient";
import type {
  Attachment,
  ModelProfileInput,
  ModelSettings,
  MemoryReviewAction,
  MemoryReviewSource,
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

export function useCleoWorkspace() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [activeSpace, setActiveSpace] = useState<WorkspaceSpace>("productivity");
  const [activeProjectId, setActiveProjectId] = useState("cleo-agent");
  const [activeThreadId, setActiveThreadId] = useState<string | null>("desktop-ui");
  const [runningThreadId, setRunningThreadId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [modelSettings, setModelSettings] = useState<ModelSettings | null>(null);
  const [modelSettingsLoading, setModelSettingsLoading] = useState(false);
  const generationRef = useRef(0);

  useEffect(() => {
    let active = true;
    cleoClient
      .loadWorkspace()
      .then((loaded) => {
        if (!active) return;
        setSnapshot(loaded);
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
    setActiveSpace(thread.space);
    setActiveProjectId(thread.projectId);
    setActiveThreadId(threadId);
  };

  const createThread = async () => {
    const space: ThreadSpace = activeSpace === "chat" ? "chat" : "productivity";
    const projectId =
      snapshot?.projects.find((project) => project.id === activeProjectId && project.space === space)
        ?.id ?? snapshot?.projects.find((project) => project.space === space)?.id ?? activeProjectId;
    const thread = await cleoClient.createThread(space, projectId);
    setSnapshot((current) =>
      current ? { ...current, threads: [thread, ...current.threads] } : current,
    );
    setActiveThreadId(thread.id);
    return thread;
  };

  const chooseWorkspace = async () => {
    const projectPath = await cleoClient.pickWorkspace();
    if (!projectPath) return null;
    const thread = await cleoClient.createThread("productivity", "", projectPath);
    const refreshed = await cleoClient.loadWorkspace();
    setSnapshot(refreshed);
    setActiveSpace("productivity");
    setActiveProjectId(thread.projectId);
    setActiveThreadId(thread.id);
    return thread;
  };

  const sendPrompt = async (rawPrompt: string) => {
    const prompt = rawPrompt.trim();
    if (!prompt || runningThreadId !== null) return;

    let thread = activeThread;
    if (!thread) thread = await createThread();
    if (!thread) return;

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
      const pendingAttachments = attachments;
      setAttachments([]);
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
          setAttachments((current) => [...current, ...selected]);
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
      }
    }
  };

  const cancelRun = () => {
    const threadId = runningThreadId;
    if (!threadId) return;
    generationRef.current += 1;
    setRunningThreadId(null);
    void cleoClient.cancelRun(threadId);
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

  const updateRuntime = (update: Partial<RuntimeProfile>) => {
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

  const pickAttachments = async () => {
    const selected = await cleoClient.pickAttachments();
    setAttachments((current) => [...current, ...selected]);
  };

  const removeAttachment = (path: string) => {
    setAttachments((current) => current.filter((item) => item.path !== path));
  };

  const copyText = (value: string) => cleoClient.copyText(value);
  const revealPath = (value: string) => cleoClient.revealPath(value);
  const copyConfigTemplate = async (kind: "cleo" | "harnesses") => {
    const templates = await cleoClient.getConfigTemplates();
    await cleoClient.copyText(templates[kind]);
  };
  const resetWorkspace = async () => {
    await cleoClient.resetWorkspace();
    const refreshed = await cleoClient.loadWorkspace();
    setSnapshot(refreshed);
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
  const saveModelProfile = async (profile: ModelProfileInput) => {
    setModelSettingsLoading(true);
    try {
      const saved = await cleoClient.saveModelProfile(profile);
      setModelSettings(saved);
      const refreshed = await cleoClient.loadWorkspace();
      setSnapshot(refreshed);
      return saved;
    } finally {
      setModelSettingsLoading(false);
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

  return {
    snapshot,
    loadingError,
    activeSpace,
    activeProject,
    activeProjectId,
    activeThread,
    activeThreadId,
    runningThreadId,
    attachments,
    modelSettings,
    modelSettingsLoading,
    selectSpace,
    selectProject,
    selectThread,
    createThread,
    chooseWorkspace,
    sendPrompt,
    cancelRun,
    updateRuntime,
    pickAttachments,
    removeAttachment,
    copyText,
    revealPath,
    copyConfigTemplate,
    resetWorkspace,
    loadModelSettings,
    saveModelProfile,
    reviewMemorySource,
  };
}
