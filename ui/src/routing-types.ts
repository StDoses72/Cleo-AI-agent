export interface RoutingCandidate {
  id: string;
  provider: string;
  connection?: string;
  backend: string;
  model: string;
  effort: string | null;
  enabled: boolean;
  tier: "economy" | "balanced" | "strong";
  available: boolean | null;
  costType: "api" | "subscription" | "unknown";
  checkedAt: string | null;
  statusReason: string | null;
  availabilitySource?: string;
  benchmarkMatch: string;
  referenceGrade?: "exact" | "family" | "unmatched";
  referenceRecords?: BenchmarkRecord[];
  benchmarkVersion: string | null;
  modelVersion?: string | null;
  benchmarkRecordId?: string | null;
}

export interface EvaluatorSettings {
  mode: "default" | "main" | "independent";
  profile_id: string | null;
  model: string | null;
  timeout_seconds: number;
}

export interface BenchmarkConnectionUpdate {
  revision: string;
  access: "free" | "pro";
  cacheTtlSeconds: number;
  apiKey?: string;
  clearKey?: boolean;
}

export interface BenchmarkRecord {
  id: string; name: string; slug: string; family: "model" | "coding_agent";
  effort: string | null; version: string | null;
  scores: Record<string, number | null>;
  input_usd_per_million: number | null; output_usd_per_million: number | null;
  output_tokens_per_second: number | null; latency_seconds: number | null;
}

export interface RoutingSettings {
  revision: string;
  enabled: boolean;
  strategy?: "rules" | "evaluator";
  feedbackEnabled?: boolean;
  taskTrackingEnabled?: boolean;
  feedbackMinSamples?: number;
  feedbackWeightCap?: number;
  defaultMode?: "manual" | "auto";
  permissionPreset?: "inherit" | "ask" | "review" | "full";
  evaluator?: EvaluatorSettings;
  evaluatorDefault?: { id: string; label: string; backend: string; model: string } | null;
  evaluatorConnections?: { id: string; label: string; backend: string; models: string[] }[];
  preference: "quality" | "cost" | "latency";
  fallbackCandidate: string | null;
  automaticUpgrade: boolean;
  crossBackendDelegation: boolean;
  candidates: RoutingCandidate[];
  benchmark: {
    source: string | null;
    retrievedAt: string | null;
    stale: boolean;
    error: string | null;
    recordCount: number;
    keyConfigured: boolean;
    access?: "free" | "pro";
    cacheTtlSeconds?: number;
    records?: BenchmarkRecord[];
  };
  recentTasks: { id: string; candidate: string | null; status: string; acceptance: string; createdAt: string | null; taskType?: string; reasons?: string[]; feedback?: { outcome: string; attribution: string; revision: number } | null }[];
}

export interface RoutingFeedback {
  task_id: string; outcome: "passed" | "failed" | "requirements_changed" | "unknown" | "retracted";
  attribution: "executor" | "selection" | "decomposition" | "handoff" | "environment" | "requirements" | "unknown";
  revision?: number;
}

export type RoutingSettingsUpdate = Pick<RoutingSettings, "revision" | "enabled" | "preference" | "fallbackCandidate"> & {
  defaultMode?: "manual" | "auto";
  permissionPreset?: RoutingSettings["permissionPreset"];
  strategy?: "rules" | "evaluator";
  feedbackEnabled?: boolean;
  taskTrackingEnabled?: boolean;
  evaluator?: EvaluatorSettings;
  candidates: Pick<RoutingCandidate, "id" | "enabled" | "tier" | "modelVersion" | "benchmarkRecordId">[];
};
