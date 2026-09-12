import { useEffect, useRef, useState } from "react";
import { cleoClient } from "./services/cleoClient";
import { mergeTimelinePage } from "./timeline-cache";
import type { Thread } from "./types";

export function useTimelineHistory(thread: Thread | null, update: (id: string, fn: (t: Thread) => Thread) => void) {
  const latest = useRef({ thread, update });
  latest.current = { thread, update };
  const follow = useRef(true);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<"latest" | "before" | "after" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unread, setUnread] = useState(false);
  const [following, setFollowing] = useState(true);
  const retryDirection = useRef<"latest" | "before" | "after">("latest");

  useEffect(() => {
    generation.current += 1;
    inFlight.current = false;
    follow.current = true;
    setFollowing(true);
    setBusy(null); setError(null); setUnread(false);
  }, [thread?.id]);

  const load = async (direction: "latest" | "before" | "after", beforeApply?: () => void) => {
    const { thread: current } = latest.current;
    if (!current || (inFlight.current && direction !== "latest")) return;
    if (inFlight.current) generation.current++;
    const token = generation.current;
    inFlight.current = true; setBusy(direction); setError(null);
    retryDirection.current = direction;
    try {
      const cursor = direction === "before" ? current.history?.before : current.history?.after;
      const page = await cleoClient.loadTimeline(current.id, cursor ? direction : "latest", cursor);
      if (token !== generation.current || latest.current.thread?.id !== current.id) return;
      beforeApply?.();
      latest.current.update(current.id, saved => mergeTimelinePage(saved, page, direction, current));
      if (direction === "latest") { follow.current = true; setFollowing(true); setUnread(false); }
    } catch (failure) {
      if (token === generation.current) setError(failure instanceof Error ? failure.message : "历史加载失败");
    } finally {
      if (token === generation.current) { inFlight.current = false; setBusy(null); }
    }
  };

  return {
    busy, error, unread, following, load,
    retry: () => load(retryDirection.current),
    follow: (value: boolean) => { follow.current = value; setFollowing(value); if (value) setUnread(false); },
    isFollowing: (id: string) => latest.current.thread?.id === id && follow.current && !latest.current.thread.history?.hasAfter,
    notify: (id: string) => { if (latest.current.thread?.id === id) setUnread(true); },
  };
}
