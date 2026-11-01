import type { ProductivityModelCatalog, ProductivityProviderOption } from "./types";

/** Purpose: Offer harnesses only after their own model discovery succeeds.
 * Input: candidates, a live loader and an incremental result callback.
 * Output: completion once all checks settle; failed/empty clients remain hidden.
 */
export async function checkHarnessConnections(
  providers: ProductivityProviderOption[],
  loadModels: (provider: string) => Promise<ProductivityModelCatalog>,
  onConnected: (provider: ProductivityProviderOption, models: ProductivityModelCatalog) => void,
): Promise<void> {
  await Promise.allSettled(providers.map(async provider => {
    const models = await loadModels(provider.id);
    if (models.provider === provider.id && models.models.length) onConnected(provider, models);
  }));
}
