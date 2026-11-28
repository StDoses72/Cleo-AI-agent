import type { Thread, TimelineItem, TimelinePage } from "./types";

export const MAX_TIMELINE_ITEMS = 500;
export const MAX_TIMELINE_BYTES = 4 * 1024 * 1024;
// Mirrors PAGE_SIZE in cleo/desktop/timeline.py.
export const TIMELINE_PAGE_ITEMS = 80;
// Normal page payload budget in cache units. The backend always includes the first item, even
// when oversized, and adds cursor metadata afterwards. Recheck the actual merge on arrival.
export const TIMELINE_PAGE_BYTES = 2 * 512 * 1024;
// Mirrors PREVIEW_CHARS in cleo/desktop/timeline.py for tool output and commands.
export const TIMELINE_PREVIEW_CHARS = 32768;

// What each loaded item weighs against MAX_TIMELINE_BYTES, kept from the pass that bounded it.
const weights = new WeakMap<TimelineItem, number>();
const weigh = (item: TimelineItem) => {
  let bytes = weights.get(item);
  if (bytes === undefined) weights.set(item, bytes = JSON.stringify(item).length * 2);
  return bytes;
};

/** Purpose: Estimate how many loaded items a full page would push out of the window.
 * The window is full at MAX_TIMELINE_ITEMS items or MAX_TIMELINE_BYTES, whichever comes first: a
 * turn of tool calls with long output fills it with far fewer than 500 items.
 * Input: the loaded items and the end they leave from. Output: how many of them go when a page of
 * TIMELINE_PAGE_ITEMS items and TIMELINE_PAGE_BYTES arrives at the other end.
 */
export function timelineOverflow(items: TimelineItem[], from: "start" | "end"): number {
  const count = items.length + TIMELINE_PAGE_ITEMS - MAX_TIMELINE_ITEMS;
  let bytes = TIMELINE_PAGE_BYTES - MAX_TIMELINE_BYTES;
  for (const item of items) bytes += weigh(item);
  let gone = 0;
  for (; gone < items.length && (gone < count || bytes > 0); gone++) bytes -= weigh(items[from === "start" ? gone : items.length - 1 - gone]);
  return gone;
}

/** Purpose: Bound the history window by size and age while preserving complete live messages.
 * Input: Timeline items and the edge to retain. Output: Bounded rows; large tool payloads use previews.
 */
export function boundTimeline(items: TimelineItem[], retain: "start" | "end" = "end"): TimelineItem[] {
  const selected: TimelineItem[] = [];
  let bytes = 0;
  const ordered = retain === "end" ? [...items].reverse() : items;
  for (const original of ordered) {
    const item = { ...original } as TimelineItem;
    const text = item as unknown as Record<string, unknown>;
    for (const key of ["output", "command"]) {
      const value = text[key];
      if (typeof value === "string" && value.length > TIMELINE_PREVIEW_CHARS) {
        text[key] = value.slice(0, TIMELINE_PREVIEW_CHARS);
        item.more = { ...item.more, [key]: value.length };
      }
    }
    const size = weigh(item);
    if (selected.length >= MAX_TIMELINE_ITEMS || (selected.length > 0 && bytes + size > MAX_TIMELINE_BYTES)) break;
    bytes += size;
    selected.push(item);
  }
  return retain === "end" ? selected.reverse() : selected;
}

/** Purpose: Merge one fetched page into the loaded window.
 * Input: the thread, the page, where the page lies, the thread as it was when the page was
 * requested, and whether unsaved items the page lacks stay. `retain` is the end of the window the
 * reader is at, kept when the cache overflows (a page of older items is normally read from its
 * start). `keepEarlier` refreshes the newest page under a reader who has gone back: what is loaded
 * before that page stays. Output: the thread with the bounded window and its paging state.
 */
