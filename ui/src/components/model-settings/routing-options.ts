import type { RoutingCandidate } from "../../routing-types";

/** Keep model selection independent from supported reasoning-effort variants. */
export function modelGroups(candidates: RoutingCandidate[]) {
  const groups = new Map<string, RoutingCandidate[]>();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.connection ?? candidate.provider, candidate.backend, candidate.model]);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  return [...groups].map(([id, variants]) => ({ id, variants, model: variants[0].model,
    connection: variants[0].connection ?? variants[0].provider, backend: variants[0].backend,
    enabled: variants.some(item => item.enabled && item.available === true),
    available: variants.some(item => item.available === true) }));
}

/** Preserve exclusions while enabling only combinations confirmed by the host. */
export function selectModels(candidates: RoutingCandidate[], selected: string[]) {
  const groups = modelGroups(candidates);
  return candidates.map(candidate => {
    const group = groups.find(item => item.variants.some(variant => variant.id === candidate.id))!;
    const enabled = selected.includes(group.id) && candidate.available === true
      && (group.enabled ? candidate.enabled : true);
    return { ...candidate, enabled };
  });
}
