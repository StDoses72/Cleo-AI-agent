import { t as tr } from "./i18n.mjs";
/** Purpose: Allow pending human observations at Apply while retaining automatic regressions.
 * Input: Existing acceptance service and target ID. Output: Read-only gate; Save keeps requirePassed.
 */
export async function requireApplicable(acceptance, id) {
  const state = await acceptance.store.read();
  const build = state.builds.find((item) => item.id === id);
  if (!build || build.kind !== "local" || (id !== state.candidate && build.savedAt)) return;
  const status = await acceptance.status(state);
  const automatic = status.cases.filter((item) => item.enabled && item.kind !== "manual");
  if (!automatic.length) return;
  if (!status.fresh || status.report.candidate !== id || automatic.some((item) => {
    const result = status.report.results.find((entry) => entry.id === item.id);
    return result?.after.status !== "passed" || result?.before.status === "error";
  })) throw new Error(tr("evolution_behavior_policy.automatic_behavior_regression_checks_have_not_passed_review_the_comparison_results_fo"));
}

/** Purpose: Record observations only against the program actually running.
 * Input: Existing acceptance service, case ID and observation. Output: Existing-format receipt.
 */
export async function reviewApplied(acceptance, id, note) {
  const state = await acceptance.store.read();
  const status = await acceptance.status(state);
  if (!status.fresh || status.report?.candidate !== state.active) {
    throw new Error(tr("evolution_acceptance.apply_the_current_build_and_try_it_before_confirming_acceptance"));
  }
  return acceptance.review(id, note);
}
