export interface EvolutionBuild {
  id: string;
  kind: "official" | "local";
  version: string | null;
  baseTag: string | null;
  baseline?: boolean;
  createdAt: string;
  name?: string;
  savedAt?: string;
  sourceHash?: string;
}

export interface EvolutionValidation {
  status: "pending" | "running" | "passed" | "failed" | "interrupted" | "unchanged";
  stage?: string;
  sourceHash?: string | null;
  candidate?: string;
  message: string;
  details?: string;
  repairable?: boolean;
}

export interface EvolutionGithubAuth {
  status: "starting" | "waiting" | "connected" | "failed" | "cancelled";
  message: string;
  code?: string;
  browserError?: string | null;
}

export interface EvolutionPullRequest {
  url: string; state: string; merged: boolean; number?: number; title?: string;
  headRefName?: string; owner?: string; submittedAt?: string; outcome?: "created" | "updated";
  submissionId?: string; sourceHash?: string;
  checks?: "failed" | "pending" | "passed" | "none"; mergeable?: string; checkedAt?: string;
}

export interface EvolutionState {
  acceptanceRequests?: EvolutionRequest[];
  acceptance?: EvolutionAcceptanceState;
  phase: string;
  supported: boolean;
  prepared: boolean;
  currentVersion: string;
  active: string | null;
  baseline: string | null;
  baseTag: string | null;
  candidate?: string | null;
  draftDirty?: boolean;
  lastRestartError?: string | null;
  selectedBase?: string | null;
  workspaceBase?: string | null;
  latestSaved?: string | null;
  cleanupPending?: string[];
  iteration?: { base: string; startedAt: string } | null;
  source: string | null;
  threadId: string | null;
  error: string | null;
  logs: string;
  validation?: EvolutionValidation | null;
  githubAuth?: EvolutionGithubAuth | null;
  submission?: { status: "running" | "success" | "failed"; message: string; url?: string } | null;
  builds: EvolutionBuild[];
  lastApplication?: { from: string | null; backup: string };
  transaction?: { phase: string } | null;
  pullRequest: EvolutionPullRequest | null;
  pullRequests?: EvolutionPullRequest[];
  releases: { tag: string; title: string; publishedAt: string; url: string }[];
  recoveryPath: string | null;
}

export interface EvolutionRequest {
  id: string;
  threadId: string;
  prompt: string;
  status: "analyzing" | "failed" | "clarification" | "answered" | "freezing" | "frozen";
  createdAt: string;
  answer?: string;
  error?: string;
  interrupted?: boolean;
  reason?: string;
  replaces?: string;
  parent?: string;
  repair?: boolean;
  execution?: { status: "submitted" | "completed" | "interrupted" };
  cases: { requirement: string; current: string; trigger: string; sourceEvidence?: string; item: EvolutionCase }[];
}

export interface EvolutionCase {
  id: string;
  title: string;
  expectation: string;
  evidence: string;
  sourceThread: string;
  kind: "manual" | "dream-format";
  baseline: string;
  enabled: boolean;
  createdAt: string;
}
export interface BehaviorResult {
  status: "manual" | "passed" | "failed" | "error";
  detail: string;
  manual?: boolean;
}
export interface EvolutionAcceptanceState {
  cases: EvolutionCase[];
  fresh: boolean;
  report: { candidate: string; sourceHash: string; createdAt: string;
    results: { id: string; before: BehaviorResult; after: BehaviorResult }[] } | null;
}
