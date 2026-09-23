import assert from "node:assert/strict";
import test from "node:test";
import { boundTimeline, mergeTimelinePage, MAX_TIMELINE_BYTES } from "../src/timeline-cache.ts";

const all = Array.from({ length: 10000 }, (_, i) => ({ id: String(i), cursor: String(i), type: "message", role: i % 2 ? "assistant" : "user", content: `item ${i}`, time: "" }));
const page = (start, end) => ({ items: all.slice(start, end), before: String(start), after: String(end - 1), hasBefore: start > 0, hasAfter: end < all.length, total: all.length, revision: "1" });

test("ten thousand items traverse both directions with a bounded, duplicate-free cache", () => {
  let thread = { items: [] };
  thread = mergeTimelinePage(thread, page(9920, 10000), "latest");
  for (let end = 9920; end > 0; end -= 80) {
    thread = mergeTimelinePage(thread, page(Math.max(0, end - 80), end), "before");
    assert.ok(thread.items.length <= 500);
    assert.equal(new Set(thread.items.map(i => i.id)).size, thread.items.length);
    assert.equal(thread.items[0].id, String(Math.max(0, end - 80)));
    assert.equal("items" in thread.history, false, "Pagination metadata must not retain another page");
  }
  assert.equal(thread.items[0].id, "0");
  while (thread.history.hasAfter) {
    const start = Number(thread.history.after) + 1;
    thread = mergeTimelinePage(thread, page(start, Math.min(start + 80, 10000)), "after");
    assert.ok(thread.items.length <= 500);
  }
  assert.equal(thread.items.at(-1).id, "9999");
});

test("overlapping pages replace updated tools without duplicates", () => {
  const first = { ...page(0, 2), items: [{ id: "tool", cursor: "0", type: "tool", status: "running", name: "x", command: "" }] };
  const thread = mergeTimelinePage({ items: [] }, first, "latest");
  const updated = { ...first, items: [{ ...first.items[0], status: "done", output: "complete" }] };
  const next = mergeTimelinePage(thread, updated, "after");
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0].status, "done");
});

test("large text is bounded and exposes a separate full-content reader", () => {
  const items = boundTimeline(Array.from({ length: 500 }, (_, i) => ({ ...all[i], content: "x".repeat(60000) })));
  assert.ok(JSON.stringify(items).length * 2 <= MAX_TIMELINE_BYTES + 1024);
  assert.ok(items.length < 500);
  assert.equal(items[0].more.content, 60000);
});

test("an in-flight page cannot overwrite newer stream updates or drop appended items", () => {
  const original = { ...all[0], order: 1, content: "partial" };
  const requested = { items: [original] };
  const updated = { ...original, content: "complete", turnHasAnswer: true };
  const appended = { ...all[1], order: 2 };
  const current = { items: [updated, appended] };
  const stalePage = { ...page(0, 1), items: [original] };
  for (const direction of ["latest", "before", "after"]) {
    const result = mergeTimelinePage(current, stalePage, direction, requested);
    assert.deepEqual(result.items, [updated, appended]);
  }
});

test("persisted chat replies replace matching live replies without moving them past the next user turn", () => {
  const previousUser = { id: "turn-1", turnId: "turn-1", type: "message", role: "user", content: "first", order: 1 };
  const liveReply = { id: "turn-1:answer", turnId: "turn-1", type: "message", role: "assistant", content: "answer" };
  const savedReply = { ...liveReply, id: "evt-answer", order: 2, cursor: "2" };
  const nextUser = { id: "turn-2", turnId: "turn-2", type: "message", role: "user", content: "next", order: 3 };
  const requested = { items: [previousUser] };
  const current = { items: [previousUser, liveReply, nextUser] };
  const loaded = { ...page(0, 3), items: [previousUser, savedReply, nextUser] };
  for (const direction of ["latest", "before", "after"]) {
    const result = mergeTimelinePage(current, loaded, direction, requested);
    assert.deepEqual(result.items.map(item => item.id), ["turn-1", "evt-answer", "turn-2"]);
  }
  const stale = { ...loaded, items: [previousUser, nextUser] };
  assert.deepEqual(mergeTimelinePage(current, stale, "latest", requested).items.map(item => item.id),
    ["turn-1", "turn-1:answer", "turn-2"]);
  const different = { ...loaded, items: [previousUser, { ...savedReply, content: "different" }, nextUser] };
  assert.deepEqual(mergeTimelinePage(current, different, "latest", requested).items.map(item => item.id),
    ["turn-1", "evt-answer", "turn-1:answer", "turn-2"]);
  const updatedUser = { ...nextUser, content: "next updated", order: undefined };
  const updated = mergeTimelinePage({ items: [previousUser, liveReply, updatedUser] }, loaded, "latest", requested);
  assert.deepEqual(updated.items.map(item => item.id), ["turn-1", "evt-answer", "turn-2"]);
  assert.equal(updated.items[2].content, "next updated");
  assert.equal(updated.items[2].order, 3);
});

test("durable question cancellation supersedes provisional UI cleanup", () => {
  const question = { id: "q", type: "question", request: { status: "pending" } };
  const requested = { items: [question] };
  const current = { items: [{ ...question, request: { status: "unavailable" } }] };
  const cancelled = { ...question, request: { status: "cancelled" } };
  const result = mergeTimelinePage(current, { ...page(0, 1), items: [cancelled] }, "latest", requested);
  assert.equal(result.items[0].request.status, "cancelled");
});
