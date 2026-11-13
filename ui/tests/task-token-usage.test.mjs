import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { after } from "node:test";
import { createServer } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Compile the real component with the project's own frontend pipeline, without a listener.
const ui = resolve(import.meta.dirname, "..");
const server = await createServer({ root: ui, configFile: false,
  server: { middlewareMode: true, hmr: false }, esbuild: { jsx: "automatic" } });
after(() => server.close());
const { TaskTokenUsage } = await server.ssrLoadModule("/src/components/TaskTokenUsage.tsx");
const { ContextMeter, ContextPanel } = await server.ssrLoadModule("/src/components/ContextMeter.tsx");

test("current task renders compact model calls, tokens and reference USD without history", () => {
  const html = renderToStaticMarkup(React.createElement(TaskTokenUsage, { usage: {
    taskId: "current", taskNumber: 2, scope: "task", boundaryStatus: "confirmed",
    total: 120, referenceUsd: 0.003, input: 100, output: 20, reportedCalls: 3, missingCalls: 0, complete: true,
    abstract: "路由连通性测试", abstractSource: "evaluator",
    models: [{ model: "sonnet", provider: "claude", total: 100, reportedCalls: 2, referenceUsd: 0.002,
      parts: [{ part: "运行测试", total: 100 }] },
      { model: "fixture-evaluator", provider: "api", total: 20 }],
    history: [{ taskId: "previous", taskNumber: 1, total: 900, input: 800, output: 100,
      scope: "task", missingCalls: 0, complete: true }],
  } }));
  assert.match(html, /当前任务模型用量/);
  assert.match(html, /120 token<\/strong>/);
  assert.match(html, /路由连通性测试/);
  assert.match(html, /运行测试/);
  assert.match(html, /\$0.0030/);
  assert.match(html, /\$0.0020/);
  assert.match(html, /调用/);
  assert.doesNotMatch(html, /83.3%/);
  assert.match(html, /sonnet/);
  assert.match(html, /fixture-evaluator/);
  assert.doesNotMatch(html, /历史任务|900 token|<details>/);
});

test("context ring shows the latest request footprint and its panel the numbers behind it", () => {
  const usage = { used: 41818, limit: 258400, input: 41558, output: 260 };
  const ring = renderToStaticMarkup(React.createElement(ContextMeter, { usage }));
  assert.match(ring, /16%/);
  assert.match(ring, /aria-expanded="false"/);
  assert.doesNotMatch(ring, /context-meter-panel/, "the panel is closed until the ring is clicked");
  const panel = renderToStaticMarkup(React.createElement(ContextPanel, { usage }));
  assert.match(panel, /41\.8k \/ 258\.4k/);
  assert.doesNotMatch(panel, /容量随模型|可能下降/, "numbers, not an explanation");
  assert.doesNotMatch(panel, /用量|context-meter-section/, "no usage section without a reading");
});

test("context panel lists the account's usage windows and leaves out what it cannot name", () => {
  const usage = { used: 41818, limit: 258400, input: 41818, output: 260 };
  const now = new Date(2026, 10, 13, 9, 0).getTime();
  const at = (...parts) => Math.floor(new Date(...parts).getTime() / 1000);
  const panel = renderToStaticMarkup(React.createElement(ContextPanel, { usage, now, windows: [
    { minutes: 300, percent: 42, resetsAt: at(2026, 10, 13, 14, 30), scope: null },
    { minutes: 10080, percent: 6, resetsAt: at(2026, 10, 19, 13, 0), scope: null },
    { minutes: 10080, percent: 11, resetsAt: null, scope: "Opus" },
    { minutes: 43200, percent: 3, resetsAt: at(2026, 11, 1, 0, 5), scope: null },
    // Already reset, and a window of unknown length: neither is shown.
    { minutes: 300, percent: 99, resetsAt: at(2026, 10, 13, 8, 0), scope: null },
    { minutes: null, percent: 77, resetsAt: null, scope: null },
  ] }));
  const rows = [...panel.matchAll(/<dt>(.*?)<\/dt><dd>(.*?)<\/dd>/g)].map(([, name, value]) => [name, value.replace(/<[^>]+>/g, " ").trim().replace(/\s+/g, " ")]);
  assert.deepEqual(rows, [
    ["5 小时", "14:30 重置 42%"],
    ["本周", "11/19 13:00 重置 6%"],
    ["本周 · Opus", "11%"],
    ["30 天", "12/1 00:05 重置 3%"],
  ]);
  assert.match(panel, /<strong>用量<\/strong>/);
  const none = renderToStaticMarkup(React.createElement(ContextPanel, { usage, now, windows: [
    { minutes: null, percent: 77, resetsAt: null, scope: null },
  ] }));
  assert.doesNotMatch(none, /用量/);
});

