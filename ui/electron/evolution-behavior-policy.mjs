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
  })) throw new Error("自动行为回归尚未通过，请检查当前构建的比较结果。");
}

/** Purpose: Record observations only against the program actually running.
 * Input: Existing acceptance service, case ID and observation. Output: Existing-format receipt.
 */
export async function reviewApplied(acceptance, id, note) {
  const state = await acceptance.store.read();
  const status = await acceptance.status(state);
  if (!status.fresh || status.report?.candidate !== state.active) {
    throw new Error("请先应用当前构建，体验后再确认验收。");
  }
  return acceptance.review(id, note);
}
