import type { ReasoningEffort, RuntimeCatalog, RuntimeProfile } from "./types";

/** A harness and model picked for an existing task that has not been handed off yet. */
export interface PendingHarnessSwitch {
  provider: string;
  model: string;
  effort: ReasoningEffort | null;
  serviceTier?: "default" | "fast";
}

/** Purpose: Decide what a pick in the runtime menu leaves pending for an existing task.
 * Input: the task's live runtime and the pick (with the model's default effort).
 * Output: the pick, to be handed off with the task's next message; or null when the pick is
 * the live harness and model, which cancels any pending handoff instead.
 */
export function nextPendingSwitch(
  live: Pick<RuntimeProfile, "provider" | "model"> | undefined,
  pick: PendingHarnessSwitch,
): PendingHarnessSwitch | null {
  if (live && live.provider === pick.provider && live.model === pick.model) return null;
  return pick;
}

/** Purpose: Show a pending pick in the pill and card while the task still runs on its live harness.
 * Input: the live runtime, the pending pick and the catalog (for the picked harness's abilities).
 * Output: the runtime as it will read after the handoff; the live runtime when nothing is pending.
 */
export function runtimeWithPendingSwitch(
  runtime: RuntimeProfile,
  pending: PendingHarnessSwitch | null | undefined,
  catalog: RuntimeCatalog | null,
): RuntimeProfile {
  if (!pending) return runtime;
  const provider = catalog?.productivityProviders.find((candidate) => candidate.id === pending.provider);
  const supportsFastMode = provider?.type === "codex_sdk";
  const serviceTier = pending.serviceTier
    ?? (runtime.provider === pending.provider ? runtime.serviceTier : null) ?? "default";
  return {
    ...runtime,
    provider: pending.provider,
    model: pending.model,
    effort: pending.effort,
    supportsFastMode,
    serviceTier: supportsFastMode ? serviceTier : null,
    permissionOptions: provider?.permissionOptions ?? runtime.permissionOptions,
  };
}
