import { getLanguage } from "../electron/i18n.mjs";
import { t as tr } from "../electron/i18n.mjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { requestKey } from "./request-key";
import { cleoClient } from "./services/cleoClient";
import { boundTimeline } from "./timeline-cache";
import { useTimelineHistory } from "./useTimelineHistory";
import { useQuestions } from "./useQuestions";
import type {
  SourceControlOp,
  Project,
  LocalSkill,
  AgentInstructions,
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  ApplyModelSettings,
  ModelSettings,
  MemoryReviewSource,
  ProductivityModelCatalog,
  RuntimeCatalog,
  RuntimeProfile,
  RuntimeUpdate,
  QueuedMessage,
  SteerReceipt,
  Thread,
  ThreadSpace,
  TimelineItem,
  WorkspaceSnapshot,
  WorkspaceSpace,
} from "./types";
import { projectsInSpace } from "./runtime-labels";
import { nextPendingSwitch, runtimeWithPendingSwitch, type PendingHarnessSwitch } from "./harness-handoff";

function currentTime() {
  return new Date().toLocaleTimeString(getLanguage(), { hour: "2-digit", minute: "2-digit" });
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

/** The development project that binds no folder; chosen when nothing else is selected. */
const GENERAL_PRODUCTIVITY_PROJECT = "productivity:general";

/** Purpose: Compare folder paths across separators and, on Windows drives, letter case. */
function normalizedPath(path: string) {
  const value = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
}

/** The project a draft lands in when the user picks nothing: the space's general project
 * (no folder bound) whenever it is listed, otherwise the first ordinary project. */
function defaultProjectFor(projects: Parameters<typeof projectsInSpace>[0], space: ThreadSpace) {
  return projectsInSpace(projects, space)[0];
}

/** Purpose: The branch name in a project's record, as git's own branch name.
 * Input: the workspace's branch text, taken from `git status --branch` ("main", "HEAD (no branch)",
 * "No commits yet on main"). Output: the branch name, or null for a detached HEAD. */
export function projectBranchName(branch: string | null | undefined): string | null {
  if (!branch || /^HEAD(?: \(no branch\))?$/.test(branch)) return null;
  return /^(?:No commits yet|Initial commit) on (.+)$/.exec(branch)?.[1] ?? branch;
}

export function useCleoWorkspace() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  /** Threads whose latest reply finished while the user was not looking at them. */
  const [unreadThreadIds, setUnreadThreadIds] = useState<string[]>([]);
  const focusRef = useRef<{ activeThreadId: string | null; attentive: () => boolean }>({ activeThreadId: null, attentive: () => true });
  const markThreadRead = useCallback((threadId: string | null) => {
    if (!threadId) return;
    setUnreadThreadIds(current => (current.includes(threadId) ? current.filter(id => id !== threadId) : current));
  }, []);
  /** Purpose: Count a finished reply as unread unless the user is already looking at that thread. */
  const markReplyFinished = useCallback((threadId: string) => {
    const { activeThreadId: visible, attentive } = focusRef.current;
    if (visible === threadId && attentive()) return;
    setUnreadThreadIds(current => (current.includes(threadId) ? current : [...current, threadId]));
  }, []);
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
          if (revision === memoryRevision.current) setMemoryError(error instanceof Error ? error.message : tr("usecleoworkspace.could_not_refresh_memories"));
        }
      } while (revision !== memoryRevision.current);
    };
    memoryRefresh.current = read().finally(() => { memoryRefresh.current = null; setMemoryRefreshing(false); });
    return memoryRefresh.current;
  }, []);
  const [bootstrapVersion, setBootstrapVersion] = useState(0);
  const [choosingWorkspace, setChoosingWorkspace] = useState(false);
  const workspacePickerOpen = useRef(false);
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
  const activeSpace = workspaceSpace;
  const activeProjectId = workspaceProjectId;
  const activeThreadId = workspaceThreadId;
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
  // A harness picked for an existing task waits here; sendPrompt hands it off with the next message.
  const [pendingSwitches, setPendingSwitches] = useState<Record<string, PendingHarnessSwitch>>({});
  const pendingSwitchesRef = useRef<Record<string, PendingHarnessSwitch>>({});
  const setPendingSwitch = (threadId: string, pending: PendingHarnessSwitch | null) => {
    const next = { ...pendingSwitchesRef.current };
    if (pending) next[threadId] = pending;
    else delete next[threadId];
    pendingSwitchesRef.current = next;
    setPendingSwitches(next);
  };
  const pendingHarnessSwitch = activeThreadId ? pendingSwitches[activeThreadId] ?? null : null;
  const harnessSwitchTarget = activeThreadId ? harnessSwitches[activeThreadId] : undefined;
  const harnessSwitchStatus = harnessSwitchTarget
    ? running
      ? tr("usecleoworkspace.selected_value_waiting_for_the_current_turn_to_finish_before_handing_off", { p0: harnessSwitchTarget })
      : tr("usecleoworkspace.connecting_to_value_and_handing_off_context", { p0: harnessSwitchTarget })
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
  const [draftServiceTier, setDraftServiceTier] = useState<"default" | "fast">("default");
  // The permission preset picked for a draft, kept per provider so switching harness resets it.
  const [draftPermissions, setDraftPermissionsState] = useState<{
    provider: string; access?: string; approval?: string;
  } | null>(null);
  const cancellingRuns = useRef(new Set<string>());
  const steeringRequests = useRef(new Map<string, { id: string; runId: string; text: string }>());
  const steeringLocks = useRef(new Set<string>());
  const [steeringThreads, setSteeringThreads] = useState<string[]>([]);
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});
  const queuesRef = useRef(queues);
  queuesRef.current = queues;
  const selectionRef = useRef(0);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
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
        const initialThread = loaded.threads.find(
          (thread) => thread.id === loaded.activeThreadId,
        ) ?? loaded.threads[0];
        if (initialThread) {
          setActiveSpace(initialThread.space);
          setActiveProjectId(initialThread.projectId);
          setActiveThreadId(initialThread.id);
        } else {
          const initialSpace = loaded.activeSpace ?? "productivity";
          const initialProject = defaultProjectFor(loaded.projects, initialSpace);
          setActiveSpace(initialSpace);
          setActiveProjectId(initialProject?.id ?? loaded.projects[0]?.id ?? "");
          setActiveThreadId(null);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setLoadingError(error instanceof Error ? error.message : tr("usecleoworkspace.could_not_load_the_local_workspace"));
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
    if (activeSpace === "memory" || activeProject?.space !== activeSpace) return;
    selectionBySpaceRef.current[activeSpace] = {
      projectId: activeProjectId,
      threadId: activeThreadId,
    };
  }, [activeSpace, activeProject, activeProjectId, activeThreadId]);

  // The displayed permissions and create_thread payload share the same native values.
  const draftPermissionUpdate = useMemo(() => {
    const provider = runtimeCatalog?.productivityProviders.find(candidate => candidate.id === draftProvider);
    const chosen = draftPermissions?.provider === provider?.id ? draftPermissions : null;
    const fallback = provider?.permissionOptions?.presets?.[0]?.update;
    const access = chosen?.access ?? fallback?.access ?? provider?.permissionOptions?.access[0]?.value;
    const approval = chosen?.approval ?? fallback?.approval ?? provider?.permissionOptions?.approval[0]?.value;
    return {
      ...(provider?.type === "codex_sdk" && access ? { access } : {}),
      ...(approval ? { approval } : {}),
    };
  }, [draftPermissions, draftProvider, runtimeCatalog]);

  const draftRuntime = useMemo<RuntimeProfile>(() => {
    if (activeSpace === "chat") {
      const profile = runtimeCatalog?.nonProductivityProfiles.find(
        (candidate) => candidate.id === draftProfileId,
      ) ?? runtimeCatalog?.nonProductivityProfiles[0];
      return {
        profileId: profile?.id,
        routingMode: runtimeCatalog?.defaultRoutingMode ?? "manual",
        provider: profile?.provider ?? "Cleo",
        model: profile?.model ?? tr("connectionwizard.choose_model"),
        effort: "high",
        access: "workspace-write",
        approval: tr("usecleoworkspace.cleo_tool_policy"),
        contextWindow: 0,
        editable: false,
      };
    }
    const provider = runtimeCatalog?.productivityProviders.find(
      (candidate) => candidate.id === draftProvider,
    );
    return {
      provider: (provider?.id ?? draftProvider) || tr("usecleoworkspace.choose_sdk_acp"),
      model: draftModel || provider?.defaultModel || tr("connectionwizard.choose_model"),
      routingMode: runtimeCatalog?.defaultRoutingMode ?? "manual",
      effort: draftEffort,
      serviceTier: provider?.type === "codex_sdk" ? draftServiceTier : null,
      supportsFastMode: provider?.type === "codex_sdk",
      access: draftPermissionUpdate.access ?? "default",
      approval: draftPermissionUpdate.approval ?? "default",
      permissionOptions: provider?.permissionOptions,
      contextWindow: 0,
      editable: false,
    };
  }, [activeSpace, draftEffort, draftPermissionUpdate, draftServiceTier, draftModel, draftProfileId, draftProvider, runtimeCatalog]);

  // What the pill and card show for the active task: its live runtime, or the pick awaiting handoff.
  const activeThreadRuntime = useMemo(() => activeThread?.runtime
    ? runtimeWithPendingSwitch(activeThread.runtime, pendingHarnessSwitch, runtimeCatalog)
    : activeThread?.runtime, [activeThread?.runtime, pendingHarnessSwitch, runtimeCatalog]);

  /** Purpose: Remember the permission preset for the draft so its task starts with it.
   * Input: the selector's update (preset values and the provider it belongs to).
   * Output: the draft runtime reflects it; create_thread applies it before the first turn.
   */
  const setDraftPermissions = async (update: RuntimeUpdate) => {
    setDraftPermissionsState({
      provider: update.permissionProvider ?? draftProvider,
      access: update.access ?? undefined,
      approval: update.approval ?? undefined,
    });
  };

  const skillKey = `${draftRuntime.provider}:${activeProject?.path ?? ""}`;
  useEffect(() => {
    if (activeThread || activeSpace !== "productivity"
        || !runtimeCatalog?.productivityProviders.some(provider => provider.id === draftRuntime.provider)) return;
    let cancelled = false;
    void cleoClient.getLocalSkills(draftRuntime.provider, activeProject?.path)
      .then((skills) => { if (!cancelled) setDraftSkills({ key: skillKey, skills }); })
      .catch(() => { if (!cancelled) setDraftSkills({ key: skillKey, skills: [] }); });
    return () => { cancelled = true; };
  }, [activeThread?.id, activeSpace, skillKey, runtimeCatalog]);

  useEffect(() => {
    focusRef.current = {
      activeThreadId,
      attentive: () => document.hasFocus() && !document.hidden,
    };
  }, [activeThreadId]);
  // A finished thread on screen while the window has focus counts as read: on arrival
  // (rail or project switch restores it) and on returning to the window.
  useEffect(() => {
    const settle = () => { if (document.hasFocus() && !document.hidden) markThreadRead(activeThreadId); };
    settle();
    window.addEventListener("focus", settle);
    document.addEventListener("visibilitychange", settle);
    return () => {
      window.removeEventListener("focus", settle);
      document.removeEventListener("visibilitychange", settle);
    };
  }, [activeThreadId, markThreadRead]);

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

  const refreshLanguage = async () => {
    const [refreshed, catalog] = await Promise.all([
      refreshWorkspace(() => cleoClient.loadWorkspace()), cleoClient.getRuntimeCatalog(),
    ]);
    setRuntimeCatalog(catalog);
    // Keep live turns and drafts; only refresh their presentation metadata.
    setSnapshot(current => current && { ...current, threads: current.threads.map(thread => {
      const fresh = refreshed.threads.find(item => item.id === thread.id);
      if (!fresh) return thread;
      return { ...thread, updatedAt: fresh.updatedAt,
        runtime: (thread.runtime?.settingsRevision ?? 0) > (fresh.runtime?.settingsRevision ?? 0)
          ? thread.runtime : fresh.runtime };
    }) });
    await history.load("latest", undefined, runLocks.current.has(activeThread?.id ?? ""));
  };

  const history = useTimelineHistory(activeThread, updateThread);
  const acknowledgeSteer = (threadId: string, item: TimelineItem) => {
    if (item.type !== "message" || !item.steer || item.steer.threadId !== threadId) return;
    const receipt = item.steer;
    const pending = steeringRequests.current.get(receipt.threadId);
    if (!pending || pending.id !== receipt.id || pending.runId !== receipt.runId
        || pending.text !== receipt.text) return;
    steeringRequests.current.delete(receipt.threadId);
    if (!["queued", "sending", "received"].includes(receipt.status)) {
      updateDraft(receipt.threadId, current => ({ ...current, error: receipt.error ?? undefined }));
    }
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
            [id]: error instanceof Error ? error.message : tr("usecleoworkspace.could_not_synchronize_run_status_retrying_automatically") }));
        }
      }));
      if (active) timer = window.setTimeout(() => void refresh(), 1500);
    };
    void refresh();
    return () => { active = false; window.clearTimeout(timer); };
  }, [restoredRuns]);
  useEffect(() => {
    setSnapshot(current => current && { ...current, threads: current.threads.map(thread =>
      thread.id === activeThreadId || runLocks.current.has(thread.id)
        ? thread : { ...thread, items: [] }) });
    if (activeThread?.history?.total && !activeThread.items.length) void history.load("latest");
  }, [activeThreadId, runs]);

  const selectSpace = (space: WorkspaceSpace) => {
    clearLoadingError();
    if (space === activeSpace) return;
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
    const projectForSpace = defaultProjectFor(snapshot.projects, space);
    const preferredProjectId =
      activeProject?.space === space
        ? activeProjectId : projectForSpace?.id ?? "";
    const next =
      snapshot.threads.find(
        (thread) => thread.space === space && thread.projectId === preferredProjectId,
      ) ?? snapshot.threads.find((thread) => thread.space === space);
    if (next) {
      setActiveProjectId(next.projectId);
      setActiveThreadId(next.id);
    } else {
      setActiveProjectId(projectForSpace?.id ?? "");
      setActiveThreadId(null);
    }
  };

  /** Purpose: Move the unsent draft to another project without losing its text.
   * Input: a project of the current space. Output: the draft is parked there and shown;
   * saved threads keep the project they ran in, so a thread on screen is simply left.
   */
  const retargetDraft = (projectId: string) => {
    if (activeSpace === "memory" || projectId === activeProjectId) return;
    clearLoadingError();
    selectionRef.current += 1;
    const from = `new:${activeSpace}:${activeProjectId}`;
    const to = `new:${activeSpace}:${projectId}`;
    setDrafts((current) => {
      const moving = current[from];
      if (!moving) return current;
      const { [from]: _moved, ...rest } = current;
      return { ...rest, [to]: moving };
    });
    setActiveProjectId(projectId);
    setActiveThreadId(null);
  };

  const selectThread = (threadId: string) => {
    clearLoadingError();
    const thread = snapshot?.threads.find((candidate) => candidate.id === threadId);
    if (!thread) return;
    const selection = ++selectionRef.current;
    const version = threadVersions.current.get(threadId);
    setActiveSpace(thread.space);
    setActiveProjectId(thread.projectId);
    setActiveThreadId(threadId);
    markThreadRead(threadId);
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
        setLoadingError(error instanceof Error ? error.message : tr("usecleoworkspace.could_not_restore_history"));
      });
  };

  /** Purpose: Open an empty task.
   * Input: optionally the project to park the draft in (a sidebar group's "+"); otherwise the
   * draft stays where the user is. Output: the selection is cleared; saved tasks stay untouched.
   */
  const startNewThread = (projectId?: string) => {
    selectionRef.current += 1;
    if (projectId) setActiveProjectId(projectId);
    if (activeSpace === "chat" && runtimeCatalog?.defaultNonProductivityProfile) {
      setDraftProfileId(runtimeCatalog.defaultNonProductivityProfile);
    }
    if (activeThread?.space === "productivity") {
      setDraftProvider(activeThreadRuntime?.provider ?? draftProvider);
      setDraftModel(activeThreadRuntime?.model ?? draftModel);
      setDraftEffort(activeThreadRuntime?.effort ?? draftEffort);
      setDraftServiceTier(activeThreadRuntime?.serviceTier ?? "default");
      // The next task inherits the permissions of the one on screen, like its model.
      if (activeThread.runtime) {
        setDraftPermissionsState({
          provider: activeThread.runtime.provider,
          access: activeThread.runtime.access, approval: activeThread.runtime.approval,
        });
      }
    }
    setActiveThreadId(null);
  };

  const createThread = async () => {
    const selection = ++selectionRef.current;
    const space: ThreadSpace = activeSpace === "chat" ? "chat" : "productivity";
    const project = snapshot?.projects.find(
      (candidate) => candidate.id === activeProjectId && candidate.space === space,
    ) ?? (space === "productivity"
      ? snapshot?.projects.find((candidate) => candidate.id === GENERAL_PRODUCTIVITY_PROJECT)
      : undefined)
      ?? snapshot?.projects.find((candidate) => candidate.space === space);
    if (!project && space === "chat") throw new Error(tr("usecleoworkspace.open_a_working_directory_first"));
    // Development work binds no folder by default: it belongs to the general project.
    const thread = await cleoClient.createThread(
      space,
      project?.id ?? GENERAL_PRODUCTIVITY_PROJECT,
      space === "chat"
        ? {
            projectPath: project?.path,
            profileId: draftProfileId || runtimeCatalog?.defaultNonProductivityProfile,
          }
        : {
            projectPath: project?.managed ? undefined : project?.path,
            provider: draftProvider || runtimeCatalog?.defaultProductivityProvider,
            model: draftModel || undefined,
            effort: draftEffort ?? undefined,
            serviceTier: draftRuntime.supportsFastMode ? draftServiceTier : undefined,
            ...draftPermissionUpdate,
          },
    );
    if (!project) {
      // An older backend lists general only after its first task; reload so the thread has a home.
      await refreshWorkspace(() => cleoClient.loadWorkspace()).catch(() => {});
      setSnapshot((current) => current && !current.threads.some(item => item.id === thread.id)
        ? { ...current, threads: [thread, ...current.threads] } : current);
      if (selectionRef.current === selection) setActiveProjectId(thread.projectId);
    } else {
      setSnapshot((current) =>
        current ? { ...current, threads: [thread, ...current.threads] } : current,
      );
    }
    if (selectionRef.current === selection) setActiveThreadId(thread.id);
    return thread;
  };

  /** Purpose: Register a selected folder and carry the unsent draft into its composer.
   * Input: Native directory selection. Output: Registered workspace; cancellation keeps selection.
   * A late dialog result must not replace a task the user selected in the meantime.
   */
  const chooseWorkspace = async () => {
    if (workspacePickerOpen.current) return null;
    workspacePickerOpen.current = true;
    setChoosingWorkspace(true);
    const selection = selectionRef.current;
    const space: ThreadSpace = activeSpace === "chat" ? "chat" : "productivity";
    try {
      const projectPath = await cleoClient.pickWorkspace();
      if (!projectPath) return null;
      const refreshed = await refreshWorkspace(() => cleoClient.addProject(space, projectPath));
      const projectId = refreshed.selectedProjectId;
      if (!projectId || !refreshed.projects.some(project => project.id === projectId)) {
        throw new Error(tr("usecleoworkspace.folder_added_but_its_project_could_not_be_located_select_it_in_the_project_list"));
      }
      if (selectionRef.current === selection) {
        if (activeThreadId === null && activeSpace !== "memory") {
          retargetDraft(projectId);
        } else {
          selectionRef.current += 1;
          setActiveSpace(space);
          setActiveProjectId(projectId);
          setActiveThreadId(null);
        }
      }
      return projectPath;
    } finally {
      workspacePickerOpen.current = false;
      setChoosingWorkspace(false);
    }
  };

  /** Purpose: Stream a user turn or diagnostic follow-up into a task.
   * Input: prompt, optional task, and draft preservation for controller-generated diagnostics.
   * Output: whether the turn was submitted; diagnostic follow-ups leave draft text and attachments untouched.
   */
  const sendPrompt = async (rawPrompt: string, targetThread?: Thread, { preserveDraft = false, deliveryId = "",
    attachments }: { preserveDraft?: boolean; deliveryId?: string; attachments?: Attachment[] } = {}): Promise<boolean> => {
    const prompt = rawPrompt.trim();
    const lockKey = targetThread?.id ?? activeThread?.id ?? draftKey;
    if (!prompt || runLocks.current.has(lockKey)
      || harnessSwitchRef.current.has(targetThread?.id ?? activeThreadId ?? "")) return false;
    const token = deliveryId || crypto.randomUUID();
    runLocks.current.set(lockKey, token);
    setStartingKeys(keys => [...keys, lockKey]);
    // A commit, revert or push is changing this checkout: the agent must not start editing it now.
    // (Checked under the run lock, so a second Enter cannot slip past while git is asked.)
    const targetProject = projectById(targetThread?.projectId ?? activeThread?.projectId ?? activeProjectId);
    if (targetProject && gitMutations.current.size) await resolveRunningRoots(targetProject);
    if (targetProject && gitMutationBusy(targetProject)) {
      updateDraft(targetThread?.id ?? draftKey, (current) => ({ ...current, error: tr("sourcecontrol.git_action_in_progress") }));
      if (runLocks.current.get(lockKey) === token) runLocks.current.delete(lockKey);
      setStartingKeys(keys => keys.filter(key => key !== lockKey));
      return false;
    }
    const sourceDraftKey = targetThread?.id ?? draftKey;
    // Queued and edited messages carry their own attachments and leave the composer alone.
    const fromDraft = !preserveDraft && !attachments;
    const pendingAttachments = attachments ?? (preserveDraft ? [] : draft.attachments);
    updateDraft(sourceDraftKey, (current) => ({ ...current, error: undefined }));

    let thread = targetThread ?? activeThread;
    const selection = selectionRef.current + (thread ? 0 : 1);
    try {
      if (!thread) thread = await createThread();
      if (!preserveDraft && history.isActive(thread.id)) {
        if (thread.history?.hasAfter && !await history.load("latest")) {
          throw new Error(tr("usecleoworkspace.could_not_load_the_latest_conversation_retry_sending"));
        }
        history.follow(true);
      }
    } catch (error) {
      updateDraft(sourceDraftKey, (current) => ({
        ...current,
        error: error instanceof Error ? error.message : tr("usecleoworkspace.could_not_create_the_conversation_try_again"),
      }));
      if (runLocks.current.get(lockKey) === token) runLocks.current.delete(lockKey);
      setStartingKeys(keys => keys.filter(key => key !== lockKey));
      return false;
    }

    const threadId = thread.id;
    // A harness picked for this task is handed off now, right before the message it was picked for.
    // A failed handoff leaves the task on its live harness with the draft untouched.
    const pendingSwitch = pendingSwitchesRef.current[threadId];
    if (pendingSwitch) {
      harnessSwitchRef.current.add(threadId);
      setHarnessSwitches(current => ({ ...current, [threadId]: pendingSwitch.provider }));
      try {
        let runtime = await cleoClient.switchHarness(
          threadId, pendingSwitch.provider, pendingSwitch.model, pendingSwitch.effort ?? undefined,
        );
        updateThread(threadId, current => ({ ...current, runtime, skills: [] }));
        void refreshSkills(thread, pendingSwitch.provider);
        if (pendingSwitch.serviceTier && runtime.supportsFastMode) {
          runtime = await cleoClient.updateRuntime(threadId, { serviceTier: pendingSwitch.serviceTier });
          updateThread(threadId, current => ({ ...current, runtime }));
        }
        setPendingSwitch(threadId, null);
      } catch (error) {
        setPendingSwitch(threadId, null);
        updateDraft(sourceDraftKey, (current) => ({
          ...current,
          error: error instanceof Error ? error.message : tr("usecleoworkspace.switch_failed_the_original_session_remains_available"),
        }));
        if (runLocks.current.get(lockKey) === token) runLocks.current.delete(lockKey);
        setStartingKeys(keys => keys.filter(key => key !== lockKey));
        return false;
      } finally {
        harnessSwitchRef.current.delete(threadId);
        setHarnessSwitches(current => {
          const next = { ...current }; delete next[threadId]; return next;
        });
      }
    }
    const canNavigate = () => selectionRef.current === selection;
    // Creating the conversation took time; a git action may have started in this checkout since.
    // Checked again right before the turn starts, so the agent never edits files under it.
    const startingProject = projectById(thread.projectId) ?? targetProject;
    if (startingProject && gitMutationBusy(startingProject)) {
      updateDraft(sourceDraftKey, (current) => ({ ...current, error: tr("sourcecontrol.git_action_in_progress") }));
      if (runLocks.current.get(lockKey) === token) runLocks.current.delete(lockKey);
      setStartingKeys(keys => keys.filter(key => key !== lockKey));
      return false;
    }
    if (lockKey !== threadId) runLocks.current.delete(lockKey);
    runLocks.current.set(threadId, token);
    const userItem: TimelineItem = {
      id: `${threadId}-user-${Date.now()}`,
      type: "message",
      role: "user",
      content: prompt,
      time: currentTime(),
      // Chips show at once; the backend's turn-started item carries the saved records.
      ...(pendingAttachments.length ? { attachments: pendingAttachments.map(({ base64: _bytes, ...chip }) => chip) } : {}),
    };
    let turnId = userItem.id;
    userItem.turnId = turnId;
    setRuns(current => ({ ...current, [threadId]: token }));
    setStartingKeys(keys => keys.filter(key => key !== lockKey));
    if (fromDraft) updateDraft(sourceDraftKey, (current) => ({
      prompt: current.prompt === draft.prompt ? "" : current.prompt,
      attachments: current.attachments.filter((item) => !pendingAttachments.some((sent) => sent.path === item.path)),
    }));
    updateThread(threadId, (current) => ({
      ...current,
      title: current.items.length === 0 ? prompt.slice(0, 26) : current.title,
      summary: prompt.slice(0, 64),
      status: "running",
      steerReady: false,
      updatedAt: tr("memoryview.just_now"),
      items: !preserveDraft || history.isFollowing(threadId) ? [...current.items, userItem] : current.items,
    }));

    let failed = false;
    // Whether the backend took the message (it started a turn or sent anything back). A run that
    // fails before that delivered nothing, and callers keep what they sent (queued messages, notes).
    let accepted = false;
    // Subtask routing creates and runs child sessions during this turn. While it delegates, the
    // task list is reloaded every few seconds so new subtasks and their states appear as they happen.
    let delegating = false;
    let lastListRefresh = 0;
    const refreshSubtasks = () => {
      lastListRefresh = Date.now();
      void refreshWorkspace(() => cleoClient.loadWorkspace()).catch(() => {});
    };
    const subtaskPoll = window.setInterval(() => { if (delegating && Date.now() - lastListRefresh > 4000) refreshSubtasks(); }, 4000);
    try {
      for await (const event of cleoClient.streamTurn(threadId, prompt, pendingAttachments, token)) {
        if (runLocks.current.get(threadId) !== token) return true;
        // Only the turn itself acknowledges the message; runtime or usage updates can precede a
        // failure to start, and do not mean the message was delivered.
        if (event.type === "turn-started" || event.type === "upsert-item" || event.type === "done"
          || event.type === "approval-request" || event.type === "question-request") accepted = true;
        if (event.type === "turn-started") {
          turnId = event.item.turnId ?? event.item.id;
          updateThread(threadId, current => ({ ...current, steerReady: true,
            items: current.items.map(item => item.id === userItem.id ? event.item : item) }));
        } else if (event.type === "upsert-item") {
          const projected = { ...event.item, turnId: event.item.turnId ?? turnId };
          upsertTimelineItem(threadId, projected);
          if (event.item.type === "tool" && /subtask/i.test(event.item.name)) {
            delegating = true;
            if (Date.now() - lastListRefresh > 1500) refreshSubtasks();
          }
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
        } else if (event.type === "task-usage") {
          updateThread(threadId, (current) => ({ ...current, taskUsage: event.usage }));
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
          if (canNavigate()) {
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
          markReplyFinished(threadId);
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
                // Same title as the persisted error notice shows after a reload.
                title: tr("usecleoworkspace.run_needs_attention"),
                detail: event.message,
              },
            ],
          }));
        }
      }
    } catch (error) {
      if (runLocks.current.get(threadId) !== token) return true;
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
            title: tr("usecleoworkspace.runtime_temporarily_unavailable"),
            detail: error instanceof Error ? error.message : tr("usecleoworkspace.try_again_later"),
          },
        ],
      }));
    } finally {
      window.clearInterval(subtaskPoll);
      // The final states of this turn's subtasks.
      if (delegating) refreshSubtasks();
      if (runLocks.current.get(threadId) === token) {
        if (!failed) {
          updateThread(threadId, (current) =>
            current.status === "running" ? { ...current, status: cancellingRuns.current.has(token) ? "attention" : "completed" } : current,
          );
          if (!cancellingRuns.current.has(token)) markReplyFinished(threadId);
        }
        runLocks.current.delete(threadId);
        setRuns(current => { const next = { ...current }; if (next[threadId] === token) delete next[threadId]; return next; });
        setPendingApprovals((current) => current.filter(
          (candidate) => candidate.threadId !== threadId,
        ));
        questions.finish(threadId);
        void refreshMemory();
        // The backend records which preferences the turn was given after the message itself;
        // pick that record up so the turn shows it without a reload.
        if (!failed && thread.space === "productivity") {
          // A background read: it must not make this task the backend's current one (activate=false).
          void cleoClient.loadThread(threadId, false).then(loaded => updateThread(threadId, current => ({
            ...current,
            items: current.items.map(item => {
              const saved = item.type === "message" ? loaded.items.find(candidate => candidate.id === item.id) : undefined;
              return item.type === "message" && saved?.type === "message" && saved.memoryContext && !item.memoryContext
                ? { ...item, memoryContext: saved.memoryContext } : item;
            }),
          }))).catch(() => {});
        }
        if (history.isActive(threadId) && history.isFollowing(threadId) && thread.history) await history.load("latest");
        // Messages queued during a run go next; a stopped or failed run keeps them for the user.
        if (!failed && !cancellingRuns.current.has(token) && queuesRef.current[threadId]?.length
            && !runLocks.current.has(threadId)) {
          const queued = queuesRef.current[threadId];
          setQueues(current => ({ ...current, [threadId]: [] }));
          void sendQueuedMessages(thread, queued);
        }
      }
    }
    return accepted || !failed;
  };

  const sendQueuedMessages = async (thread: Thread, queued: QueuedMessage[]) => {
    const submitted = await sendPrompt(queued.map(item => item.text).filter(Boolean).join("\n\n") || tr("conversation.please_analyze_these_attachments"), thread, {
      attachments: queued.flatMap(item => item.attachments),
    });
    if (!submitted) updateQueue(thread.id, current => [...queued, ...current]);
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
          title: tr("usecleoworkspace.could_not_stop"),
          detail: error instanceof Error ? error.message : tr("usecleoworkspace.retry_the_stop_operation"),
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
          title: tr("usecleoworkspace.current_run_stopped"),
          detail: "",
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
      setApprovalErrors(current => ({ ...current, [request.threadId]: error instanceof Error ? error.message : tr("usecleoworkspace.could_not_submit_the_approval_decision") }));
    } finally {
      approvalSending.current.delete(key);
      approvalVersions.current.set(request.threadId, (approvalVersions.current.get(request.threadId) ?? 0) + 1);
      setApprovalPending(current => current.filter(value => value !== key));
    }
  };

  const renameThread = async (title: string) => {
    const threadId = activeThreadId;
    if (!threadId || !title.trim()) throw new Error(tr("usecleoworkspace.enter_a_conversation_name"));
    if (runLocks.current.has(threadId)) throw new Error(tr("usecleoworkspace.wait_for_the_current_run_to_finish_before_renaming"));
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
      throw new Error(tr("usecleoworkspace.the_steering_receipt_does_not_match_the_target_run"));
    }
    upsertTimelineItem(threadId, item);
    return item;
  };

  /** Purpose: Deliver one message into the active run. Input: text. Output: whether it was submitted. */
  const sendSteer = async (text: string) => {
    const threadId = activeThreadId;
    const runId = threadId ? runLocks.current.get(threadId) : undefined;
    if (!threadId || !runId || !text.trim() || steeringLocks.current.has(threadId)) return false;
    const previous = steeringRequests.current.get(threadId);
    const requestId = previous?.runId === runId && previous.text === text ? previous.id : crypto.randomUUID();
    steeringRequests.current.set(threadId, { id: requestId, runId, text });
    steeringLocks.current.add(threadId);
    setSteeringThreads(current => [...current, threadId]);
    updateDraft(threadId, current => ({ ...current, error: undefined }));
    try {
      await submitSteer(threadId, runId, text, requestId);
      return true;
    } catch (error) {
      if (steeringRequests.current.get(threadId)?.id === requestId) {
        updateDraft(threadId, current => ({ ...current, error: error instanceof Error
          ? tr("usecleoworkspace.value_retrying_will_verify_the_same_message", { p0: error.message }) : tr("usecleoworkspace.submission_is_not_confirmed_retrying_will_verify_the_same_message") }));
      }
      return false;
    } finally {
      steeringLocks.current.delete(threadId);
      setSteeringThreads(current => current.filter(id => id !== threadId));
    }
  };

  const updateQueue = (threadId: string, update: (queue: QueuedMessage[]) => QueuedMessage[]) => {
    setQueues(current => ({ ...current, [threadId]: update(current[threadId] ?? []) }));
  };

  /** Purpose: Hold a message typed during a run. Input: composer text. Output: queue entry; draft cleared. */
  /** Queue a message for after the current run. By default it is the composer's draft (text and
   * attachments), which is then cleared; `fromDraft: false` queues only the given text and leaves
   * the draft alone (review notes sent from the details panel). Returns whether it was queued. */
  const queueMessage = (text: string, { fromDraft = true }: { fromDraft?: boolean } = {}) => {
    const threadId = activeThreadId;
    const prompt = text.trim();
    const attachments = fromDraft ? draft.attachments : [];
    if (!threadId || (!prompt && !attachments.length)) return false;
    updateQueue(threadId, queue => [...queue, { id: crypto.randomUUID(), text: prompt, attachments }]);
    if (fromDraft) updateDraft(draftKey, current => ({ ...current, prompt: "", attachments: [], error: undefined }));
    return true;
  };

  const takeQueued = (id: string) => {
    const threadId = activeThreadId;
    const queued = threadId ? queuesRef.current[threadId]?.find(item => item.id === id) : undefined;
    if (!threadId || !queued) return null;
    updateQueue(threadId, queue => queue.filter(item => item.id !== id));
    return { threadId, queued };
  };

  const removeQueued = (id: string) => { takeQueued(id); };

  /** Purpose: Return a queued message to the composer for further editing. */
  const editQueued = (id: string) => {
    const taken = takeQueued(id);
    if (!taken) return;
    updateDraft(taken.threadId, current => ({ ...current, error: undefined,
      prompt: current.prompt.trim() ? `${current.prompt}\n\n${taken.queued.text}` : taken.queued.text,
      attachments: mergeAttachments(current.attachments, taken.queued.attachments) }));
  };

  /** Purpose: Steer a queued message into the active run; it returns to the queue if submission fails. */
  const steerQueued = async (id: string) => {
    const threadId = activeThreadId;
    const queue = threadId ? queuesRef.current[threadId] ?? [] : [];
    const position = queue.findIndex(item => item.id === id);
    if (!threadId || position < 0 || queue[position].attachments.length || steeringLocks.current.has(threadId)) return;
    const queued = queue[position];
    updateQueue(threadId, current => current.filter(item => item.id !== id));
    if (!await sendSteer(queued.text)) {
      updateQueue(threadId, current => [...current.slice(0, position), queued, ...current.slice(position)]);
    }
  };

  /** Purpose: Insert the composer's text into the running turn now (Steer) instead of queueing it.
   * Input: the text. Output: the draft is cleared once the harness accepts it; on failure it is put
   * back so nothing typed is lost. Attachments cannot be steered and keep the message queued. */
  const steerDraft = async (text: string) => {
    const threadId = activeThreadId;
    const prompt = text.trim();
    if (!threadId || !prompt || draft.attachments.length) return false;
    updateDraft(draftKey, current => ({ ...current, prompt: "", error: undefined }));
    const accepted = await sendSteer(prompt);
    if (!accepted) updateDraft(threadId, current => ({ ...current, prompt: current.prompt.trim() ? `${prompt}\n\n${current.prompt}` : prompt }));
    return accepted;
  };

  /** Purpose: Send a queued message now when no run is active (for example after a stop). */
  const sendQueued = (id: string) => {
    const taken = runLocks.current.has(activeThreadId ?? "") ? null : takeQueued(id);
    if (!taken) return;
    const thread = snapshotRef.current?.threads.find(item => item.id === taken.threadId);
    if (thread) void sendQueuedMessages(thread, [taken.queued]);
  };

  /** Purpose: Resend an earlier user message after rewinding the conversation to just before it.
   * Input: message ID and edited text. Output: rewound thread and a new turn; refusals throw.
   */
  const editMessage = async (itemId: string, text: string) => {
    const threadId = activeThreadId;
    const prompt = text.trim();
    if (!threadId || !prompt) return;
    if (runLocks.current.has(threadId)) throw new Error(tr("usecleoworkspace.wait_for_the_current_run_to_finish_before_editing_a_message"));
    const rewound = await cleoClient.rewindThread(threadId, itemId);
    updateThread(threadId, () => rewound);
    await sendPrompt(prompt, rewound, { attachments: [] });
  };

  const retrySteer = async (receipt: SteerReceipt) => {
    if (steeringLocks.current.has(receipt.threadId)) return;
    steeringLocks.current.add(receipt.threadId);
    setSteeringThreads(current => [...current, receipt.threadId]);
    try {
      await submitSteer(receipt.threadId, receipt.runId, receipt.text, receipt.id, true);
    } catch (error) {
      updateDraft(receipt.threadId, current => ({ ...current,
        error: error instanceof Error ? error.message : tr("usecleoworkspace.could_not_verify_the_steering_message_try_again"),
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
    const pendingSwitch = activeThreadId ? pendingSwitchesRef.current[activeThreadId] : undefined;
    if (activeThreadId && pendingSwitch && (update.effort || update.serviceTier)) {
      // Effort and speed for a harness that has not been handed off yet travel with the handoff.
      setPendingSwitch(activeThreadId, {
        ...pendingSwitch,
        ...(update.effort ? { effort: update.effort } : {}),
        ...(update.serviceTier ? { serviceTier: update.serviceTier } : {}),
      });
      return;
    }
    if (activeSpace === "productivity" && update.serviceTier) {
      setDraftServiceTier(update.serviceTier);
    }
    if (activeSpace === "productivity" && update.effort) {
      setDraftEffort(update.effort);
    }
    const threadId = activeThreadId;
    if (!threadId) return;
    const selection = selectionRef.current;
    return cleoClient
      .updateRuntime(threadId, update)
      .then((runtime) => {
        updateThread(threadId, current => ({ ...current, runtime }));
      })
      .catch((error: unknown) => {
        if (selectionRef.current !== selection) return;
        loadingRetry.current = () => updateRuntime(update);
        setLoadingError(error instanceof Error ? error.message : tr("usecleoworkspace.could_not_update_run_settings"));
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
    provider: string, projectPath = activeProject?.path, refresh = false, background = false,
  ) => {
    // Picker probes must not replace another provider's loading/error/effort state.
    if (background) return cleoClient.getProductivityModels(provider, projectPath);
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
      const message = error instanceof Error && error.message ? error.message : tr("usecleoworkspace.could_not_load_the_model_list_try_again");
      if (modelRequestRef.current === request) setRuntimeModelsError(message);
      throw error;
    } finally {
      if (modelRequestRef.current === request) setRuntimeModelsLoading(null);
    }
  };

  /** Purpose: Refresh a task's capabilities after a handoff; the timeline and draft stay in place. */
  const refreshSkills = async (thread: Thread, provider: string) => {
    const projectPath = snapshotRef.current?.projects.find(project => project.id === thread.projectId)?.path
      ?? activeProject?.path;
    try {
      const skills = await cleoClient.getLocalSkills(provider, projectPath);
      updateThread(thread.id, current => ({ ...current, skills }));
    } catch {
      updateDraft(thread.id, current => ({ ...current,
        error: tr("usecleoworkspace.harness_switched_the_skills_list_is_temporarily_unavailable"),
      }));
    }
  };

  /** Purpose: Record which harness and model a task should use from its next message on.
   * Input: the picked harness and model. Output: an existing task keeps running on its live
   * harness and shows the pick as pending; picking the live harness back cancels the pick.
   * The handoff itself happens in sendPrompt. New drafts only change their initial selection.
   */
  const selectProductivityRuntime = (provider: string, model: string) => {
    const selectedModel = productivityModels[provider]?.models.find(
      (candidate) => candidate.id === model,
    );
    if (activeThread?.space === "productivity") {
      const threadId = activeThread.id;
      if (harnessSwitchRef.current.has(threadId)) return;
      setPendingSwitch(threadId, nextPendingSwitch(activeThread.runtime, {
        provider, model, effort: selectedModel?.defaultEffort ?? null,
      }));
      updateDraft(threadId, current => ({ ...current, error: undefined }));
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
      throw new Error(tr("usecleoworkspace.only_development_tasks_can_revert_git_changes"));
    }
    if (runLocks.current.has(activeThread.id)) {
      throw new Error(tr("usecleoworkspace.the_task_is_running_stop_it_before_reverting"));
    }
    // Undoing the latest turn rewrites files like any git action: it takes the same reservation, so
    // a commit, revert or new task cannot overlap it in this checkout.
    const project = projectById(activeThread.projectId);
    if (project) {
      await resolveRunningRoots(project);
      if (gitMutationBusy(project)) throw new Error(tr("sourcecontrol.checkout_busy"));
    } else if (gitMutations.current.has(activeThread.projectId)) {
      throw new Error(tr("sourcecontrol.checkout_busy"));
    }
    // The reservation is held by project id even when the project is not listed.
    const reservation = activeThread.projectId;
    gitMutations.current.add(reservation);
    try {
      let result: Awaited<ReturnType<typeof cleoClient.undoChanges>>;
      await refreshWorkspace(async () => { result = await cleoClient.undoChanges(activeThread.id); return result.workspace; });
      return result!;
    } finally {
      gitMutations.current.delete(reservation);
    }
  };
  /** Purpose: Run a git action on the current task's folder, then reload what it changed.
   * Input: the operation and its parameters (the folder and task are filled in).
   * Output: the bridge's result; the workspace and the task's change list are refreshed afterwards.
   */
  const runSourceControl = async <T = unknown>(op: SourceControlOp, params: Record<string, unknown> = {}): Promise<T> => {
    const project = activeProject;
    if (!project?.path || project.managed) throw new Error(tr("sourcecontrol.no_repository"));
    const readOnly = op === "status" || op === "root" || op === "pullRequest" || op === "listFiles";
    // Any task still running in the same checkout could lose or leak work to a revert or commit,
    // and while the action runs no task may start there. Which projects share the checkout is
    // settled with git first, not guessed from folder names.
    if (!readOnly) {
      await resolveRunningRoots(project);
      if (checkoutBusy(project.id) || gitMutationBusy(project)) throw new Error(tr("sourcecontrol.checkout_busy"));
      gitMutations.current.add(project.id);
    }
    try {
      const result = await cleoClient.sourceControl<T>(op, { root: project.path, threadId: activeThread?.id ?? null, ...params });
      const root = op === "status" ? (result as { root?: string } | null)?.root : undefined;
      if (root) checkoutRoots.current[normalizedPath(project.path)] = normalizedPath(root);
      if (op === "status") noteLiveBranch(project, result as { repository?: boolean; branch?: string | null } | null);
      if (!readOnly) {
        await refreshWorkspace(() => cleoClient.loadWorkspace()).catch(() => {});
        const threadId = activeThread?.id;
        // A background refresh: the user may have moved to another task while git worked (activate=false).
        if (threadId) await cleoClient.loadThread(threadId, false).then(loaded => updateThread(threadId, () => loaded)).catch(() => {});
      }
      return result;
    } finally {
      if (!readOnly) gitMutations.current.delete(project.id);
    }
  };

  /** Purpose: Start the draft as a task isolated in a new git worktree of the draft's project.
   * Input: the prompt. Output: a `cleo/<slug>` worktree is created and added as a project, the draft
   * moves there, and the prompt is sent once the move has rendered (see the effect below).
   */
  const sendInWorktree = async (prompt: string) => {
    const project = activeProject;
    if (!project?.path || project.managed || activeThreadId !== null || activeSpace !== "productivity") return sendPrompt(prompt);
    // One worktree per send: a second Enter while git is still working does nothing.
    if (creatingWorktreeRef.current) return false;
    creatingWorktreeRef.current = true;
    setCreatingWorktree(true);
    const selection = selectionRef.current;
    try {
      const worktree = await cleoClient.sourceControl<{ path: string; branch: string }>("createWorktree", { root: project.path, name: prompt });
      const refreshed = await refreshWorkspace(() => cleoClient.addProject("productivity", worktree.path));
      const projectId = refreshed.selectedProjectId;
      if (!projectId) throw new Error(tr("usecleoworkspace.folder_added_but_its_project_could_not_be_located_select_it_in_the_project_list"));
      // If the user moved elsewhere meanwhile, the worktree stays listed but the draft is not pulled along.
      if (selectionRef.current !== selection) return false;
      pendingWorktreeSend.current = { projectId, prompt };
      retargetDraft(projectId);
      return true;
    } finally {
      creatingWorktreeRef.current = false;
      setCreatingWorktree(false);
    }
  };
  const creatingWorktreeRef = useRef(false);
  const [creatingWorktree, setCreatingWorktree] = useState(false);
  /** The branch git last reported for each project's folder (null: detached HEAD). It can differ
   * from the workspace's own record when the checkout was switched outside Cleo; until the two agree,
   * review notes are neither shown nor added (see App). */
  const [liveBranches, setLiveBranches] = useState<Record<string, string | null>>({});
  const reconciledBranch = useRef("");
  const noteLiveBranch = (project: Project, status: { repository?: boolean; branch?: string | null } | null) => {
    if (!status?.repository) return;
    const branch = status.branch || null;
    setLiveBranches((current) => current[project.id] === branch ? current : { ...current, [project.id]: branch });
    // Compared with the workspace's record as it is now, not as it was when git was asked: the record
    // may have been reloaded meanwhile (a switch A → B → A must reload again on the way back).
    const recorded = snapshotRef.current?.projects.find((item) => item.id === project.id) ?? project;
    if (projectBranchName(recorded.branch) === branch) { reconciledBranch.current = ""; return; }
    // Reload once per newly seen branch, so the project's branch and the task's changes catch up together.
    const key = `${project.id}|${branch}`;
    if (reconciledBranch.current === key) return;
    reconciledBranch.current = key;
    void refreshWorkspace(() => cleoClient.loadWorkspace()).catch(() => {});
    const threadId = activeThread?.id;
    if (threadId) void cleoClient.loadThread(threadId, false).then((loaded) => updateThread(threadId, () => loaded)).catch(() => {});
  };
  /** Purpose: Ask git for the current task's branch again and, if the workspace's record still
   * differs, reload the workspace again (the once-per-branch limit is lifted for this request). */
  const recheckBranch = async () => {
    reconciledBranch.current = "";
    await runSourceControl("status").catch(() => {});
  };
  /** Each checkout's top folder by project path ("" outside git), learned from git. */
  const checkoutRoots = useRef<Record<string, string>>({});
  const [, setRootsVersion] = useState(0);
  /** Purpose: Learn (once) which working tree a project's folder belongs to. */
  const resolveCheckoutRoot = async (project: Project | undefined) => {
    if (!project?.path || project.managed || project.space !== "productivity") return;
    const key = normalizedPath(project.path);
    if (key in checkoutRoots.current) return;
    try {
      const answer = await cleoClient.sourceControl<{ root: string | null }>("root", { root: project.path });
      checkoutRoots.current[key] = answer?.root ? normalizedPath(answer.root) : "";
      setRootsVersion(version => version + 1);
    } catch { /* unknown stays unknown: the containment fallback applies */ }
  };
  // Every development project's working tree is looked up when the project list changes, so
  // projects that share one checkout (a repository and its subfolders) are known to do so.
  const projectPathsKey = snapshot?.projects.map(project => project.path).join("\n") ?? "";
  useEffect(() => {
    for (const project of snapshot?.projects ?? []) void resolveCheckoutRoot(project);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPathsKey]);
  /** Before a git action or a guarded send: the roots of every project involved are known. */
  const resolveRunningRoots = async (project: Project) => {
    const involved = [project, ...[...gitMutations.current].map(projectById),
      ...(snapshot?.threads ?? []).filter(thread => thread.status === "running" || runLocks.current.has(thread.id)).map(thread => projectById(thread.projectId)),
      // New tasks still being created hold their project too.
      ...[...runLocks.current.keys()].filter(key => key.startsWith("new:productivity:")).map(key => projectById(key.slice("new:productivity:".length)))];
    await Promise.all(involved.map(resolveCheckoutRoot));
  };
  /** Projects with a git action in flight: no task may start in their checkout until it ends. */
  const gitMutations = useRef(new Set<string>());
  /** Purpose: Tell whether two projects work in the same git working tree.
   * Input: two projects. Output: true when git said they share a top folder, or (before git has
   * answered for both) when one folder contains the other outside a Cleo worktree. */
  const sameCheckout = (a: Project, b: Project) => {
    if (a.id === b.id) return true;
    if (!a.path || !b.path) return false;
    const left = normalizedPath(a.path);
    const right = normalizedPath(b.path);
    const [rootA, rootB] = [checkoutRoots.current[left], checkoutRoots.current[right]];
    if (rootA !== undefined && rootB !== undefined) return Boolean(rootA) && rootA === rootB;
    const contains = (outer: string, inner: string) => inner === outer
      || (inner.startsWith(`${outer}/`) && !inner.slice(outer.length).includes("/.cleo/worktrees/"));
    return contains(left, right) || contains(right, left);
  };
  const projectById = (projectId: string) => snapshot?.projects.find(project => project.id === projectId);
  /** True while a conversation is running — or a new task is starting — in the given project's
   * checkout (any project sharing it). A starting draft holds a "new:productivity:<project>" lock. */
  const checkoutBusy = (projectId: string) => {
    const project = projectById(projectId);
    if (!project) return false;
    const shares = (otherId: string) => {
      if (otherId === projectId) return true;
      const other = projectById(otherId);
      return Boolean(other && sameCheckout(project, other));
    };
    const starting = [...runLocks.current.keys()].some(key => key.startsWith("new:productivity:") && shares(key.slice("new:productivity:".length)));
    return starting || Boolean(snapshot?.threads.some(thread => (thread.status === "running" || runLocks.current.has(thread.id)) && shares(thread.projectId)));
  };
  /** True while a git action runs in the given project's checkout. */
  const gitMutationBusy = (project: Project) => [...gitMutations.current].some(id => {
    const other = projectById(id);
    return Boolean(other && sameCheckout(project, other));
  });
  /** Remove a Cleo worktree project: the folder through git (refusing uncommitted work unless forced),
   * then the project; the parent repository is selected afterwards so nothing points at the removed folder. */
  const removeWorktreeProject = async (projectToRemove: Project, force = false) => {
    await resolveRunningRoots(projectToRemove);
    if (checkoutBusy(projectToRemove.id) || gitMutationBusy(projectToRemove)) throw new Error(tr("sourcecontrol.checkout_busy"));
    // Removal is a git action like any other: no task may start in this worktree meanwhile.
    gitMutations.current.add(projectToRemove.id);
    try {
      await cleoClient.sourceControl("removeWorktree", { root: projectToRemove.path, force });
    } finally {
      gitMutations.current.delete(projectToRemove.id);
    }
    const wasSelected = activeProjectId === projectToRemove.id;
    const refreshed = await refreshWorkspace(() => cleoClient.removeProject(projectToRemove.id));
    if (!wasSelected) return;
    const parentPath = normalizedPath(projectToRemove.path ?? "").split("/.cleo/worktrees/")[0];
    const parent = refreshed.projects.find(project => project.space === "productivity" && project.path && normalizedPath(project.path) === parentPath)
      ?? refreshed.projects.find(project => project.space === "productivity");
    selectionRef.current += 1;
    setActiveSpace("productivity");
    setActiveProjectId(parent?.id ?? "");
    setActiveThreadId(refreshed.threads.find(thread => thread.projectId === parent?.id && thread.space === "productivity")?.id ?? null);
  };
  const pendingWorktreeSend = useRef<{ projectId: string; prompt: string } | null>(null);
  useEffect(() => {
    const pending = pendingWorktreeSend.current;
    if (!pending || pending.projectId !== activeProjectId || activeThreadId !== null) return;
    pendingWorktreeSend.current = null;
    void sendPrompt(pending.prompt);
  }, [activeProjectId, activeThreadId]);

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
  const moveThread = async (threadId: string, projectId: string) => {
    if (runLocks.current.has(threadId)) {
      throw new Error(tr("usecleoworkspace.wait_for_the_current_run_to_finish_before_moving"));
    }
    const refreshed = await refreshWorkspace(() => cleoClient.moveThread(threadId, projectId));
    const moved = refreshed.threads.find((thread) => thread.id === threadId);
    // Stay on the same thread; only its project (and so the sidebar group) changed.
    if (moved && activeThreadId === threadId) setActiveProjectId(moved.projectId);
    return refreshed;
  };
  const deleteThread = async (threadId: string) => {
    if (runLocks.current.has(threadId)) {
      throw new Error(tr("usecleoworkspace.a_running_thread_cannot_be_deleted_stop_it_first"));
    }
    const deleted = snapshot?.threads.find((thread) => thread.id === threadId);
    const deletedWasActive = activeThreadId === threadId;
    selectionRef.current += 1;
    const refreshed = await refreshWorkspace(() => cleoClient.deleteThread(threadId));
    setPendingSwitch(threadId, null);
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
    if (!removed) throw new Error(tr("usecleoworkspace.could_not_find_the_project_to_remove"));
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
      setModelSettingsError(error instanceof Error ? error.message : tr("usecleoworkspace.could_not_load_model_configuration"));
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
      setAgentInstructionsError(error instanceof Error ? error.message : tr("usecleoworkspace.could_not_load_chat_instructions"));
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
  const loadMemoryReviewDetails = (source: MemoryReviewSource) =>
    cleoClient.getMemoryReviewDetails(source);
  /** Re-run consolidation for a failed source through the manual review path. */
  const retryMemorySource = async (source: MemoryReviewSource) => {
    try {
      return await cleoClient.reviewMemorySource(source, "consolidate");
    } finally {
      await refreshMemory();
    }
  };

  const waitingFor = (thread: Thread) => pendingApprovals.some(request => request.threadId === thread.id) ? "approval" as const
    : questions.pending.some(request => request.threadId === thread.id) ? "question" as const : undefined;

  return {
    history,
    refreshLanguage,
    questions,
    skills: activeThread?.skills ?? (draftSkills?.key === skillKey ? draftSkills.skills : []),
    snapshot: snapshot && { ...snapshot, threads: snapshot.threads.map(thread => ({ ...thread, waitingFor: waitingFor(thread) })) },
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
    unreadThreadIds,
    markThreadRead,
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
    pendingHarnessSwitch,
    activeThreadRuntime,
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
    retargetDraft,
    selectThread,
    createThread: startNewThread,
    chooseWorkspace,
    choosingWorkspace,
    sendPrompt,
    queuedMessages: activeThreadId ? queues[activeThreadId] ?? [] : [],
    queueMessage,
    steerDraft,
    steerQueued,
    sendQueued,
    editQueued,
    removeQueued,
    editMessage,
    retrySteer,
    restoreSteer,
    steeringBusy: activeThreadId ? steeringThreads.includes(activeThreadId) : false,
    renameThread,
    cancelRun,
    resolveApproval,
    updateRuntime,
    updatePermissions,
    setDraftPermissions,
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
    runSourceControl,
    liveBranches,
    recheckBranch,
    sendInWorktree,
    creatingWorktree,
    checkoutBusy,
    removeWorktreeProject,
    resetWorkspace,
    restoreChatHistory,
    deleteThread,
    moveThread,
    removeProject,
    loadModelSettings,
    applyModelSettings,
    loadAgentInstructions,
    saveAgentInstructions,
    loadMemoryReviewDetails,
    retryMemorySource,
  };
}