export function mergeTimelinePage(thread: Thread, page: TimelinePage, direction: "latest" | "before" | "after", requestedFrom?: Thread, preserveUnpersisted = false,
  { retain = direction === "before" ? "start" : "end", keepEarlier = false }: { retain?: "start" | "end"; keepEarlier?: boolean } = {}): Thread {
  const baseline = new Map(requestedFrom?.items.map(item => [item.id, item]));
  const incoming = new Map(page.items.map(item => [item.id, item]));
  const live = new Map(requestedFrom ? thread.items.filter(item =>
    !(item.type === "notice" && item.cursor === undefined) &&
    ((preserveUnpersisted && item.cursor === undefined && !incoming.has(item.id)) ||
      JSON.stringify(item) !== JSON.stringify(baseline.get(item.id)))).map(item => [item.id, item]) : []);
  for (const [id, item] of live) {
    const fetched = incoming.get(id);
    // A persisted terminal receipt supersedes the UI's provisional unavailable state.
    if (item.type === "question" && fetched?.type === "question" && fetched.request.status !== "pending") live.delete(id);
  }
  const fetched = page.items.map(item => live.get(item.id) ?? item);
  const existing = thread.items.map(item => live.get(item.id) ?? incoming.get(item.id) ?? item);
  const appended = [...live.values()].filter(item => !incoming.has(item.id) &&
    (item.order === undefined || item.order > (page.items.at(-1)?.order ?? -1)));
  // The loaded items that come before the page: up to the first one the page holds or follows.
  const firstOrder = page.items[0]?.order;
  const reached = keepEarlier && direction === "latest" ? thread.items.findIndex(item => incoming.has(item.id)
    || (firstOrder !== undefined && item.order !== undefined && item.order >= firstOrder)) : 0;
  const earlier = existing.slice(0, Math.max(0, reached));
  const joined = direction === "latest" ? [...earlier, ...fetched, ...appended]
    : direction === "before" ? [...fetched, ...existing] : [...existing, ...fetched];
  const unique = [...new Map(joined.filter(item => {
    if (item.type !== "message" || item.role !== "assistant" || !item.turnId
        || !item.content || item.id !== `${item.turnId}:answer`) return true;
    return !page.items.some(saved => saved.type === "message" && saved.role === "assistant"
      && saved.turnId === item.turnId && saved.id !== item.id
      && saved.content.startsWith(item.content));
  }).map(item => [item.id, item])).values()].map(item => {
    const saved = incoming.get(item.id);
    return item.order === undefined && saved?.order !== undefined
      ? { ...item, order: saved.order, cursor: saved.cursor } : item;
  });
  const ordered = unique.filter(item => item.order !== undefined).sort((a, b) => a.order! - b.order!);
  if (ordered.length) {
    const orderedIds = new Set(ordered.map(item => item.id));
    for (const item of unique.filter(candidate => candidate.order === undefined)) {
      const source = thread.items.findIndex(candidate => candidate.id === item.id);
      const next = source < 0 ? undefined : thread.items.slice(source + 1)
        .find(candidate => orderedIds.has(candidate.id));
      const nextIndex = next ? ordered.findIndex(candidate => candidate.id === next.id) : -1;
      if (nextIndex >= 0) ordered.splice(nextIndex, 0, item);
      else {
        const sameTurn = item.turnId
          ? ordered.findLastIndex(candidate => candidate.turnId === item.turnId) : -1;
        ordered.splice(sameTurn >= 0 ? sameTurn + 1 : ordered.length, 0, item);
      }
      orderedIds.add(item.id);
    }
  }
  const items = boundTimeline(ordered.length ? ordered : unique, retain);
  const old = thread.history;
  const { items: _items, ...info } = page;
  // The page knows what lies beyond its own side; the other side is as it was, plus whatever the
  // cache had to drop there.
  const dropped = items.length < unique.length;
  return { ...thread, items, history: {
    ...info, total: Math.max(info.total, thread.history?.total ?? 0),
    before: items.find(item => item.cursor)?.cursor ?? page.before,
    after: [...items].reverse().find(item => item.cursor)?.cursor ?? page.after,
    hasBefore: (direction === "after" || earlier.length ? Boolean(old?.hasBefore) : page.hasBefore) || (dropped && retain === "end"),
    hasAfter: (direction === "before" ? Boolean(old?.hasAfter) : page.hasAfter) || (dropped && retain === "start"),
  } };
}
