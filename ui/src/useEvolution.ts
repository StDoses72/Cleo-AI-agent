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
      const message = (failure instanceof Error ? failure.message : String(failure))
        .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
      setError(message);
      throw new Error(message);
    } finally {
      setPending(false);
      // A failed status refresh must not turn an accepted PR into a failed submission.
      await refresh().catch((failure: unknown) => setError(`状态刷新失败：${String(failure)}`));
    }
  }, [refresh]);
  return { state, error, pending, run, refresh };
}
