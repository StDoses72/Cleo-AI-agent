import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { requestKey } from "./request-key";
import { cleoClient } from "./services/cleoClient";
import { boundTimeline } from "./timeline-cache";
import { useTimelineHistory } from "./useTimelineHistory";
import { useQuestions } from "./useQuestions";
import type {
  LocalSkill,
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
  RuntimeUpdate,
  SteerReceipt,
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

const EVOLUTION_PROJECT = "productivity:cleo-evolution";

export function useCleoWorkspace(evolutionOpen = false) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [memoryRefreshing, setMemoryRefreshing] = useState(false);
  const memoryRevision = useRef(0);
  const memoryRefresh = useRef<Promise<void> | null>(null);
  const refreshMemory = useCallback(() => {
    memoryRevision.current++;
    if (memoryRefresh.current) return memoryRefresh.current;
    const read = async () => {
      setMemoryRefreshing(true);
      let revision: number;
      do {
        revision = memoryRevision.current;
        try {
          const memory = await cleoClient.loadMemory();
          if (revision === memoryRevision.current) {
            setSnapshot(current => current && { ...current, ...memory });
            setMemoryError(null);
          }
        } catch (error) {
          if (revision === memoryRevision.current) setMemoryError(error instanceof Error ? error.message : "无法刷新记忆");
        }
      } while (revision !== memoryRevision.current);
    };
    memoryRefresh.current = read().finally(() => { memoryRefresh.current = null; setMemoryRefreshing(false); });
    return memoryRefresh.current;
  }, []);
  const [bootstrapVersion, setBootstrapVersion] = useState(0);
  const loadingRetry = useRef<(() => void) | null>(null);
  const clearLoadingError = () => { setLoadingError(null); loadingRetry.current = null; };
  const retryLoading = () => {
    const retry = loadingRetry.current;
    clearLoadingError();
    if (retry) retry(); else setBootstrapVersion(version => version + 1);
  };
  // Navigation is local to each view; the shared snapshot still owns all timelines by ID.
  const [workspaceSpace, setActiveSpace] = useState<WorkspaceSpace>("productivity");
  const [workspaceProjectId, setActiveProjectId] = useState("cleo-agent");
  const [workspaceThreadId, setActiveThreadId] = useState<string | null>("desktop-ui");
  const [evolutionThreadId, setEvolutionThreadId] = useState<string | null>(null);
  const activeSpace = evolutionOpen ? "productivity" : workspaceSpace;
  const activeProjectId = evolutionOpen ? EVOLUTION_PROJECT : workspaceProjectId;
  const activeThreadId = evolutionOpen ? evolutionThreadId : workspaceThreadId;
  useEffect(() => {
    if (activeSpace !== "memory") return;
    const refresh = () => { if (!document.hidden) void refreshMemory(); };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 15000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(timer);
    };
  }, [activeSpace, refreshMemory]);
  const [runs, setRuns] = useState<Record<string, string>>({});
  const [restoredRuns, setRestoredRuns] = useState<Record<string, string>>({});
  const [recoveryErrors, setRecoveryErrors] = useState<Record<string, string>>({});
  const runLocks = useRef(new Map<string, string>());
  const threadVersions = useRef(new Map<string, number>());
  const [startingKeys, setStartingKeys] = useState<string[]>([]);
  const runningThreadIds = Object.keys(runs);
  const running = Boolean(activeThreadId && runs[activeThreadId]);
  const anyRunning = runningThreadIds.length > 0 || startingKeys.length > 0;
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({});
  const [harnessSwitches, setHarnessSwitches] = useState<Record<string, string>>({});
  const harnessSwitchRef = useRef(new Set<string>());
  const harnessSwitchTarget = activeThreadId ? harnessSwitches[activeThreadId] : undefined;
  const harnessSwitchStatus = harnessSwitchTarget
    ? running
      ? `已选择 ${harnessSwitchTarget}，等待当前轮结束后交接…`
      : `正在连接 ${harnessSwitchTarget} 并交接上下文…`
    : null;
  const [modelSettings, setModelSettings] = useState<ModelSettings | null>(null);
  const [modelSettingsLoading, setModelSettingsLoading] = useState(false);
  const [modelSettingsError, setModelSettingsError] = useState<string | null>(null);
  const [agentInstructions, setAgentInstructions] = useState<AgentInstructions | null>(null);
  const [agentInstructionsLoading, setAgentInstructionsLoading] = useState(false);
  const [agentInstructionsError, setAgentInstructionsError] = useState<string | null>(null);
  const [runtimeCatalog, setRuntimeCatalog] = useState<RuntimeCatalog | null>(null);
  const [productivityModels, setProductivityModels] = useState<Record<string, ProductivityModelCatalog>>({});
  const [runtimeModelsLoading, setRuntimeModelsLoading] = useState<string | null>(null);
  const [runtimeModelsError, setRuntimeModelsError] = useState<string | null>(null);
  const [draftSkills, setDraftSkills] = useState<{ key: string; skills: LocalSkill[] } | null>(null);
  const modelRequestRef = useRef(0);
  const modelCacheRef = useRef(new Map<string, ProductivityModelCatalog>());
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [approvalPending, setApprovalPending] = useState<string[]>([]);
  const approvalSending = useRef(new Set<string>());
  const [approvalErrors, setApprovalErrors] = useState<Record<string, string>>({});
  const approvalVersions = useRef(new Map<string, number>());
  const [draftProfileId, setDraftProfileId] = useState("");
  const [draftProvider, setDraftProvider] = useState("");
  const [draftModel, setDraftModel] = useState("");
  const [draftEffort, setDraftEffort] = useState<RuntimeProfile["effort"]>(null);
  const cancellingRuns = useRef(new Set<string>());
  const steeringRequests = useRef(new Map<string, { id: string; runId: string; text: string; draftText: string }>());
  const steeringLocks = useRef(new Set<string>());
  const [steeringThreads, setSteeringThreads] = useState<string[]>([]);
  const selectionRef = useRef(0);
  const evolutionSelectionRef = useRef(0);
  const viewRef = useRef(evolutionOpen);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  if (viewRef.current !== evolutionOpen) {
    viewRef.current = evolutionOpen;
    selectionRef.current += 1;
  }
  const selectionBySpaceRef = useRef<Partial<Record<ThreadSpace, {
    projectId: string;
    threadId: string | null;
  }>>>({});
  const draftKey = activeThreadId ?? `new:${activeSpace}:${activeProjectId}`;
  const startingRun = startingKeys.includes(draftKey);
  const approvalPendingId = pendingApprovals.find(request => request.threadId === activeThreadId
    && approvalPending.includes(requestKey(request.threadId, request.id)))?.id ?? null;
  const approvalError = activeThreadId ? approvalErrors[activeThreadId] ?? null : null;
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
        const restored = Object.fromEntries(loaded.threads.filter(thread => thread.activeRunId)
          .map(thread => [thread.id, thread.activeRunId!]));
        for (const [id, token] of Object.entries(restored)) runLocks.current.set(id, token);
        setRuns(restored); setRestoredRuns(restored);
        setPendingApprovals(loaded.threads.flatMap(thread => thread.pendingApprovals ?? []));
        for (const thread of loaded.threads) questions.restore(thread.id, thread.pendingQuestions ?? [], questions.version(thread.id));
        setRuntimeCatalog(catalog);
        setDraftProfileId(catalog.defaultNonProductivityProfile);
        setDraftProvider(catalog.defaultProductivityProvider);
        setDraftModel(
          catalog.productivityProviders.find(
            (provider) => provider.id === catalog.defaultProductivityProvider,
          )?.defaultModel ?? "",
        );
        const ordinaryThreads = loaded.threads.filter((thread) => thread.projectId !== EVOLUTION_PROJECT);
        const ordinaryProjects = loaded.projects.filter((project) => project.id !== EVOLUTION_PROJECT);
        const initialThread = ordinaryThreads.find(
          (thread) => thread.id === loaded.activeThreadId,
        ) ?? ordinaryThreads[0];
        if (initialThread) {
          setActiveSpace(initialThread.space);
          setActiveProjectId(initialThread.projectId);
          setActiveThreadId(initialThread.id);
        } else {
          const initialSpace = loaded.activeSpace ?? "productivity";
          const initialProject = ordinaryProjects.find((project) => project.space === initialSpace);
          setActiveSpace(initialSpace);
          setActiveProjectId(initialProject?.id ?? ordinaryProjects[0]?.id ?? "");
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
  }, [bootstrapVersion]);

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

  const skillKey = `${draftRuntime.provider}:${activeProject?.path ?? ""}`;
  useEffect(() => {
    if (activeThread || activeSpace !== "productivity" || evolutionOpen) return;
    let cancelled = false;
    void cleoClient.getLocalSkills(draftRuntime.provider, activeProject?.path)
      .then((skills) => { if (!cancelled) setDraftSkills({ key: skillKey, skills }); })
      .catch(() => { if (!cancelled) setDraftSkills({ key: skillKey, skills: [] }); });
    return () => { cancelled = true; };
  }, [activeThread?.id, activeSpace, evolutionOpen, skillKey]);

  const updateThread = (threadId: string, update: (thread: Thread) => Thread) => {
    threadVersions.current.set(threadId, (threadVersions.current.get(threadId) ?? 0) + 1);
    setSnapshot((current) =>
      current
        ? {
            ...current,
            threads: current.threads.map((thread) =>
              thread.id === threadId ? (() => {
                let next = update(thread);
                if ((next.runtime?.settingsRevision ?? 0) < (thread.runtime?.settingsRevision ?? 0)) {
                  next = { ...next, runtime: thread.runtime };
                }
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

  const refreshWorkspace = async (operation: () => Promise<WorkspaceSnapshot>) => {
    const versions = new Map(threadVersions.current);
    const refreshed = await operation();
    setSnapshot(current => {
      if (!current) return refreshed;
      const live = new Map(current.threads.filter(thread => runLocks.current.has(thread.id)
        || threadVersions.current.get(thread.id) !== versions.get(thread.id)).map(thread => [thread.id, thread]));
      return { ...refreshed, threads: [
        ...refreshed.threads.map(thread => live.get(thread.id) ?? thread),
        ...[...live.values()].filter(thread => !refreshed.threads.some(saved => saved.id === thread.id)),
      ] };
    });
    return refreshed;
  };

  const history = useTimelineHistory(activeThread, updateThread);
  const acknowledgeSteer = (threadId: string, item: TimelineItem) => {
    if (item.type !== "message" || !item.steer || item.steer.threadId !== threadId) return;
    const receipt = item.steer;
    const pending = steeringRequests.current.get(receipt.threadId);
    if (!pending || pending.id !== receipt.id || pending.runId !== receipt.runId
        || pending.text !== receipt.text) return;
    steeringRequests.current.delete(receipt.threadId);
    const accepted = ["queued", "sending", "received"].includes(receipt.status);
    updateDraft(receipt.threadId, current => ({ ...current,
      prompt: accepted && current.prompt === pending.draftText ? "" : current.prompt,
      error: accepted ? undefined : receipt.error ?? undefined,
    }));
  };
  const upsertTimelineItem = (threadId: string, projected: TimelineItem) => {
    if (projected.type === "message" && projected.steer && projected.steer.threadId !== threadId) return;
    acknowledgeSteer(threadId, projected);
    const following = history.isFollowing(threadId);
    if (!following) history.notify(threadId);
    updateThread(threadId, current => {
      const index = current.items.findIndex(item => item.id === projected.id);
      const previous = current.items[index];
      if (previous?.type === "message" && previous.steer && projected.type === "message"
          && projected.steer && previous.steer.revision > projected.steer.revision) return current;
      const items = [...current.items];
      if (index >= 0) items[index] = projected;
      else if (following && (projected.order === undefined || items[0]?.order === undefined
          || projected.order >= items[0].order)) items.push(projected);
      items.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
      const answered = projected.type === "message" && projected.role === "assistant" && projected.content.trim();
      return { ...current, items: answered ? items.map(item => item.turnId === projected.turnId
        ? { ...item, turnHasAnswer: true } : item) : items,
      history: current.history && { ...current.history, hasAfter: current.history.hasAfter || !following } };
    });
  };
  const questions = useQuestions(activeThread, updateThread);
  useEffect(() => {
    if (!Object.keys(restoredRuns).length) return;
    let active = true;
    let timer: number;
    const refresh = async () => {
      await Promise.all(Object.entries(restoredRuns).map(async ([id, token]) => {
        const approvalVersion = approvalVersions.current.get(id);
        const questionVersion = questions.version(id);
        try {
          const loaded = await cleoClient.loadThread(id, false);
          if (!active || runLocks.current.get(id) !== token) return;
          loaded.items.forEach(item => acknowledgeSteer(id, item));
          updateThread(id, current => history.isFollowing(id) ? loaded : { ...loaded,
            items: current.items, history: current.history && { ...current.history,
              total: Math.max(current.history.total, loaded.history?.total ?? 0),
              hasAfter: current.history.hasAfter || loaded.history?.revision !== current.history.revision } });
          if (approvalVersions.current.get(id) === approvalVersion) setPendingApprovals(current => [
            ...current.filter(request => request.threadId !== id), ...(loaded.pendingApprovals ?? []),
          ]);
          questions.restore(id, loaded.pendingQuestions ?? [], questionVersion);
          setRecoveryErrors(current => ({ ...current, [id]: "" }));
          if (loaded.activeRunId) {
            if (loaded.activeRunId !== token) {
              runLocks.current.set(id, loaded.activeRunId);
              setRuns(current => ({ ...current, [id]: loaded.activeRunId! }));
              setRestoredRuns(current => ({ ...current, [id]: loaded.activeRunId! }));
            }
          } else {
            runLocks.current.delete(id);
            setRuns(current => { const next = { ...current }; delete next[id]; return next; });
            setRestoredRuns(current => { const next = { ...current }; delete next[id]; return next; });
            questions.finish(id);
            void refreshMemory();
          }
        } catch (error) {
          if (active && runLocks.current.get(id) === token) setRecoveryErrors(current => ({ ...current,
            [id]: error instanceof Error ? error.message : "无法同步运行状态，将自动重试。" }));
        }
      }));
      if (active) timer = window.setTimeout(() => void refresh(), 1500);
    };
    void refresh();
    return () => { active = false; window.clearTimeout(timer); };
  }, [restoredRuns]);
  useEffect(() => {
    setSnapshot(current => current && { ...current, threads: current.threads.map(thread =>
      [activeThreadId, workspaceThreadId, evolutionThreadId].includes(thread.id) || runLocks.current.has(thread.id)
        ? thread : { ...thread, items: [] }) });
    if (activeThread?.history?.total && !activeThread.items.length) void history.load("latest");
  }, [activeThreadId, workspaceThreadId, evolutionThreadId, runs]);

  const selectSpace = (space: WorkspaceSpace) => {
    clearLoadingError();
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
        ? activeProjectId : projectForSpace?.id ?? "";
    const next =
      snapshot.threads.find(
        (thread) => thread.space === space && thread.projectId === preferredProjectId,
      ) ?? snapshot.threads.find((thread) => thread.space === space && thread.projectId !== EVOLUTION_PROJECT);
    if (next) {
      setActiveProjectId(next.projectId);
      setActiveThreadId(next.id);
    } else {
      setActiveProjectId(projectForSpace?.id ?? "");
      setActiveThreadId(null);
    }
  };

  const selectProject = (projectId: string) => {
    clearLoadingError();
    selectionRef.current += 1;
    setActiveProjectId(projectId);
    if (!snapshot || activeSpace === "memory") return;
    const next = snapshot.threads.find(
      (thread) => thread.space === activeSpace && thread.projectId === projectId,
    );
    setActiveThreadId(next?.id ?? null);
  };

  const selectThread = (threadId: string) => {
    clearLoadingError();
    const thread = snapshot?.threads.find((candidate) => candidate.id === threadId);
    if (!thread || thread.projectId === EVOLUTION_PROJECT) return;
    const selection = ++selectionRef.current;
    const version = threadVersions.current.get(threadId);
    setActiveSpace(thread.space);
    setActiveProjectId(thread.projectId);
    setActiveThreadId(threadId);
    void cleoClient
      .loadThread(threadId)
      .then((loaded) => {
        loaded.items.forEach(item => acknowledgeSteer(threadId, item));
        if (selectionRef.current !== selection || threadVersions.current.get(threadId) !== version
            || runLocks.current.has(threadId)) return;
        updateThread(threadId, () => loaded);
        setActiveSpace(loaded.space);
        setActiveProjectId(loaded.projectId);
      })
      .catch((error: unknown) => {
        if (selectionRef.current !== selection || threadVersions.current.get(threadId) !== version || runLocks.current.has(threadId)) return;
        loadingRetry.current = () => selectThread(threadId);
        setLoadingError(error instanceof Error ? error.message : "无法恢复历史记录");
      });
  };

  /** Purpose: Open an empty task in whichever view is on screen.
   * Input: none. Output: the active view's selection is cleared; saved tasks stay untouched.
   * Each view owns its own selected thread, so clearing the workspace selection while the
   * evolution view is open left the old task on screen and the action did nothing at all.
   */
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
    if (evolutionOpen) beginEvolutionDraft();
    else setActiveThreadId(null);
  };

  const createThread = async () => {
    const selection = ++selectionRef.current;
    const space: ThreadSpace = activeSpace === "chat" ? "chat" : "productivity";
    const project = snapshot?.projects.find(
      (candidate) => candidate.id === activeProjectId && candidate.space === space
        && candidate.id !== EVOLUTION_PROJECT,
    ) ?? snapshot?.projects.find((candidate) => candidate.space === space && candidate.id !== EVOLUTION_PROJECT);
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
    evolutionSelectionRef.current += 1;
    setEvolutionThreadId(null);
  };

  /** Purpose: Restore evolution independently of ordinary navigation, including during streaming.
   * Input: saved ID or null for a new thread. Output: cached timeline and evolution selection only.
   */
  const openEvolutionThread = async (threadId: string | null = null) => {
    const cached = snapshotRef.current?.threads.find((thread) => thread.id === threadId
      && thread.projectId === EVOLUTION_PROJECT);
    if (cached) {
      setEvolutionThreadId(cached.id);
      // Never reload over in-flight chunks; this cache receives the stream even when hidden.
      if (runLocks.current.has(cached.id)) return cached;
    }
    if (!threadId && runLocks.current.size) throw new Error("请先等待运行中的任务完成。");
    if (!window.cleoDesktop) throw new Error("本地迭代需要在桌面应用中运行。");
    const selected = ++evolutionSelectionRef.current;
    const result = await window.cleoDesktop.request<{ thread: Thread; workspace: WorkspaceSnapshot }>(
      "open_evolution_thread", { thread_id: threadId, provider: draftProvider || undefined,
        model: draftModel || undefined, effort: draftEffort ?? undefined },
    );
    // A late response must still register a newly created stream target, but cannot replace
    // another view's selected conversation or its newer timeline with a whole stale snapshot.
    setSnapshot((current) => current ? {
      ...current,
      projects: [...current.projects, ...result.workspace.projects.filter(
        (project) => !current.projects.some((existing) => existing.id === project.id),
      )],
      threads: [
        current.threads.find((thread) => thread.id === result.thread.id && thread.status === "running")
          ?? result.thread,
        ...current.threads.filter((thread) => thread.id !== result.thread.id),
      ],
    } : result.workspace);
    if (evolutionSelectionRef.current === selected) setEvolutionThreadId(result.thread.id);
    return result.thread;
  };

  const chooseWorkspace = async () => {
    const projectPath = await cleoClient.pickWorkspace();
    if (!projectPath) return null;
    const space: ThreadSpace = activeSpace === "chat" ? "chat" : "productivity";
    const name = projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace";
    const projectId = `${space}:${name}`;
    await refreshWorkspace(() => cleoClient.addProject(space, projectPath));
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
    const lockKey = targetThread?.id ?? activeThread?.id ?? draftKey;
    if (!prompt || runLocks.current.has(lockKey)
      || harnessSwitchRef.current.has(targetThread?.id ?? activeThreadId ?? "")) return;

    const token = crypto.randomUUID();
    runLocks.current.set(lockKey, token);
    setStartingKeys(keys => [...keys, lockKey]);
    const sourceDraftKey = draftKey;
    const pendingAttachments = preserveDraft ? [] : draft.attachments;
    updateDraft(sourceDraftKey, (current) => ({ ...current, error: undefined }));

    let thread = targetThread ?? activeThread;
    const selection = selectionRef.current + (thread ? 0 : 1);
    try {
      if (!thread) thread = await createThread();
    } catch (error) {
      updateDraft(sourceDraftKey, (current) => ({
        ...current,
        error: error instanceof Error ? error.message : "无法创建对话，请重试。",
      }));
      if (runLocks.current.get(lockKey) === token) runLocks.current.delete(lockKey);
      setStartingKeys(keys => keys.filter(key => key !== lockKey));
      return;
    }

    const threadId = thread.id;
    const canNavigate = () => selectionRef.current === selection
      && viewRef.current === evolutionOpen && thread.projectId !== EVOLUTION_PROJECT;
    if (lockKey !== threadId) runLocks.current.delete(lockKey);
    runLocks.current.set(threadId, token);
    const userItem: TimelineItem = {
      id: `${threadId}-user-${Date.now()}`,
      type: "message",
      role: "user",
      content: prompt,
      time: currentTime(),
    };
    let turnId = userItem.id;
    userItem.turnId = turnId;
    setRuns(current => ({ ...current, [threadId]: token }));
    setStartingKeys(keys => keys.filter(key => key !== lockKey));
    if (!preserveDraft) updateDraft(sourceDraftKey, (current) => ({
      prompt: current.prompt === draft.prompt ? "" : current.prompt,
      attachments: current.attachments.filter((item) => !pendingAttachments.some((sent) => sent.path === item.path)),
    }));
    updateThread(threadId, (current) => ({
      ...current,
      title: current.items.length === 0 ? prompt.slice(0, 26) : current.title,
      summary: prompt.slice(0, 64),
      status: "running",
      steerReady: false,
      updatedAt: "刚刚",
      items: history.isFollowing(threadId) ? [...current.items, userItem] : current.items,
    }));

    let failed = false;
    try {
      for await (const event of cleoClient.streamTurn(threadId, prompt, pendingAttachments, token)) {
        if (runLocks.current.get(threadId) !== token) return;
        if (event.type === "turn-started") {
          turnId = event.item.turnId ?? event.item.id;
          updateThread(threadId, current => ({ ...current, steerReady: true,
            items: current.items.map(item => item.id === userItem.id ? event.item : item) }));
        } else if (event.type === "upsert-item") {
          const projected = { ...event.item, turnId: event.item.turnId ?? turnId };
          upsertTimelineItem(threadId, projected);
        } else if (event.type === "timing") {
          if (event.timing.sessionId !== threadId) continue;
          updateThread(threadId, current => {
            const matching = current.items.filter(item => item.type === "message" && item.turnId === event.timing.turnId);
            const last = matching.findLast(item => item.type === "message" && item.role === "assistant")?.id
              ?? matching.at(-1)?.id;
            return { ...current, currentTiming: event.timing,
              items: current.items.map(item => item.id === last ? { ...item, timing: event.timing }
                : item.timing?.id === event.timing.id ? { ...item, timing: undefined } : item) };
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
        } else if (event.type === "runtime") {
          updateThread(threadId, (current) => ({ ...current, runtime: event.runtime }));
        } else if (event.type === "terminal") {
          updateThread(threadId, (current) => ({
            ...current,
            terminal: [...(current.terminal ?? []), event.chunk],
          }));
        } else if (event.type === "refresh") {
          const refreshed = await refreshWorkspace(() => cleoClient.loadWorkspace());
          const next = refreshed.threads.find((item) => item.id === event.activeThreadId);
          if (canNavigate() && next?.projectId !== EVOLUTION_PROJECT) {
            setActiveSpace(event.space);
            setActiveThreadId(event.activeThreadId);
            if (next) setActiveProjectId(next.projectId);
          }
        } else if (event.type === "navigate-space") {
          if (canNavigate()) selectSpace(event.space);
        } else if (event.type === "request-attachment") {
          const selected = await cleoClient.pickAttachments();
          appendAttachments(selected, threadId);
        } else if (event.type === "approval-request") {
          approvalVersions.current.set(threadId, (approvalVersions.current.get(threadId) ?? 0) + 1);
          const request = { ...event.request, threadId };
          setPendingApprovals((current) => [
            ...current.filter((candidate) => candidate.threadId !== threadId || candidate.id !== request.id),
            request,
          ]);
          setApprovalErrors(current => ({ ...current, [threadId]: "" }));
        } else if (event.type === "approval-resolved") {
          approvalVersions.current.set(threadId, (approvalVersions.current.get(threadId) ?? 0) + 1);
          setPendingApprovals((current) => current.filter(
            (candidate) => candidate.threadId !== threadId || candidate.id !== event.response.id,
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
      if (runLocks.current.get(threadId) !== token) return;
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
      if (runLocks.current.get(threadId) === token) {
        if (!failed) {
          updateThread(threadId, (current) =>
            current.status === "running" ? { ...current, status: cancellingRuns.current.has(token) ? "attention" : "completed" } : current,
          );
        }
        runLocks.current.delete(threadId);
        setRuns(current => { const next = { ...current }; if (next[threadId] === token) delete next[threadId]; return next; });
        setPendingApprovals((current) => current.filter(
          (candidate) => candidate.threadId !== threadId,
        ));
        questions.finish(threadId);
        void refreshMemory();
        if (history.isActive(threadId) && history.isFollowing(threadId) && thread.history) await history.load("latest");
      }
    }
  };

  const cancelRun = async () => {
    const threadId = activeThreadId;
    const token = threadId ? runLocks.current.get(threadId) : undefined;
    if (!threadId || !token || cancellingRuns.current.has(token)) return;
    cancellingRuns.current.add(token);
    try {
      const cancelled = await cleoClient.cancelRun(threadId, token);
      if (cancelled === false) return; // Recovery polling will reconcile a newer or completed run.
    } catch (error) {
      if (runLocks.current.get(threadId) !== token) return;
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
      cancellingRuns.current.delete(token);
    }
    // A completed stream may already have allowed a newer run to start.
    if (runLocks.current.get(threadId) !== token) return;
    runLocks.current.delete(threadId);
    setRuns(current => { const next = { ...current }; if (next[threadId] === token) delete next[threadId]; return next; });
    setRestoredRuns(current => { const next = { ...current }; if (next[threadId] === token) delete next[threadId]; return next; });
    setRecoveryErrors(current => ({ ...current, [threadId]: "" }));
    questions.finish(threadId);
    void refreshMemory();
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
    if (history.isActive(threadId) && history.isFollowing(threadId)) await history.load("latest");
  };

  const resolveApproval = async (decision: ApprovalDecision) => {
    const request = pendingApprovals.find(candidate => candidate.threadId === activeThreadId);
    if (!request) return;
    const key = requestKey(request.threadId, request.id);
    if (approvalSending.current.has(key)) return;
    approvalVersions.current.set(request.threadId, (approvalVersions.current.get(request.threadId) ?? 0) + 1);
    approvalSending.current.add(key);
    setApprovalPending(current => [...current, key]);
    setApprovalErrors(current => ({ ...current, [request.threadId]: "" }));
    try {
      await cleoClient.resolveApproval(request.threadId, request.id, decision);
      setPendingApprovals((current) => current.filter(
        (candidate) => candidate.threadId !== request.threadId || candidate.id !== request.id,
      ));
    } catch (error) {
      setApprovalErrors(current => ({ ...current, [request.threadId]: error instanceof Error ? error.message : "无法提交审批决定" }));
    } finally {
      approvalSending.current.delete(key);
      approvalVersions.current.set(request.threadId, (approvalVersions.current.get(request.threadId) ?? 0) + 1);
      setApprovalPending(current => current.filter(value => value !== key));
    }
  };

  const renameThread = async (title: string) => {
    const threadId = activeThreadId;
    if (!threadId || !title.trim()) throw new Error("请输入会话名称。");
    if (runLocks.current.has(threadId)) throw new Error("请等待当前运行完成后重命名。");
    const token = crypto.randomUUID();
    runLocks.current.set(threadId, token);
    setStartingKeys(keys => [...keys, threadId]);
    try {
      for await (const event of cleoClient.streamTurn(threadId, `/rename ${title.trim()}`)) {
        if (event.type === "error") throw new Error(event.message);
      }
      const renamed = await cleoClient.loadThread(threadId);
      updateThread(threadId, () => renamed);
    } finally {
      if (runLocks.current.get(threadId) === token) runLocks.current.delete(threadId);
      setStartingKeys(keys => keys.filter(key => key !== threadId));
    }
  };

  const updatePermissions = async (threadId: string, update: RuntimeUpdate) => {
    const runtime = await cleoClient.updateRuntime(threadId, update);
    updateThread(threadId, current => ({ ...current, runtime }));
  };

  const submitSteer = async (threadId: string, runId: string, text: string, requestId: string, retry = false) => {
    const item = await cleoClient.steerRun(threadId, runId, requestId, text, retry);
    if (item.type !== "message" || !item.steer || item.steer.id !== requestId
        || item.steer.threadId !== threadId || item.steer.runId !== runId || item.steer.text !== text) {
      throw new Error("引导回执与目标运行不一致");
    }
    upsertTimelineItem(threadId, item);
    return item;
  };

  const sendSteer = async (text: string) => {
    const threadId = activeThreadId;
    const runId = threadId ? runLocks.current.get(threadId) : undefined;
    if (!threadId || !runId || !text.trim() || steeringLocks.current.has(threadId)) return;
    if (draft.attachments.length) {
      updateDraft(threadId, current => ({ ...current, error: "运行中追加指令暂不支持附件，附件可在本轮结束后发送。" }));
      return;
    }
    const previous = steeringRequests.current.get(threadId);
    const draftText = draft.prompt;
    const requestId = previous?.runId === runId && previous.text === text ? previous.id : crypto.randomUUID();
    steeringRequests.current.set(threadId, { id: requestId, runId, text, draftText });
    steeringLocks.current.add(threadId);
    setSteeringThreads(current => [...current, threadId]);
    updateDraft(threadId, current => ({ ...current, error: undefined }));
    try {
      await submitSteer(threadId, runId, text, requestId);
    } catch (error) {
      if (steeringRequests.current.get(threadId)?.id === requestId) {
        updateDraft(threadId, current => ({ ...current, error: error instanceof Error
          ? `${error.message}；重试会核对同一条消息。` : "尚未确认提交结果，重试会核对同一条消息。" }));
      }
    } finally {
      steeringLocks.current.delete(threadId);
      setSteeringThreads(current => current.filter(id => id !== threadId));
    }
  };

  const retrySteer = async (receipt: SteerReceipt) => {
    if (steeringLocks.current.has(receipt.threadId)) return;
    steeringLocks.current.add(receipt.threadId);
    setSteeringThreads(current => [...current, receipt.threadId]);
    try {
      await submitSteer(receipt.threadId, receipt.runId, receipt.text, receipt.id, true);
    } catch (error) {
      updateDraft(receipt.threadId, current => ({ ...current,
        error: error instanceof Error ? error.message : "无法核对引导消息。请重试。",
      }));
    } finally {
      steeringLocks.current.delete(receipt.threadId);
      setSteeringThreads(current => current.filter(id => id !== receipt.threadId));
    }
  };

  const restoreSteer = (receipt: SteerReceipt) => {
    updateDraft(receipt.threadId, current => ({ ...current, error: undefined,
      prompt: current.prompt.trim() && current.prompt !== receipt.text
        ? `${current.prompt}\n\n${receipt.text}` : receipt.text,
    }));
  };

  const updateRuntime = (update: RuntimeUpdate) => {
    if (activeSpace === "productivity" && update.effort) {
      setDraftEffort(update.effort);
    }
    const threadId = activeThreadId;
    if (!threadId) return;
    const selection = selectionRef.current;
    void cleoClient
      .updateRuntime(threadId, update)
      .then((runtime) => {
        updateThread(threadId, current => ({ ...current, runtime }));
      })
      .catch((error: unknown) => {
        if (selectionRef.current !== selection) return;
        loadingRetry.current = () => updateRuntime(update);
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

  /** Switch existing tasks in place; new drafts only change their initial selection. */
  const selectProductivityRuntime = async (provider: string, model: string) => {
    const selectedModel = productivityModels[provider]?.models.find(
      (candidate) => candidate.id === model,
    );
    if (activeThread?.space === "productivity") {
      const threadId = activeThread.id;
      if (harnessSwitchRef.current.has(threadId)
        || (activeThread.runtime?.provider === provider && activeThread.runtime?.model === model)) return;
      harnessSwitchRef.current.add(threadId);
      setHarnessSwitches(current => ({ ...current, [threadId]: provider }));
      updateDraft(threadId, current => ({ ...current, error: undefined }));
      try {
        const runtime = await cleoClient.switchHarness(
          threadId, provider, model, selectedModel?.defaultEffort ?? undefined,
        );
        updateThread(threadId, current => ({ ...current, runtime, skills: [] }));
        // Refresh only capabilities; keep the live timeline and unsent draft in place.
        try {
          const skills = await cleoClient.getLocalSkills(provider, activeProject?.path);
          updateThread(threadId, current => ({ ...current, skills }));
        } catch {
          updateDraft(threadId, current => ({ ...current,
            error: "Harness 已切换；技能列表暂时无法读取。",
          }));
        }
      } catch (error) {
        updateDraft(threadId, current => ({ ...current,
          error: error instanceof Error ? error.message : "切换失败，原会话可继续使用。",
        }));
      } finally {
        harnessSwitchRef.current.delete(threadId);
        setHarnessSwitches(current => {
          const next = { ...current }; delete next[threadId]; return next;
        });
      }
      return;
    }
    setDraftProvider(provider);
    setDraftModel(model);
    setDraftEffort(selectedModel?.defaultEffort ?? null);
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
    await refreshWorkspace(() => cleoClient.loadWorkspace());
  };
  const undoChanges = async () => {
    if (!activeThread || activeThread.space !== "productivity") {
      throw new Error("只有开发任务可以回退 Git 改动。");
    }
    if (runLocks.current.has(activeThread.id)) {
      throw new Error("任务正在运行，请先停止后再回退。");
    }
    let result: Awaited<ReturnType<typeof cleoClient.undoChanges>>;
    await refreshWorkspace(async () => { result = await cleoClient.undoChanges(activeThread.id); return result.workspace; });
    return result!;
  };
  const restoreChatHistory = async () => {
    const refreshed = await refreshWorkspace(() => cleoClient.restoreChatBackups());
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
    if (runLocks.current.has(threadId)) {
      throw new Error("正在运行的 thread 不能删除，请先停止运行。");
    }
    const deleted = snapshot?.threads.find((thread) => thread.id === threadId);
    const deletedWasActive = activeThreadId === threadId;
    selectionRef.current += 1;
    const refreshed = await refreshWorkspace(() => cleoClient.deleteThread(threadId));
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
    const refreshed = await refreshWorkspace(() => cleoClient.removeProject(projectId));
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
    setModelSettingsError(null);
    try {
      const loaded = await cleoClient.getModelSettings();
      setModelSettings(loaded);
      return loaded;
    } catch (error) {
      setModelSettingsError(error instanceof Error ? error.message : "无法读取模型配置");
      throw error;
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
            id: profile.name, label: profile.displayName || profile.name, provider: profile.provider, model: profile.model,
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
    setAgentInstructionsError(null);
    try {
      const loaded = await cleoClient.getAgentInstructions();
      setAgentInstructions(loaded);
      return loaded;
    } catch (error) {
      setAgentInstructionsError(error instanceof Error ? error.message : "无法读取对话指令");
      throw error;
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
      await refreshMemory();
      return refreshed;
    } catch (error) {
      await refreshMemory();
      throw error;
    }
  };
  const loadMemoryReviewDetails = (source: MemoryReviewSource) =>
    cleoClient.getMemoryReviewDetails(source);

  return {
    history,
    questions,
    skills: activeThread?.skills ?? (draftSkills?.key === skillKey && !evolutionOpen ? draftSkills.skills : []),
    snapshot: snapshot && { ...snapshot, threads: snapshot.threads.map(thread => ({ ...thread,
      waitingFor: pendingApprovals.some(request => request.threadId === thread.id) ? "approval" as const
        : questions.pending.some(request => request.threadId === thread.id) ? "question" as const : undefined,
    })) },
    loadingError,
    memoryError,
    memoryRefreshing,
    refreshMemory,
    clearLoadingError,
    retryLoading,
    activeSpace,
    activeProject,
    activeProjectId,
    activeThread,
    activeThreadId,
    running,
    runningThreadIds,
    anyRunning,
    draftRuntime,
    attachments: draft.attachments,
    prompt: draft.prompt,
    setPrompt,
    sendError: draft.error || (activeThreadId ? recoveryErrors[activeThreadId] : undefined),
    startingRun,
    harnessSwitchStatus,
    modelSettings,
    modelSettingsLoading,
    modelSettingsError,
    agentInstructions,
    agentInstructionsLoading,
    agentInstructionsError,
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
    sendSteer,
    retrySteer,
    restoreSteer,
    steeringBusy: activeThreadId ? steeringThreads.includes(activeThreadId) : false,
    renameThread,
    cancelRun,
    resolveApproval,
    updateRuntime,
    updatePermissions,
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
