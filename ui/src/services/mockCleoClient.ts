import type {
  CleoClient,
  Attachment,
  CreateThreadOptions,
  ModelProfileInput,
  ModelSettings,
  ProductivityModelCatalog,
  RuntimeCatalog,
  MemoryReviewAction,
  MemoryReviewSource,
  RuntimeProfile,
  StreamEvent,
  Thread,
  ThreadSpace,
  TimelineItem,
  WorkspaceSnapshot,
} from "../types";
import { snapshot, uiChanges } from "./mockData";

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

const clone = <T,>(value: T): T => structuredClone(value);

export class MockCleoClient implements CleoClient {
  async loadWorkspace(): Promise<WorkspaceSnapshot> {
    await delay(520);
    return clone(snapshot);
  }

  async loadThread(threadId: string): Promise<Thread> {
    await delay(120);
    const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new Error(`Unknown thread: ${threadId}`);
    return clone(thread);
  }

  async createThread(
    space: ThreadSpace,
    projectId: string,
    options: CreateThreadOptions = {},
  ): Promise<Thread> {
    await delay(180);
    const selectedProfile = options.profileId ?? "deepseek-flash";
    const chatModels: Record<string, string> = {
      "deepseek-flash": "deepseek-v4-flash",
      kimi: "kimi-k3",
      chatgpt: "gpt-5.4-mini",
    };
    return {
      id: `draft-${Date.now()}`,
      space,
      projectId,
      title: "新任务",
      summary: "等待第一条消息",
      updatedAt: "刚刚",
      status: "idle",
      items: [],
      changes: [],
      usage: { used: 0, limit: 128000, input: 0, output: 0 },
      runtime: space === "chat"
        ? {
            profileId: selectedProfile,
            provider: "openai",
            model: chatModels[selectedProfile] ?? selectedProfile,
            effort: "高",
            access: "workspace-write",
            approval: "Cleo 工具策略",
            editable: true,
          }
        : {
            provider: options.provider ?? "codex",
            model: options.model ?? "gpt-5.6-sol",
            effort: "高",
            access: "workspace-write",
            approval: "auto_review",
            editable: true,
          },
    };
  }

  async deleteThread(threadId: string): Promise<WorkspaceSnapshot> {
    await delay(180);
    const index = snapshot.threads.findIndex((thread) => thread.id === threadId);
    if (index >= 0) snapshot.threads.splice(index, 1);
    if (snapshot.activeThreadId === threadId) {
      snapshot.activeThreadId = snapshot.threads[index]?.id ?? snapshot.threads[index - 1]?.id ?? null;
    }
    return clone(snapshot);
  }

  async restoreChatBackups(): Promise<WorkspaceSnapshot> {
    await delay(180);
    return clone(snapshot);
  }

  async *streamTurn(
    threadId: string,
    prompt: string,
    _attachments: Attachment[] = [],
  ): AsyncGenerator<StreamEvent> {
    const runId = `${threadId}-${Date.now()}`;
    const isFailureDemo = /失败|error|fail/i.test(prompt);

    await delay(380);
    yield {
      type: "upsert-item",
      item: {
        id: `${runId}-thought`,
        type: "thought",
        content: "理解目标并检查当前工作区上下文",
        status: "running",
      },
    };

    await delay(620);
    yield {
      type: "upsert-item",
      item: {
        id: `${runId}-thought`,
        type: "thought",
        content: "已读取当前 thread、项目记忆与运行参数",
        status: "done",
      },
    };
    yield {
      type: "upsert-item",
      item: {
        id: `${runId}-plan`,
        type: "plan",
        title: "执行计划",
        steps: [
          { label: "确认目标与改动边界", status: "done" },
          { label: "检查相关文件与调用关系", status: "running" },
          { label: "实现并验证最小改动", status: "pending" },
        ],
      },
    };

    await delay(720);
    yield {
      type: "upsert-item",
      item: {
        id: `${runId}-tool`,
        type: "tool",
        name: "workspace",
        command: "rg --files && npm run typecheck",
        status: "running",
      },
    };

    await delay(760);
    if (isFailureDemo) {
      yield {
        type: "upsert-item",
        item: {
          id: `${runId}-tool`,
          type: "tool",
          name: "workspace",
          command: "npm run typecheck",
          status: "error",
          output: "模拟错误：类型检查发现一个可恢复问题",
        },
      };
      yield {
        type: "error",
        message: "这是一条可恢复的 mock 失败。修改提示后可以重新发送。",
      };
      return;
    }

    yield {
      type: "upsert-item",
      item: {
        id: `${runId}-tool`,
        type: "tool",
        name: "workspace",
        command: "rg --files && npm run typecheck",
        status: "done",
        output: "检查完成 · 0 errors · 4 files in scope",
      },
    };
    yield {
      type: "upsert-item",
      item: {
        id: `${runId}-plan`,
        type: "plan",
        title: "执行计划",
        steps: [
          { label: "确认目标与改动边界", status: "done" },
          { label: "检查相关文件与调用关系", status: "done" },
          { label: "实现并验证最小改动", status: "running" },
        ],
      },
    };

    await delay(680);
    yield { type: "changes", changes: clone(uiChanges.slice(0, 2)) };
    yield {
      type: "usage",
      usage: { used: 12480, limit: 128000, input: 2840, output: 1910 },
    };

    await delay(540);
    const response: TimelineItem = {
      id: `${runId}-assistant`,
      type: "message",
      role: "assistant",
      content:
        "这个体验流程已经由 mock runtime 完成：我读取了上下文、更新了计划、执行了工具并产生可查看的文件变更。真实后端接入后，这些事件会保持同一结构从 IPC bridge 流入，所以界面不需要重写。",
      time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    };
    yield { type: "upsert-item", item: response };
    yield { type: "done", summary: prompt.slice(0, 54) };
  }