test("context ring is absent without a reported footprint and never exceeds a full circle", () => {
  for (const usage of [undefined, { used: null, limit: 128000, input: null, output: null },
    { used: 4000, limit: 0, input: 3000, output: 1000 }]) {
    assert.equal(renderToStaticMarkup(React.createElement(ContextMeter, { usage })), "");
  }
  const over = { used: 10969124, limit: 258400, input: 41558, output: 260 };
  const ring = renderToStaticMarkup(React.createElement(ContextMeter, { usage: over }));
  assert.match(ring, /100%/);
  assert.match(ring, /class="context-meter high"/);
  assert.doesNotMatch(ring, /4245%/);
  const panel = renderToStaticMarkup(React.createElement(ContextPanel, { usage: over }));
  assert.match(panel, /10\.97M \/ 258\.4k/, "the reported numbers are shown as they came");
  assert.match(panel, /width:100%/);
});

test("uncertain boundaries and missing telemetry are disclosed without inventing zero", () => {
  const html = renderToStaticMarkup(React.createElement(TaskTokenUsage, { usage: {
    taskId: "same", taskNumber: 1, scope: "task", boundaryStatus: "unknown",
    total: null, input: null, output: null, missingCalls: 1, complete: false,
  } }));
  assert.doesNotMatch(html, /任务判断待确认/);
  assert.match(html, /— token/);
  assert.match(html, /1 条未上报/);
  assert.doesNotMatch(html, /<strong>0<\/strong>/);
});

test("unsegmented historical sessions are labelled accurately", () => {
  const html = renderToStaticMarkup(React.createElement(TaskTokenUsage, { usage: {
    total: 100, input: 80, output: 20, missingCalls: 0, complete: true,
  } }));
  assert.match(html, /等待任务/);
  assert.doesNotMatch(html, /新目标单独记账/);
  assert.doesNotMatch(html.split("<details>")[0], /<strong>/);
  assert.doesNotMatch(html, /旧会话历史|100 token/);
});

test("current task excludes lifetime history even while semantic evaluation is unavailable", () => {
  const html = renderToStaticMarkup(React.createElement(TaskTokenUsage, { usage: {
    taskId: "recorded", taskNumber: 1, scope: "task", coverage: "since_tracking",
    abstract: "检查子任务路由", boundaryStatus: "unknown", boundaryReason: "evaluation_unavailable",
    total: 12, input: 10, output: 2, missingCalls: 0, complete: true,
    models: [{ model: "sol", provider: "codex", total: 12,
      parts: [{ part: "测试", total: 12 }] }],
    history: [{ taskId: "session_history", scope: "session_history", total: 9000000,
      input: 8900000, output: 100000, missingCalls: 0, complete: true }],
  } }));
  const current = html.split("<details>")[0];
  assert.match(current, /12 token/);
  assert.doesNotMatch(current, /100.0%/);
  assert.doesNotMatch(current, /暂计入此任务/);
  assert.match(current, /USD/);
  assert.doesNotMatch(current, /9,000,000/);
  assert.doesNotMatch(html, /9,000,000|历史任务/);
});
