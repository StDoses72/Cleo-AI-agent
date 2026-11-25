import { t as tr } from "../electron/i18n.mjs";
import { useEffect, useRef, useState } from "react";
import { cleoClient } from "./services/cleoClient";
import { mergeTimelinePage } from "./timeline-cache";
import type { Thread } from "./types";

type Direction = "latest" | "before" | "after";
interface LoadOptions {
  /** Runs right before the page reaches the thread. */
  beforeApply?: () => void;
  /** Unsaved items the page does not hold stay in the window. */
  preserveUnpersisted?: boolean;
  /** Refresh the latest page where the reader is: the view is not pinned to the end, and what is loaded before the page stays. */
  keepPosition?: boolean;
  /** The end of the window the reader is at, kept when the cache overflows. */
  retain?: "start" | "end";
}

export function useTimelineHistory(thread: Thread | null, update: (id: string, fn: (t: Thread) => Thread) => void) {
  const latest = useRef({ thread, update });
  const follow = useRef(true);
  const positions = useRef(new Map<string, boolean>());
  if (latest.current.thread) positions.current.set(latest.current.thread.id,
    !latest.current.thread.history?.hasAfter);
  latest.current = { thread, update };
  const generation = useRef(0);
  const inFlight = useRef(false);
  // Known here before the next render shows it: the last page failed, or it arrived for this very
  // window and is on its way to the screen.
  const failed = useRef(false);
  const applied = useRef<Thread | null>(null);
  const [busy, setBusy] = useState<"latest" | "before" | "after" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unread, setUnread] = useState(false);
  const [following, setFollowing] = useState(true);
  const retried = useRef<{ direction: Direction; options?: LoadOptions }>({ direction: "latest" });

  useEffect(() => {
    generation.current += 1;
    inFlight.current = false;
    failed.current = false;
    applied.current = null;
    follow.current = true;
    setFollowing(true);
    setBusy(null); setError(null); setUnread(false);
  }, [thread?.id]);

  const request = async (direction: Direction, options: LoadOptions = {}) => {
    const { beforeApply, preserveUnpersisted = false, keepPosition = false, retain } = options;
    const { thread: current } = latest.current;
    if (!current || (inFlight.current && direction !== "latest")) return;
    if (inFlight.current) generation.current++;
    const token = generation.current;
    inFlight.current = true; failed.current = false; setBusy(direction); setError(null);
    retried.current = { direction, options };
    try {
      const cursor = direction === "before" ? current.history?.before : current.history?.after;
      const page = await cleoClient.loadTimeline(current.id, cursor ? direction : "latest", cursor);
      if (token !== generation.current || latest.current.thread?.id !== current.id) return;
      beforeApply?.();
      latest.current.update(current.id, saved => mergeTimelinePage(saved, page, direction, current, preserveUnpersisted,
        { retain, keepEarlier: keepPosition }));
      applied.current = latest.current.thread;
      if (direction === "latest" && !keepPosition) { follow.current = true; setFollowing(true); setUnread(false); }
      return true;
    } catch (failure) {
      if (token === generation.current) { failed.current = true; setError(failure instanceof Error ? failure.message : tr("usetimelinehistory.could_not_load_history")); }
    } finally {
      if (token === generation.current) { inFlight.current = false; setBusy(null); }
    }
  };

  /** Purpose: Load one page and merge it into the window. Output: true once the page is applied.
   * A page before or after the window is not asked for while one is on its way, has arrived and is
   * not on screen yet, or failed and waits for the retry: scrolling asks again between two renders.
   */
  const load = async (direction: Direction, options: LoadOptions = {}) => {
    if (direction !== "latest" && (failed.current || latest.current.thread === applied.current)) return;
    return request(direction, options);
  };

  return {
    busy, error, unread, following, followRef: follow, load,
    isActive: (id: string) => latest.current.thread?.id === id,
    retry: () => request(retried.current.direction, retried.current.options),
    follow: (value: boolean) => { follow.current = value; setFollowing(value); if (value) setUnread(false); },
    /** The loaded window ends at the newest item, so live output belongs in it wherever the view is. */
    isFollowing: (id: string) => latest.current.thread?.id === id
      ? !latest.current.thread.history?.hasAfter
      : positions.current.get(id) ?? true,
    /** The view is pinned to the end and moves with new output. */
    isPinned: (id: string) => latest.current.thread?.id !== id || follow.current,
    notify: (id: string) => { if (latest.current.thread?.id === id) setUnread(true); },
  };
}
