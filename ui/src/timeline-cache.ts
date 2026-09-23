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
  const items = boundTimeline(ordered.length ? ordered : unique, direction === "before" ? "start" : "end");
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
