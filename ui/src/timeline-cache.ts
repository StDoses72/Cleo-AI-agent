import type { Thread, TimelineItem, TimelinePage } from "./types";

export const MAX_TIMELINE_ITEMS = 500;
export const MAX_TIMELINE_BYTES = 4 * 1024 * 1024;

export function boundTimeline(items: TimelineItem[], retain: "start" | "end" = "end"): TimelineItem[] {
  const selected: TimelineItem[] = [];
  let bytes = 0;
  const ordered = retain === "end" ? [...items].reverse() : items;
  for (const original of ordered) {
    const item = { ...original } as TimelineItem;
    const text = item as unknown as Record<string, unknown>;
    for (const key of ["content", "output", "command"]) {
      const value = text[key];
      if (typeof value === "string" && value.length > 8192) {
        text[key] = item.type === "thought"
          ? `${value.slice(0, 2048)}\n\n…（可打开完整正文）…\n\n${value.slice(-6000)}` : value.slice(0, 8192);
        item.more = { ...item.more, [key]: value.length };
      }
    }
    const size = JSON.stringify(item).length * 2;
    if (selected.length >= MAX_TIMELINE_ITEMS || (selected.length > 0 && bytes + size > MAX_TIMELINE_BYTES)) break;
    bytes += size;
    selected.push(item);
  }
  return retain === "end" ? selected.reverse() : selected;
}

export function mergeTimelinePage(thread: Thread, page: TimelinePage, direction: "latest" | "before" | "after", requestedFrom?: Thread): Thread {
  const baseline = new Map(requestedFrom?.items.map(item => [item.id, item]));
  const live = new Map(requestedFrom ? thread.items.filter(item =>
    !(item.type === "notice" && item.cursor === undefined) &&
    JSON.stringify(item) !== JSON.stringify(baseline.get(item.id))).map(item => [item.id, item]) : []);
  const incoming = new Map(page.items.map(item => [item.id, item]));
  for (const [id, item] of live) {
    const fetched = incoming.get(id);
    // A persisted terminal receipt supersedes the UI's provisional unavailable state.
    if (item.type === "question" && fetched?.type === "question" && fetched.request.status !== "pending") live.delete(id);
  }
  const fetched = page.items.map(item => live.get(item.id) ?? item);
  const existing = thread.items.map(item => live.get(item.id) ?? incoming.get(item.id) ?? item);
  const appended = [...live.values()].filter(item => !incoming.has(item.id) &&
    (item.order === undefined || item.order > (page.items.at(-1)?.order ?? -1)));
  const joined = direction === "latest" ? [...fetched, ...appended]
    : direction === "before" ? [...fetched, ...existing] : [...existing, ...fetched];
  const unique = [...new Map(joined.map(item => [item.id, item])).values()];
  const items = boundTimeline(unique, direction === "before" ? "start" : "end");
  const old = thread.history;
  const { items: _items, ...info } = page;
  return { ...thread, items, history: {
    ...info, total: Math.max(info.total, thread.history?.total ?? 0),
    before: items.find(item => item.cursor)?.cursor ?? page.before,
    after: [...items].reverse().find(item => item.cursor)?.cursor ?? page.after,
    hasBefore: direction === "before" || direction === "latest" ? page.hasBefore
      : Boolean(old?.hasBefore || items.length < unique.length),
    hasAfter: direction === "after" || direction === "latest" ? page.hasAfter
      : Boolean(old?.hasAfter || items.length < unique.length),
  } };
}
