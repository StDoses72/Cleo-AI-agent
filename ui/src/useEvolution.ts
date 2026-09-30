import { useCallback, useEffect, useRef, useState } from "react";
import type { EvolutionState } from "./evolution-types";

/** Purpose: Keep evolution state synchronized with the desktop controller.
 * Input: none. Output: state and serialized UI operations.
 */
export function useEvolution() {
  const [state, setState] = useState<EvolutionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const revision = useRef(0);
  const [pending, setPending] = useState(false);
  const readQueue = useRef(Promise.resolve());
  const refresh = useCallback(async () => {
    if (!window.cleoDesktop) return;
    const version = ++revision.current;
    try {
      const loaded = await window.cleoDesktop.getEvolutionState();
      if (version === revision.current) { setState(loaded); setLoadError(null); }
    } catch (failure) {
      if (version === revision.current) setLoadError(failure instanceof Error ? failure.message : String(failure));
      throw failure;
    }
  }, []);
  useEffect(() => {
    const unsubscribe = window.cleoDesktop?.onEvolutionState(next => {
      revision.current++; setState(next); setLoadError(null);
    });
    void refresh().catch(() => {});
    return () => { revision.current++; unsubscribe?.(); };
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
      await refresh().catch(() => {});
    }
  }, [refresh]);
  const inspect = useCallback(<T,>(action: string, params: Record<string, unknown> = {}): Promise<T> => {
    const request = readQueue.current.then(async () => {
      if (!window.cleoDesktop) throw new Error("请在 Cleo 桌面应用中使用本地迭代。");
      try { return await window.cleoDesktop.evolutionAction<T>(action, params); }
      catch (failure) {
        throw new Error((failure instanceof Error ? failure.message : String(failure))
          .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
      }
    });
    readQueue.current = request.then(() => {}, () => {});
    return request;
  }, []);
  return { state, error: error || loadError, loadError, pending, run, inspect, refresh };
}
