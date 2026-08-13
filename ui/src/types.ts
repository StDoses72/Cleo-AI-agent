export type WorkspaceSpace = "chat" | "productivity" | "memory";
export type ThreadSpace = Exclude<WorkspaceSpace, "memory">;
export type ThreadStatus = "idle" | "running" | "completed" | "attention";

export interface Project {
  id: string;
  space?: ThreadSpace;
  name: string;
  path: string;
  branch?: string;
  dirtyFiles?: number;
  accent: string;
}

export interface PlanStep {
  label: string;
  status: "pending" | "running" | "done";
}

export type TimelineItem =
  | {
      id: string;
      type: "message";
      role: "user" | "assistant";
      content: string;
      time: string;
    }
  | {
      id: string;
      type: "thought";
      content: string;
      status: "running" | "done";
    }
  | {
      id: string;
      type: "plan";
      title: string;
      steps: PlanStep[];
    }
  | {
      id: string;
      type: "tool";
      name: string;
      command: string;
      status: "running" | "done" | "error";
      output?: string;
    }
  | {
      id: string;
      type: "notice";
      tone: "info" | "success" | "warning";
      title: string;
      detail: string;
    };

export interface ChangeFile {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  diff: string;
}

export interface Usage {
  used: number;
  limit: number;
  input: number;
  output: number;
}

export interface Thread {
  id: string;
  space: ThreadSpace;
  projectId: string;
  title: string;
  summary: string;
  updatedAt: string;
  status: ThreadStatus;
  items: TimelineItem[];
  changes: ChangeFile[];
  usage: Usage;
  runtime?: RuntimeProfile;
  terminal?: string[];
}

export interface Attachment {
  name: string;
  path: string;
  mimeType: string;
  base64: string;
}

export interface MemoryEntry {
  id: string;
  scope: "persona" | "project" | "preference";
  title: string;
  content: string;
  source: string;
  updatedAt: string;
}

export interface RuntimeProfile {
  profileId?: string;
  provider: string;
  model: string;
  models?: string[];
  effort: "低" | "中" | "高";
  access: string;
  approval: string;
  contextWindow?: number;
  editable?: boolean;
}

export interface RuntimeModelOption {
  id: string;
  label: string;
  description: string;
  isDefault: boolean;
  defaultEffort: string | null;
  supportedEfforts: string[];
}

export interface NonProductivityProfileOption {
  id: string;
  provider: string;
  model: string;
  maxTokens: number;
  active: boolean;
}

export type ProductivityProviderType = "codex_sdk" | "claude_sdk" | "acp";

export interface ProductivityProviderOption {
  id: string;
  type: ProductivityProviderType;
  defaultModel: string | null;
  modelSource: "dynamic" | "config";
}

export interface RuntimeCatalog {
  nonProductivityProfiles: NonProductivityProfileOption[];
  productivityProviders: ProductivityProviderOption[];
  defaultNonProductivityProfile: string;
  defaultProductivityProvider: string;
}

export interface ProductivityModelCatalog {
  provider: string;
  source: "sdk" | "acp" | "config";
  models: RuntimeModelOption[];
}

export interface CreateThreadOptions {
  projectPath?: string;
  provider?: string;
  model?: string;
  profileId?: string;
}

export interface ModelProfileSummary {
  name: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  maxTokens: number;
  hasApiKey: boolean;
}

export interface ModelSettings {
  profiles: ModelProfileSummary[];
  activeAgent: string;
  activeDreamAgent: string;
}

export interface ModelProfileInput {
  name: string;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxTokens: number;
  activateAgent: boolean;
  activateDreamAgent: boolean;
}

export interface MemoryOverviewEntry {
  id: string;
  scope: "project" | "persona";
  space: "non_productivity" | "productivity" | null;
  project: string | null;
  category: string;
  title: string;
  content: string;
  confidence: number;
  importance: number;
  tags: string[];
  evidence: MemoryEvidence[];
  evidence_count: number;
  updated_at: string;
}