  async cancelRun(_threadId: string): Promise<void> {}

  async updateRuntime(
    _threadId: string,
    update: Partial<RuntimeProfile>,
  ): Promise<RuntimeProfile> {
    return { ...snapshot.runtime, ...update };
  }

  async pickAttachments(): Promise<Attachment[]> {
    return [];
  }

  async pickWorkspace(): Promise<string | null> {
    return null;
  }

  async copyText(value: string): Promise<void> {
    await navigator.clipboard?.writeText(value);
  }

  async revealPath(_value: string): Promise<void> {}

  async getConfigTemplates(): Promise<{ cleo: string; harnesses: string }> {
    return { cleo: "{}", harnesses: "{}" };
  }

  async getModelSettings(): Promise<ModelSettings> {
    return {
      profiles: [{ name: "demo", provider: "openai", model: "demo-model", baseUrl: null, maxTokens: 128000, hasApiKey: true }],
      activeAgent: "demo",
      activeDreamAgent: "demo",
    };
  }

  async getRuntimeCatalog(): Promise<RuntimeCatalog> {
    await delay(120);
    return {
      nonProductivityProfiles: [
        { id: "deepseek-flash", provider: "openai", model: "deepseek-v4-flash", maxTokens: 100000, active: true },
        { id: "kimi", provider: "openai", model: "kimi-k3", maxTokens: 100000, active: false },
        { id: "chatgpt", provider: "openai", model: "gpt-5.4-mini", maxTokens: 100000, active: false },
      ],
      productivityProviders: [
        { id: "codex", type: "codex_sdk", defaultModel: "gpt-5.6-sol", modelSource: "dynamic" },
        { id: "claude", type: "claude_sdk", defaultModel: "claude-sonnet-4-5", modelSource: "config" },
      ],
      defaultNonProductivityProfile: "deepseek-flash",
      defaultProductivityProvider: "codex",
    };
  }

  async getProductivityModels(provider: string): Promise<ProductivityModelCatalog> {
    await delay(260);
    return provider === "claude"
      ? {
          provider,
          source: "config",
          models: [
            { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", description: "Configured model", isDefault: true, defaultEffort: null, supportedEfforts: [] },
          ],
        }
      : {
          provider,
          source: "sdk",
          models: [
            { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", description: "Frontier coding model", isDefault: true, defaultEffort: "medium", supportedEfforts: ["low", "medium", "high"] },
            { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", description: "Balanced coding model", isDefault: false, defaultEffort: "medium", supportedEfforts: ["low", "medium", "high"] },
          ],
        };
  }

  async saveModelProfile(profile: ModelProfileInput): Promise<ModelSettings> {
    return {
      profiles: [{ name: profile.name, provider: profile.provider, model: profile.model, baseUrl: profile.baseUrl || null, maxTokens: profile.maxTokens, hasApiKey: true }],
      activeAgent: profile.activateAgent ? profile.name : "demo",
      activeDreamAgent: profile.activateDreamAgent ? profile.name : "demo",
    };
  }

  async reviewMemorySource(
    source: MemoryReviewSource,
    _action: MemoryReviewAction,
  ): Promise<WorkspaceSnapshot> {
    await delay(520);
    snapshot.memoryOverview.review_sources = snapshot.memoryOverview.review_sources.filter(
      (candidate) => candidate.id !== source.id,
    );
    snapshot.memoryOverview.summary.pending_sources = snapshot.memoryOverview.review_sources.length;
    snapshot.memoryOverview.dream_agent.pending_count = snapshot.memoryOverview.review_sources.filter(
      (candidate) => candidate.status === "pending",
    ).length;
    snapshot.memoryOverview.dream_agent.failed_count = snapshot.memoryOverview.review_sources.filter(
      (candidate) => candidate.status === "failed",
    ).length;
    snapshot.memoryOverview.dream_agent.status = snapshot.memoryOverview.dream_agent.failed_count ? "attention" : "idle";
    snapshot.memoryOverview.dream_agent.last_processed_at = new Date().toISOString();
    return clone(snapshot);
  }

  async resetWorkspace(): Promise<void> {}
}
