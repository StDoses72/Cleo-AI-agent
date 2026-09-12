import type {
  CleoClient,
  AgentInstructions,
  Attachment,
  ApprovalDecision,
  CreateThreadOptions,
  ModelProfileInput,
  ModelSettings,
  ModelConnectionInput,
  ModelConnectionProbe,
  SubscriptionRuntime,
  SubscriptionLogin,
  ProductivityModelCatalog,
  RuntimeCatalog,
  MemoryReviewAction,
  MemoryReviewDetails,
  MemoryReviewSource,
  RuntimeProfile,
  StreamEvent,
  Thread,
  ThreadSpace,
  TimelineItem,
  UndoChangesResult,
  WorkspaceSnapshot,
  TimelinePage,
  TimelineContent,
  QuestionRequest,
} from "../types";
import { snapshot, uiChanges } from "./mockData";

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

const clone = <T,>(value: T): T => structuredClone(value);

export class MockCleoClient implements CleoClient {
  private modelSettings: ModelSettings = {
    profiles: [
      { name: "deepseek-flash", displayName: "DeepSeek · 日常", provider: "openai", model: "deepseek-v4-flash", models: ["deepseek-v4-flash", "deepseek-reasoner"], baseUrl: "https://api.deepseek.com", maxTokens: 100000, hasApiKey: true },
      { name: "kimi", displayName: "Moonshot · 个人", provider: "openai", model: "kimi-k2.6", models: ["kimi-k2.6"], baseUrl: "https://api.moonshot.cn/v1", maxTokens: 100000, hasApiKey: true },
      { name: "chatgpt", displayName: "Codex · 个人", provider: "codex", backend: "codex", model: "gpt-5.6-sol", models: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.5"], baseUrl: null, maxTokens: 100000, hasApiKey: false },
    ],
    activeAgent: "deepseek-flash", activeDreamAgent: "", dreamEnabled: true,
  };
  private readonly approvalResolvers = new Map<string, (decision: ApprovalDecision) => void>();
  private readonly reviewingMemorySourceIds = new Set<string>();
  private readonly histories = new Map<string, TimelineItem[]>();
  private readonly runVersions = new Map<string, number>();
  private readonly questions = new Map<string, { request: QuestionRequest; resolve: (answers: Record<string, string[]> | null) => void }>();

  async loadWorkspace(): Promise<WorkspaceSnapshot> {
    await delay(520);
    const result = clone(snapshot);
    for (const thread of result.threads) {
      const { items, ...history } = await this.loadTimeline(thread.id);
      thread.items = items;
      thread.history = history;
    }
    return result;
  }

  async loadThread(threadId: string): Promise<Thread> {
    await delay(120);
    const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new Error(`Unknown thread: ${threadId}`);
    const { items, ...history } = await this.loadTimeline(threadId);
    return { ...clone(thread), items, history };
  }

  async loadTimeline(threadId: string, direction: "latest" | "before" | "after" = "latest", cursor?: string): Promise<TimelinePage> {
    await delay(30);
    const stored = this.histories.get(threadId) ?? snapshot.threads.find(t => t.id === threadId)?.items ?? [];
    let turn = "initial";
    const all = stored.map((original, index) => {
      if (original.type === "message" && original.role === "user") turn = original.id;
      return { ...original, turnId: original.turnId ?? turn, cursor: String(index), order: index };
    });
    const finalTurns = new Set(all.filter(item => item.type === "message" && item.role === "assistant" && item.content.trim()).map(item => item.turnId));
    const pivot = cursor === undefined ? all.length : Number(cursor);
    const start = direction === "latest" ? Math.max(0, all.length - 80)
      : direction === "before" ? Math.max(0, pivot - 80) : pivot + 1;
    const end = direction === "before" ? pivot : Math.min(all.length, start + 80);
    return { items: clone(all.slice(start, end).map(item => ({ ...item, turnHasAnswer: finalTurns.has(item.turnId) }))),
      total: all.length, before: String(start), after: String(end - 1), hasBefore: start > 0,
      hasAfter: end < all.length, revision: String(all.length) };
  }

  async readTimelineContent(threadId: string, itemId: string, field: string, offset: number): Promise<TimelineContent> {
    const item = (this.histories.get(threadId) ?? snapshot.threads.find(t => t.id === threadId)?.items ?? []).find(i => i.id === itemId);
    const value = item && (item as unknown as Record<string, unknown>)[field];
    if (typeof value !== "string") throw new Error("内容不可用");
    const text = value.slice(offset, offset + 16384);
    return { text, offset, next: offset + text.length, total: value.length };
  }

  async getPendingQuestions(threadId: string): Promise<QuestionRequest[]> {
    return [...this.questions.values()].filter(q => q.request.threadId === threadId).map(q => clone(q.request));
  }

  async resolveQuestion(threadId: string, questionId: string, answers: Record<string, string[]>): Promise<void> {
    const question = this.questions.get(questionId);
    if (!question || question.request.threadId !== threadId) throw new Error("问题已结束");
    question.resolve(answers);
    this.questions.delete(questionId);
  }

  async createThread(
    space: ThreadSpace,
    projectId: string,
    options: CreateThreadOptions = {},
  ): Promise<Thread> {
    await delay(180);
    const selectedProfile = options.profileId ?? this.modelSettings.activeAgent;
    const profile = this.modelSettings.profiles.find(item => item.name === selectedProfile);
    if (space === "chat" && !profile) throw new Error("模型连接不存在。");
    const created: Thread = {
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
            provider: profile!.provider,
            model: profile!.model,
            effort: "high",
            access: "workspace-write",
            approval: "Cleo 工具策略",
            editable: true,
          }
        : {
            provider: options.provider ?? "codex",
            model: options.model ?? "gpt-5.6-sol",
            effort: options.effort ?? "medium",
            access: "workspace-write",
            approval: "user",
            editable: true,
          },
    };
    snapshot.threads.unshift(clone(created));
    this.histories.set(created.id, []);
    const { items, ...history } = await this.loadTimeline(created.id);
    return { ...created, items, history };
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

  async addProject(space: ThreadSpace, projectPath: string): Promise<WorkspaceSnapshot> {
    const name = projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace";
    const id = `${space}:${name}`;
    const existing = snapshot.projects.find((project) => project.id === id);
    if (existing) {
      existing.path = projectPath;
    } else {
      snapshot.projects.push({
        id,
        space,
        name,
        path: projectPath,
        accent: "#75c9d6",
        removable: true,
      });
    }
    return clone(snapshot);
  }

  async removeProject(projectId: string): Promise<WorkspaceSnapshot> {
    const index = snapshot.projects.findIndex((project) => project.id === projectId);
    if (index >= 0) snapshot.projects.splice(index, 1);
    snapshot.threads = snapshot.threads.filter((thread) => thread.projectId !== projectId);
    return clone(snapshot);
  }

  async restoreChatBackups(): Promise<WorkspaceSnapshot> {
    await delay(180);
    return clone(snapshot);
  }

  async *streamTurn(threadId: string, prompt: string, attachments: Attachment[] = []): AsyncGenerator<StreamEvent> {
    const version = (this.runVersions.get(threadId) ?? 0) + 1;
    this.runVersions.set(threadId, version);
    const turnId = `mock-turn-${Date.now()}`;
    const items = this.histories.get(threadId) ?? clone(snapshot.threads.find(t => t.id === threadId)?.items ?? []);
    this.histories.set(threadId, items);
    const user: TimelineItem = { id: turnId, turnId, cursor: String(items.length), order: items.length, type: "message", role: "user", content: prompt, time: "" };
    items.push(user);
    yield { type: "turn-started", item: user };
    if (/提问测试|question demo/i.test(prompt)) {
      const request: QuestionRequest = { id: `question-${turnId}`, threadId, provider: "claude", status: "pending", questions: [
        { id: "choice", header: "方向", question: "希望如何实现？", multiple: false, options: [{ label: "最小改动", description: "保留现有流程" }, { label: "重新设计", description: "调整交互方式" }] },
        { id: "sections", header: "范围", question: "需要哪些部分？", multiple: true, options: [{ label: "前端", description: "用户界面" }, { label: "后端", description: "运行服务" }] },
        { id: "text", header: "说明", question: "还有哪些补充要求？", multiple: false, options: [] },
      ] };
      const answer = new Promise<Record<string, string[]> | null>(resolve => this.questions.set(request.id, { request, resolve }));
      const questionItem: TimelineItem = { id: request.id, turnId, type: "question", request };
      items.push(questionItem);
      yield { type: "question-request", request: clone(request) };
      const answers = await answer;
      questionItem.request = { ...request, status: answers ? "answered" : "cancelled", answers: answers ?? undefined };
      yield { type: "question-resolved", request: clone(questionItem.request) };
      if (!answers) return;
    }
    for await (const event of this.mockTurn(threadId, prompt, attachments)) {
      if (this.runVersions.get(threadId) !== version) return;
      if (event.type === "upsert-item") {
        event.item = { ...event.item, turnId };
        const at = items.findIndex(i => i.id === event.item.id);
        event.item.cursor = String(at >= 0 ? at : items.length);
        event.item.order = at >= 0 ? at : items.length;
        if (at >= 0) items[at] = clone(event.item); else items.push(clone(event.item));
      } else if (event.type === "error") {
        items.push({ id: `${turnId}:error`, turnId, type: "notice", tone: "warning", title: "任务已暂停", detail: event.message });
      }
      yield event;
    }
  }

  private async *mockTurn(
    threadId: string,
    prompt: string,
    _attachments: Attachment[] = [],
  ): AsyncGenerator<StreamEvent> {
    const runId = `${threadId}-${Date.now()}`;
    const isFailureDemo = /失败|error|fail/i.test(prompt);
    const needsApproval = /审批|approval|git commit/i.test(prompt);
    const browserApproval = /browser approval/i.test(prompt);

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

    if (needsApproval) {
      const approvalId = `${runId}-approval`;
      yield {
        type: "approval-request",
        request: {
          id: approvalId,
          kind: browserApproval ? "elicitation" : "command",
          method: browserApproval ? "mcpServer/elicitation/request" : "item/commandExecution/requestApproval",
          threadId,
          turnId: runId,
          itemId: `${runId}-tool`,
          command: browserApproval ? "cua_repl" : "git add README.md && git commit -m \"Document agent tool and model\"",
          cwd: "D:\\Projects\\Cleo-AI-agent",
          reason: browserApproval ? "Allow Browser use to access http://localhost:5173?" : "This command writes protected Git metadata on the current branch.",
          availableDecisions: browserApproval ? ["accept", "decline", "cancel"] : ["accept", "acceptForSession", "decline", "cancel"],
          mode: browserApproval ? "form" : undefined,
          commandActions: [],
          permissions: null,
          grantRoot: null,
          startedAtMs: Date.now(),
        },
      };
      const decision = await new Promise<ApprovalDecision>((resolve) => {
        this.approvalResolvers.set(approvalId, resolve);
      });
      this.approvalResolvers.delete(approvalId);
      yield { type: "approval-resolved", response: { id: approvalId, decision } };
      if (decision === "decline" || decision === "cancel") {
        yield {
          type: "upsert-item",
          item: {
            id: `${runId}-denied`,
            type: "notice",
            tone: "info",
            title: decision === "cancel" ? "请求已取消" : "命令已拒绝",
            detail: "Cleo 已收到你的决定，并停止了这次命令执行。",
          },
        };
        yield { type: "done", summary: "命令已由用户拒绝" };
        return;
      }
    }

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

    await delay(260);
    const responseId = `${runId}-assistant`;
    yield {
      type: "upsert-item",
      item: {
        id: `${runId}-progress`,
        type: "thought",
        status: "running",
        content: "## 正在整理\n\n已完成第一轮检查，正在整理最后的验证结果。",
      },
    };

    await delay(260);
    yield {
      type: "upsert-item",
      item: {
        id: `${runId}-verify-tool`,
        type: "tool",
        name: "verify",
        command: "npm run build && npm run smoke",
        status: "running",
      },
    };

    await delay(900);
    yield {
      type: "upsert-item",
      item: {
        id: `${runId}-verify-tool`,
        type: "tool",
        name: "verify",
        command: "npm run build && npm run smoke",
        status: "done",
        output: "build passed · smoke passed",
      },
    };
    yield {
      type: "upsert-item",
      item: {
        id: `${runId}-summary-tool`,
        type: "tool",
        name: "summary",
        command: "git diff --stat",
        status: "done",
        output: "3 files changed",
      },
    };

    await delay(680);
    yield { type: "changes", changes: clone(uiChanges.slice(0, 2)) };
    yield {
      type: "usage",
      usage: { used: 12480, limit: 128000, input: 2840, output: 1910 },
    };

    await delay(540);
    yield {
      type: "upsert-item",
      item: {
        id: `${runId}-plan`,
        type: "plan",
        title: "执行计划",
        steps: [
          { label: "确认目标与改动边界", status: "done" },
          { label: "检查相关文件与调用关系", status: "done" },
          { label: "实现并验证最小改动", status: "done" },
        ],
      },
    };
    const response: TimelineItem = {
      id: responseId,
      type: "message",
      role: "assistant",
      content:
        "## 运行完成\n\n这个体验流程已经由 **mock runtime** 完成：\n\n- Markdown 已按结构渲染\n- 多次工具调用已归入一个折叠过程\n- 最新流式正文保持在操作记录下方\n\n真实后端接入后，这些事件会保持同一结构从 `IPC bridge` 流入，所以界面不需要重写。查看 [渲染说明](https://example.com/cleo-markdown)，或打开本地的 [项目入口](D:/Projects/cleo-lab/index.html:82)。",
      time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    };
    yield { type: "upsert-item", item: response };
    yield { type: "done", summary: prompt.slice(0, 54) };
  }

  async cancelRun(_threadId: string): Promise<void> {
    this.runVersions.set(_threadId, (this.runVersions.get(_threadId) ?? 0) + 1);
    await delay(250);
    for (const resolve of this.approvalResolvers.values()) resolve("cancel");
    this.approvalResolvers.clear();
    this.histories.get(_threadId)?.push({ id: `cancel-${Date.now()}`, type: "notice", tone: "info", title: "已停止当前运行", detail: "可以继续发送新请求。" });
    for (const [id, question] of this.questions) {
      if (question.request.threadId === _threadId) { question.resolve(null); this.questions.delete(id); }
    }
  }

  async resolveApproval(
    _threadId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const resolve = this.approvalResolvers.get(approvalId);
    if (!resolve) throw new Error("This approval request is no longer pending.");
    resolve(decision);
  }

  async updateRuntime(
    _threadId: string,
    update: Partial<RuntimeProfile>,
  ): Promise<RuntimeProfile> {
    return { ...snapshot.runtime, ...update };
  }

  async pickAttachments(): Promise<Attachment[]> {
    return [];
  }

  async prepareAttachments(files: File[]): Promise<Attachment[]> {
    return files.map((file, index) => ({
      name: file.name,
      path: `mock-attachment://${index}/${encodeURIComponent(file.name)}`,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
    }));
  }

  async pickWorkspace(): Promise<string | null> {
    return null;
  }

  async copyText(value: string): Promise<void> {
    await navigator.clipboard?.writeText(value);
  }

  async revealPath(_value: string): Promise<void> {}

  async openLocalPath(_href: string, _workspacePath: string): Promise<void> {}

  async getConfigTemplates(): Promise<{ cleo: string; harnesses: string }> {
    return { cleo: "{}", harnesses: "{}" };
  }

  async getAgentInstructions(): Promise<AgentInstructions> {
    return {
      path: "C:\\Users\\demo\\AppData\\Local\\Cleo\\AGENTS.md",
      content: "# Cleo Agent Instructions\n\n- Prefer concise answers.\n",
      exists: true,
    };
  }

  async getModelSettings(): Promise<ModelSettings> {
    return clone(this.modelSettings);
  }

  async getRuntimeCatalog(): Promise<RuntimeCatalog> {
    await delay(120);
    return {
      nonProductivityProfiles: this.modelSettings.profiles.map(p => ({ id: p.name, provider: p.provider, model: p.model, maxTokens: p.maxTokens, active: p.name === this.modelSettings.activeAgent })),
      productivityProviders: [
        { id: "codex", type: "codex_sdk", defaultModel: "gpt-5.6-sol", modelSource: "dynamic" },
        { id: "claude", type: "claude_sdk", defaultModel: "claude-opus-5", modelSource: "dynamic" },
      ],
      defaultNonProductivityProfile: this.modelSettings.activeAgent,
      defaultProductivityProvider: "codex",
    };
  }

  async getProductivityModels(provider: string): Promise<ProductivityModelCatalog> {
    await delay(260);
    return provider === "claude"
      ? {
          provider,
          source: "sdk",
          models: [
            { id: "claude-opus-5", label: "Claude Opus 5", description: "Configured model", isDefault: true, defaultEffort: "high", supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
            { id: "claude-sonnet-demo", label: "Claude Sonnet (demo)", description: "Mock harness choice", isDefault: false, defaultEffort: null, supportedEfforts: [] },
          ],
        }
      : {
          provider,
          source: "sdk",
          models: [
            { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", description: "Frontier coding model", isDefault: true, defaultEffort: "low", supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
            { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", description: "Balanced coding model", isDefault: false, defaultEffort: "medium", supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
          ],
        };
  }

  async saveModelProfile(profile: ModelProfileInput): Promise<ModelSettings> {
    const existing = this.modelSettings.profiles.find(p => p.name === profile.name);
    const saved = { name: profile.name, displayName: profile.displayName || existing?.displayName, models: profile.models || existing?.models, provider: profile.provider, model: profile.model, baseUrl: profile.baseUrl || null, maxTokens: profile.maxTokens, hasApiKey: !profile.backend || profile.backend === "api", backend: profile.backend || "api", executable: profile.executable };
    this.modelSettings.profiles = [...this.modelSettings.profiles.filter((item) => item.name !== profile.name), saved];
    if (profile.activateAgent) this.modelSettings.activeAgent = profile.name;
    if (profile.activateDreamAgent) { this.modelSettings.activeDreamAgent = profile.name; this.modelSettings.activeDreamModel = profile.model; this.modelSettings.dreamEnabled = true; }
    return this.getModelSettings();
  }

  async saveDreamSettings(selection: string, model?: string): Promise<ModelSettings> {
    this.modelSettings.activeDreamAgent = ["mode:follow", "mode:disabled"].includes(selection) ? "" : selection;
    this.modelSettings.dreamEnabled = selection !== "mode:disabled";
    this.modelSettings.activeDreamModel = this.modelSettings.activeDreamAgent ? model || this.modelSettings.profiles.find(p => p.name === selection)?.model : "";
    return this.getModelSettings();
  }
  async checkModelConnection(connection: Partial<ModelConnectionInput> & { profileId?: string }): Promise<ModelConnectionProbe> {
    await delay(350);
    const stored = this.modelSettings.profiles.find(p => p.name === connection.profileId);
    if (stored) return { status: "connected", models: stored.models || [stored.model] };
    if (connection.profileId) throw new Error("模型连接不存在。");
    if (connection.backend === "api" && !connection.apiKey) throw new Error("请输入 API Key。");
    return { status: "connected", models: connection.provider === "anthropic" ? ["claude-sonnet", "claude-opus"] : ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.5"] };
  }
  async createModelConnection(connection: ModelConnectionInput): Promise<ModelSettings> {
    if (!connection.models.length) throw new Error("请至少选择一个模型。");
    if (this.modelSettings.profiles.some(p => (p.displayName || p.name) === connection.displayName)) throw new Error("这个连接名称已被使用。");
    this.modelSettings.profiles.push({ name: `connection_${Date.now()}`, displayName: connection.displayName, provider: connection.provider, backend: connection.backend, model: connection.models[0], models: connection.models, baseUrl: connection.baseUrl || null, executable: connection.executable, maxTokens: 100000, hasApiKey: connection.backend === "api" });
    return this.getModelSettings();
  }
  async selectChatModel(profileId: string, model: string): Promise<ModelSettings> {
    const profile = this.modelSettings.profiles.find(p => p.name === profileId);
    if (!profile || ![profile.model, ...(profile.models || [])].includes(model)) throw new Error("模型不属于所选连接。");
    if (this.modelSettings.activeDreamAgent === profileId && !this.modelSettings.activeDreamModel) this.modelSettings.activeDreamModel = profile.model;
    profile.models = [...new Set([profile.model, ...(profile.models || [])])];
    profile.model = model;
    this.modelSettings.activeAgent = profileId;
    return this.getModelSettings();
  }
  async renameModelConnection(profileId: string, label: string): Promise<ModelSettings> {
    const profile = this.modelSettings.profiles.find(p => p.name === profileId);
    if (!profile || !label.trim()) throw new Error("请填写连接名称。");
    profile.displayName = label.trim();
    return this.getModelSettings();
  }
  async removeModelConnection(profileId: string): Promise<ModelSettings> {
    if ([this.modelSettings.activeAgent, this.modelSettings.activeDreamAgent].includes(profileId)) throw new Error("这个连接正在被使用。切换所用模型后，才可移除。");
    this.modelSettings.profiles = this.modelSettings.profiles.filter(p => p.name !== profileId);
    return this.getModelSettings();
  }
  async getSubscriptionCatalog(): Promise<SubscriptionRuntime[]> {
    return ["codex", "gemini", "copilot", "grok", "claude_code"].map((backend) => ({ backend, label: backend, login: `${backend} login`, docs: "https://example.com" }));
  }
  async checkSubscription(_profile: ModelProfileInput): Promise<{ status: string; models: string[] }> {
    return { status: "connected", models: ["demo-model"] };
  }
  async startSubscriptionLogin(_profile: ModelProfileInput): Promise<SubscriptionLogin> {
    return { id: "demo", status: "completed", output: "演示登录", url: null };
  }
  async readSubscriptionLogin(_loginId: string): Promise<SubscriptionLogin> {
    return { id: "demo", status: "completed", output: "演示登录", url: null };
  }
  async cancelSubscriptionLogin(_loginId: string): Promise<SubscriptionLogin> {
    return { id: "demo", status: "cancelled", output: "", url: null };
  }

  async saveAgentInstructions(content: string): Promise<AgentInstructions> {
    return {
      path: "C:\\Users\\demo\\AppData\\Local\\Cleo\\AGENTS.md",
      content,
      exists: true,
    };
  }

  async getMemoryReviewDetails(source: MemoryReviewSource): Promise<MemoryReviewDetails> {
    await delay(240);
    if (this.reviewingMemorySourceIds.has(source.id)) {
      throw new Error("待确认的记忆来源不存在或已被处理");
    }
    return {
      id: source.id,
      source_version: source.source_version,
      event_count: 3,
      events: [
        {
          id: "mock-user",
          type: "human",
          content: "记住这个项目使用 local-first 的运行方式。",
          created_at: source.updated_at,
          metadata: {},
        },
        {
          id: "mock-assistant",
          type: "ai",
          content: "已确认，配置、会话和记忆都保存在本地目录。",
          created_at: source.updated_at,
          metadata: {},
        },
        {
          id: "mock-tool",
          type: "tool_event",
          content: null,
          created_at: source.updated_at,
          metadata: { name: "read_file", status: "success", result_omitted: true },
        },
      ],
      omitted_events: [
        {
          id: "mock-session-created",
          seq: 1,
          type: "session_created",
          actor: "system",
          created_at: source.updated_at,
        },
      ],
    };
  }

  async reviewMemorySource(
    source: MemoryReviewSource,
    _action: MemoryReviewAction,
  ): Promise<WorkspaceSnapshot> {
    if (this.reviewingMemorySourceIds.has(source.id)) {
      throw new Error("这个记忆来源已被处理，请刷新后重试");
    }
    this.reviewingMemorySourceIds.add(source.id);
    try {
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
    } finally {
      this.reviewingMemorySourceIds.delete(source.id);
    }
  }

  async undoChanges(threadId: string): Promise<UndoChangesResult> {
    await delay(220);
    const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
    if (!thread || thread.space !== "productivity") {
      throw new Error("只有开发任务可以回退 Git 改动。");
    }
    const restoredFiles = thread.changes.length;
    thread.changes = [];
    const project = snapshot.projects.find((candidate) => candidate.id === thread.projectId);
    if (project) project.dirtyFiles = 0;
    return { restoredFiles, workspace: clone(snapshot) };
  }

  async resetWorkspace(): Promise<void> {}
}
