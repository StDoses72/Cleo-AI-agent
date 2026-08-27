import type {
  Attachment,
  AgentInstructions,
  CleoClient,
  CreateThreadOptions,
  ModelProfileInput,
  ModelSettings,
  ProductivityModelCatalog,
  RuntimeCatalog,
  MemoryReviewAction,
  MemoryReviewDetails,
  MemoryReviewSource,
  RuntimeProfile,
  StreamEvent,
  Thread,
  ThreadSpace,
  WorkspaceSnapshot,
} from "../types";

export class IpcCleoClient implements CleoClient {
  private readonly bridge = window.cleoDesktop!;

  async loadWorkspace(): Promise<WorkspaceSnapshot> {
    return this.bridge.request("load_workspace");
  }

  async loadThread(threadId: string): Promise<Thread> {
    return this.bridge.request("load_thread", { thread_id: threadId });
  }

  async createThread(
    space: ThreadSpace,
    projectId: string,
    options: CreateThreadOptions = {},
  ): Promise<Thread> {
    return this.bridge.request("create_thread", {
      space,
      project_id_value: projectId,
      project_path: options.projectPath,
      provider: options.provider,
      model: options.model,
      effort: options.effort,
      profile_id: options.profileId,
    });
  }

  async deleteThread(threadId: string): Promise<WorkspaceSnapshot> {
    return this.bridge.request("delete_thread", { thread_id: threadId });
  }

  async addProject(space: ThreadSpace, projectPath: string): Promise<WorkspaceSnapshot> {
    return this.bridge.request("add_project", { space, project_path: projectPath });
  }

  async removeProject(projectId: string): Promise<WorkspaceSnapshot> {
    return this.bridge.request("remove_project", { project_id_value: projectId });
  }

  async restoreChatBackups(): Promise<WorkspaceSnapshot> {
    return this.bridge.request("restore_chat_backups");
  }

  async *streamTurn(
    threadId: string,
    prompt: string,
    attachments: Attachment[] = [],
  ): AsyncGenerator<StreamEvent> {
    const streamId = `${threadId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const events: StreamEvent[] = [];
    let wake: (() => void) | null = null;
    let complete = false;
    let failure: unknown = null;
    const unsubscribe = this.bridge.onStreamEvent((payload) => {
      if (payload.streamId !== streamId) return;
      events.push(payload.event as StreamEvent);
      wake?.();
      wake = null;
    });
    void this.bridge
      .request(
        "stream_turn",
        { thread_id: threadId, prompt, attachments },
        streamId,
      )
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        complete = true;
        wake?.();
        wake = null;
      });

    try {
      while (!complete || events.length) {
        if (!events.length) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        yield events.shift()!;
      }
      if (failure) throw failure;
    } finally {
      unsubscribe();
    }
  }

  async cancelRun(threadId: string): Promise<void> {
    await this.bridge.request("cancel_run", { thread_id: threadId });
  }

  async updateRuntime(
    threadId: string,
    update: Partial<RuntimeProfile>,
  ): Promise<RuntimeProfile> {
    return this.bridge.request("update_runtime", { thread_id: threadId, update });
  }

  pickAttachments(): Promise<Attachment[]> {
    return this.bridge.pickAttachments();
  }

  pickWorkspace(): Promise<string | null> {
    return this.bridge.pickWorkspace();
  }

  async copyText(value: string): Promise<void> {
    await this.bridge.copyText(value);
  }

  async revealPath(value: string): Promise<void> {
    await this.bridge.revealPath(value);
  }

  async openLocalPath(href: string, workspacePath: string): Promise<void> {
    await this.bridge.openLocalPath(href, workspacePath);
  }

  getConfigTemplates(): Promise<{ cleo: string; harnesses: string }> {
    return this.bridge.request("get_config_templates");
  }

  getAgentInstructions(): Promise<AgentInstructions> {
    return this.bridge.request("get_agent_instructions");
  }

  getModelSettings(): Promise<ModelSettings> {
    return this.bridge.request("get_model_settings");
  }

  getRuntimeCatalog(): Promise<RuntimeCatalog> {
    return this.bridge.request("get_runtime_catalog");
  }

  getProductivityModels(
    provider: string,
    projectPath?: string,
  ): Promise<ProductivityModelCatalog> {
    return this.bridge.request("get_productivity_models", {
      provider,
      project_path: projectPath,
    });
  }

  saveModelProfile(profile: ModelProfileInput): Promise<ModelSettings> {
    return this.bridge.request("save_model_profile", { profile });
  }

  saveAgentInstructions(content: string): Promise<AgentInstructions> {
    return this.bridge.request("save_agent_instructions", { content });
  }

  getMemoryReviewDetails(source: MemoryReviewSource): Promise<MemoryReviewDetails> {
    return this.bridge.request("get_memory_review_details", {
      space: source.space,
      project: source.project,
      session_id: source.session_id,
    });
  }

  reviewMemorySource(
    source: MemoryReviewSource,
    action: MemoryReviewAction,
  ): Promise<WorkspaceSnapshot> {
    return this.bridge.request("review_memory_source", {
      space: source.space,
      project: source.project,
      session_id: source.session_id,
      action,
    });
  }

  async resetWorkspace(): Promise<void> {
    await this.bridge.request("reset_workspace");
  }
}
