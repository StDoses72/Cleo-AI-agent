import { useCallback, useEffect, useRef, useState } from "react";

/** Refresh visible read-only panels without losing their data or accepting an old selection. */
export function useAutomaticRead<T>(key: string, enabled: boolean, read: () => Promise<T>, interval = 60000) {
  const root = useRef<HTMLElement>(null);
  const mounted = useRef(false);
  const reading = useRef(false);
  const latest = useRef({ key, enabled, read, interval });
  latest.current = { key, enabled, read, interval };
  const attempt = useRef({ key: "", at: 0, failures: 0 });
  const [state, setState] = useState<{ key: string; data: T | null; pending: boolean; error: string }>({
    key: "", data: null, pending: false, error: "",
  });
  const refresh = useCallback(async (force = false) => {
    const selected = latest.current;
    if (!mounted.current || !selected.enabled || reading.current || document.hidden
        || !root.current?.getClientRects().length
        || root.current.closest("details:not([open]), dialog:not([open]), [hidden]")) return;
    const previous = attempt.current;
    const delay = Math.min(300000, selected.interval * 2 ** previous.failures);
    if (!force && previous.key === selected.key && Date.now() - previous.at < delay) return;
    attempt.current = { key: selected.key, at: Date.now(), failures: previous.key === selected.key ? previous.failures : 0 };
    reading.current = true;
    setState(current => ({ key: selected.key, data: current.key === selected.key ? current.data : null, pending: true, error: "" }));
    try {
      const data = await selected.read();
      if (mounted.current && latest.current.key === selected.key) {
        attempt.current.failures = 0;
        attempt.current.at = Date.now();
        setState({ key: selected.key, data, pending: false, error: "" });
      }
    } catch (failure) {
      if (mounted.current && latest.current.key === selected.key) {
        attempt.current.failures += 1;
        attempt.current.at = Date.now();
        setState(current => ({ ...current, pending: false, error: failure instanceof Error ? failure.message : String(failure) }));
      }
    } finally {
      reading.current = false;
      if (mounted.current && latest.current.key !== selected.key) void refresh();
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const check = () => void refresh();
    const returnToPage = () => void refresh(attempt.current.failures === 0);
    window.addEventListener("focus", returnToPage);
    document.addEventListener("visibilitychange", returnToPage);
    document.addEventListener("toggle", check, true);
    const timer = window.setInterval(check, Math.min(interval, 30000));
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", returnToPage);
      document.removeEventListener("visibilitychange", returnToPage);
      document.removeEventListener("toggle", check, true);
      window.clearInterval(timer);
    };
  }, [refresh, interval]);
  useEffect(() => { void refresh(); }, [key, enabled, refresh]);
  const current = state.key === key ? state : null;
  return { root, data: current?.data ?? null, pending: current?.pending ?? false, error: current?.error ?? "", retry: () => refresh(true) };
}
