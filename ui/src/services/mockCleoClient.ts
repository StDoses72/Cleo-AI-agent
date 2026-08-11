import type {
  CleoClient,
  Attachment,
  ModelProfileInput,
  ModelSettings,
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

  async createThread(space: ThreadSpace, projectId: string, _projectPath?: string): Promise<Thread> {
    await delay(180);
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
    };
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
