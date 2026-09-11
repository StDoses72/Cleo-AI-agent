import { useCallback, useEffect, useState } from "react";
import type { EvolutionState } from "./evolution-types";

/** Purpose: Keep evolution state synchronized with the desktop controller.
 * Input: none. Output: state and serialized UI operations.
 */
export function useEvolution() {
  const [state, setState] = useState<EvolutionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const refresh = useCallback(async () => {
    if (window.cleoDesktop) setState(await window.cleoDesktop.getEvolutionState());
  }, []);
  useEffect(() => {
    void refresh().catch((failure: unknown) => setError(String(failure)));
    return window.cleoDesktop?.onEvolutionState(setState);
  }, [refresh]);
  const run = useCallback(async <T,>(action: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (!window.cleoDesktop) throw new Error("请在 Cleo 桌面应用中使用本地迭代。");
    setPending(true); setError(null);
    try { return await window.cleoDesktop.evolutionAction<T>(action, params); }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      throw failure;
    } finally { setPending(false); await refresh(); }
  }, [refresh]);
  return { state, error, pending, run, refresh };
}
