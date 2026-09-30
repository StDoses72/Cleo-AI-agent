/** Purpose: Derive the next useful evolution action and a default version name from the
 * existing version state. Pure functions; they never read or write the version registry.
 */

/** Input: version name or number. Output: the same text with its last number incremented. */
export function incrementLastNumber(text) {
  const value = String(text || "").trim();
  const match = /^(.*?)(\d+)(\D*)$/.exec(value);
  if (!match) return value ? `${value}.1` : "1";
  const [, prefix, digits, suffix] = match;
  const next = String(BigInt(digits) + 1n).padStart(digits.length, "0");
  return `${prefix}${next}${suffix}`;
}

/** Input: evolution state. Output: suggested local version name, e.g. "0.5.19" after "0.5.18". */
export function nextVersionName(state) {
  const builds = Array.isArray(state?.builds) ? state.builds : [];
  const saved = builds.filter(build => build.savedAt)
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  const latest = saved.find(build => build.id === state?.latestSaved) || saved[0];
  const named = [latest, ...saved].map(build => build?.name).find(name => /\d/.test(name || ""));
  const active = builds.find(build => build.id === state?.active);
  const base = builds.find(build => build.id === state?.iteration?.base);
  const release = [base?.version, active?.version, state?.currentVersion]
    .find(version => /\d/.test(version || ""));
  const next = incrementLastNumber(named || String(release || "0.0.0").replace(/-alpha$/, ""));
  return next.slice(0, 80);
}

/** Input: evolution status. Output: which of check/apply/save applies, mirroring the main panel. */
export function evolutionActions(state) {
  const builds = Array.isArray(state?.builds) ? state.builds : [];
  const candidate = builds.find(build => build.id === state?.candidate);
  const active = builds.find(build => build.id === state?.active);
  const validation = state?.validation;
  const verified = Boolean(validation?.status === "passed" && validation.sourceHash
    && validation.candidate === candidate?.id && validation.sourceHash === candidate?.sourceHash && !state?.draftDirty);
  const canApply = Boolean(verified && candidate?.kind === "local" && candidate.id !== state?.active);
  const canSave = Boolean(state?.iteration && active?.kind === "local" && active.id !== state.iteration.base
    && state.candidate === state.active && verified);
  const checkFailed = validation?.status === "failed" || validation?.status === "interrupted";
  const needsCheck = Boolean(state?.iteration && !verified && validation?.status !== "unchanged");
  return {
    needsCheck, checkFailed, canApply, canSave,
    candidateId: canApply ? candidate.id : null,
    busy: Boolean(state?.transaction || (state?.phase && state.phase !== "idle")),
    unchanged: validation?.status === "unchanged",
    suggestedName: nextVersionName(state),
  };
}
