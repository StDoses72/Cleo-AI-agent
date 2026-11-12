import type { ProductivityModelCatalog, ProductivityProviderOption } from "./types";

/** Purpose: Tell which harnesses can be picked: those whose own model discovery succeeds.
 * Input: candidates, a live loader, and callbacks called as each check settles: one for a harness
 * with models, an optional one for a harness that failed or offered none.
 * Output: completion once all checks settle.
 */
export async function checkHarnessConnections(
  providers: ProductivityProviderOption[],
  loadModels: (provider: string) => Promise<ProductivityModelCatalog>,
  onConnected: (provider: ProductivityProviderOption, models: ProductivityModelCatalog) => void,
  onUnavailable?: (provider: ProductivityProviderOption) => void,
): Promise<void> {
  await Promise.allSettled(providers.map(async provider => {
    const models = await loadModels(provider.id).catch(() => null);
    if (models && models.provider === provider.id && models.models.length) onConnected(provider, models);
    else onUnavailable?.(provider);
  }));
}