export interface MemoryEvidence {
  space: "non_productivity" | "productivity";
  project: string;
  session_id: string;
  event_id: string;
  observed_at: string;
}

export interface MemoryProjectSummary {
  space: "non_productivity" | "productivity";
  project: string;
  memory_count: number;
  updated_at: string;
}

export interface MemoryReviewSource {
  id: string;
  space: "non_productivity" | "productivity";
  project: string;
  session_id: string;
  status: "pending" | "failed";
  source_version: number;
  last_event_seq: number;
  failure_count: number;
  last_error: string | null;
  updated_at: string;
}

export type MemoryViewMode = "all" | "projects" | "pending";
export type MemoryReviewAction = "consolidate" | "skip";

export interface MemoryOverview {
  schema_version: 1;
  summary: {
    active_memories: number;
    project_memories: number;
    project_scopes: number;
    persona_traits: number;
    pending_sources: number;
  };
  gate: {
    enabled: boolean;
    provider: "sentence-transformers";
    model: string;
    configuration_key: "memory_gate.model";
    local_files_only: boolean;
    minimum_similarity: number;
    run_margin: number;
    skip_margin: number;
  };
  dream_agent: {
    status: "idle" | "running" | "attention";
    last_processed_at: string | null;
    pending_count: number;
    running_count: number;
    failed_count: number;
  };
  project_summaries: MemoryProjectSummary[];
  review_sources: MemoryReviewSource[];
  entries: MemoryOverviewEntry[];
}

export interface WorkspaceSnapshot {
  projects: Project[];
  threads: Thread[];
  memories: MemoryEntry[];
  memoryOverview: MemoryOverview;
  runtime: RuntimeProfile;
  activeThreadId?: string | null;
  activeSpace?: ThreadSpace;
  backend?: {
    connected: boolean;
    mode: "local" | "mock";
    commands: Record<ThreadSpace, string[]>;
    recoverableChatBackups?: number;
  };
}

export type StreamEvent =
  | { type: "upsert-item"; item: TimelineItem }
  | { type: "changes"; changes: ChangeFile[] }
  | { type: "usage"; usage: Usage }
  | { type: "terminal"; chunk: string }
  | { type: "refresh"; activeThreadId: string; space: ThreadSpace }
  | { type: "navigate-space"; space: ThreadSpace }
  | { type: "request-attachment" }
  | { type: "done"; summary: string }
  | { type: "error"; message: string };

export interface CleoClient {
  loadWorkspace(): Promise<WorkspaceSnapshot>;
  loadThread(threadId: string): Promise<Thread>;
  createThread(space: ThreadSpace, projectId: string, options?: CreateThreadOptions): Promise<Thread>;
  restoreChatBackups(): Promise<WorkspaceSnapshot>;
  streamTurn(threadId: string, prompt: string, attachments?: Attachment[]): AsyncGenerator<StreamEvent>;
  cancelRun(threadId: string): Promise<void>;
  updateRuntime(threadId: string, update: Partial<RuntimeProfile>): Promise<RuntimeProfile>;
  pickAttachments(): Promise<Attachment[]>;
  pickWorkspace(): Promise<string | null>;
  copyText(value: string): Promise<void>;
  revealPath(value: string): Promise<void>;
  getConfigTemplates(): Promise<{ cleo: string; harnesses: string }>;
  getModelSettings(): Promise<ModelSettings>;
  getRuntimeCatalog(): Promise<RuntimeCatalog>;
  getProductivityModels(provider: string, projectPath?: string): Promise<ProductivityModelCatalog>;
  saveModelProfile(profile: ModelProfileInput): Promise<ModelSettings>;
  reviewMemorySource(
    source: MemoryReviewSource,
    action: MemoryReviewAction,
  ): Promise<WorkspaceSnapshot>;
  resetWorkspace(): Promise<void>;
}
