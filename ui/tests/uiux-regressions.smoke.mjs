import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "cleo-uiux-"));
const server = await createServer({ root: ui, cacheDir: join(scratch, "vite"),
  server: { host: "127.0.0.1", port: 0 } });
let browser;
const failures = [];

async function check(name, run) {
  if (process.argv[2] && !name.includes(process.argv[2])) return;
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(6000);
  try {
    await page.goto(server.resolvedUrls.local[0]);
    await page.getByTestId("composer-input").waitFor();
    await run(page);
    console.log(`PASS: ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.error(`FAIL: ${name}: ${error.message}`);
  } finally { await page.close(); }
}

try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
  await check("connections: existing login is detected without a manual check or a new login", async page => {
    await page.evaluate(async () => {
      const { cleoClient } = await import("/src/services/cleoClient.ts");
      const original = cleoClient.checkModelConnection.bind(cleoClient);
      window.probeCalls = []; window.loginCalls = 0;
      cleoClient.checkModelConnection = async value => { window.probeCalls.push(value); return original(value); };
      cleoClient.startSubscriptionLogin = async () => { window.loginCalls++; throw new Error("login should be explicit"); };
    });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "新增连接", exact: true }).first().click();
    await page.getByRole("tab", { name: "账号登录", exact: true }).click();
    await page.getByRole("button", { name: /Claude Code$/ }).click();
    await page.locator(".ms-check-models input").first().waitFor();
    assert(await page.evaluate(() => window.probeCalls.some(value => value.backend === "claude_code")));
    assert.equal(await page.evaluate(() => window.loginCalls), 0);
    await page.getByRole("button", { name: "添加连接", exact: true }).click();
    await page.getByRole("heading", { name: "当前配置", exact: true }).waitFor();
    await page.locator(".ms-connections").getByText("Claude Code · 个人账号", { exact: true }).waitFor();
  });
  await check("connections: details check automatically and offer retry only on failure", async page => {
    await page.evaluate(async () => {
      const { cleoClient } = await import("/src/services/cleoClient.ts");
      window.failProbe = true; window.probeCount = 0;
      cleoClient.checkModelConnection = async () => {
        window.probeCount++;
        if (window.failProbe) throw new Error("connection unavailable");
        return { status: "connected", models: ["default"] };
      };
    });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "当前配置", exact: true }).click();
    await page.getByRole("button", { name: "管理 Codex · 个人", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "连接详情", exact: true });
    await dialog.getByRole("alert").filter({ hasText: "connection unavailable" }).waitFor();
    const calls = await page.evaluate(() => window.probeCount);
    await dialog.getByLabel("连接名称", { exact: true }).fill("edited draft");
    assert.equal(await page.evaluate(() => window.probeCount), calls);
    await page.evaluate(() => { window.failProbe = false; });
    await dialog.getByRole("button", { name: "重试检查", exact: true }).click();
    await dialog.getByText("客户端检查通过", { exact: true }).waitFor();
    assert.equal(await dialog.getByLabel("连接名称", { exact: true }).inputValue(), "edited draft");
    assert.equal(await dialog.getByRole("button", { name: "重试检查", exact: true }).count(), 0);
  });
  await check("connections: choosing a default model takes one selection", async page => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "当前配置", exact: true }).click();
    await page.getByRole("button", { name: "切换模型", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "选择对话默认模型", exact: true });
    await dialog.getByRole("radio", { name: /GPT-6 Astra/ }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.locator(".ms-summary").getByText("GPT-6 Astra", { exact: true }).waitFor();
  });
  await check("connections: changing provider rejects late catalog results and preserves model choices", async page => {
    await page.evaluate(async () => {
      const { cleoClient } = await import("/src/services/cleoClient.ts");
      window.probeCount = 0;
      cleoClient.checkModelConnection = value => {
        window.probeCount++;
        return value.backend === "claude_code" ? new Promise(resolve => { window.finishOldProbe = resolve; })
          : Promise.resolve({ status: "connected", models: ["gemini-a", "gemini-b"] });
      };
    });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "新增连接", exact: true }).first().click();
    await page.getByRole("tab", { name: "账号登录", exact: true }).click();
    await page.getByRole("button", { name: /Claude Code$/ }).click();
    await page.waitForFunction(() => window.finishOldProbe);
    await page.getByRole("button", { name: /Gemini CLI$/ }).click();
    await page.getByRole("checkbox", { name: "gemini-b", exact: true }).check();
    await page.evaluate(() => window.finishOldProbe({ status: "connected", models: ["obsolete-claude"] }));
    assert.equal(await page.getByRole("checkbox", { name: "obsolete-claude", exact: true }).count(), 0);
    const calls = await page.evaluate(() => window.probeCount);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    assert.equal(await page.evaluate(() => window.probeCount), calls);
    assert.equal(await page.getByRole("checkbox", { name: "gemini-b", exact: true }).isChecked(), true);
  });
  await check("connections: a missing client offers installation directly", async page => {
    await page.evaluate(async () => {
      const { cleoClient } = await import("/src/services/cleoClient.ts");
      cleoClient.checkModelConnection = async () => { throw new Error("未找到 claude。请安装客户端或指定路径。"); };
    });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "新增连接", exact: true }).first().click();
    await page.getByRole("tab", { name: "账号登录", exact: true }).click();
    await page.getByRole("button", { name: /Claude Code$/ }).click();
    await page.getByRole("alert").filter({ hasText: "未找到 claude" }).waitFor();
    assert.equal(await page.getByRole("link", { name: "安装官方客户端", exact: true }).isVisible(), true);
  });
  await check("connections: failed selection retains the actual default and can be retried", async page => {
    await page.evaluate(async () => {
      const { cleoClient } = await import("/src/services/cleoClient.ts");
      const original = cleoClient.selectChatModel.bind(cleoClient);
      window.rejectModelChange = true;
      cleoClient.selectChatModel = async (...args) => {
        if (window.rejectModelChange) throw new Error("model change unavailable");
        return original(...args);
      };
    });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "当前配置", exact: true }).click();
    await page.getByRole("button", { name: "切换模型", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "选择对话默认模型", exact: true });
    await dialog.getByRole("radio", { name: /GPT-6 Astra/ }).click();
    await dialog.getByRole("alert").filter({ hasText: "model change unavailable" }).waitFor();
    assert.equal(await dialog.getByRole("radio", { name: "deepseek-v4-flash", exact: true }).getAttribute("aria-checked"), "true");
    assert.equal(await dialog.getByRole("radio", { name: /GPT-6 Astra/ }).getAttribute("aria-checked"), "false");
    await page.evaluate(() => { window.rejectModelChange = false; });
    await dialog.getByRole("radio", { name: /GPT-6 Astra/ }).click();
    await dialog.waitFor({ state: "hidden" });
  });
  await check("information: memory filtering does not claim the queue is empty", async page => {
    await page.getByRole("button", { name: "记忆", exact: true }).click();
    await page.getByTestId("memory-nav-pending").click();
    await page.getByLabel("搜索待确认来源", { exact: true }).fill("no-matching-conversation");
    await page.getByText("没有匹配的对话", { exact: true }).waitFor();
    assert.equal(await page.getByText("没有待确认来源", { exact: true }).count(), 0);
    await page.getByLabel("搜索待确认来源", { exact: true }).fill("");
    assert.equal(await page.getByTestId("memory-review-list").locator("article").count(), 2);
  });
  await check("information: open memory details follow source revisions and reject stale reads", async page => {
    await page.evaluate(async () => {
      const { cleoClient } = await import("/src/services/cleoClient.ts");
      const baseline = await cleoClient.loadWorkspace();
      const source = baseline.memoryOverview.review_sources[0];
      let first = true;
      cleoClient.getMemoryReviewDetails = async value => {
        const details = { id: value.id, source_version: value.source_version, event_count: 1,
          events: [{ id: "event", type: "human", content: "Latest memory preview", metadata: {}, created_at: null }], omitted_events: [] };
        if (first) { first = false; return new Promise(resolve => { window.finishOldDetails = () => resolve({ ...details, events: [{ ...details.events[0], content: "Obsolete memory preview" }] }); }); }
        return details;
      };
      window.upgradeMemorySource = () => {
        cleoClient.loadMemory = async () => ({ memories: baseline.memories, memoryOverview: { ...baseline.memoryOverview,
          review_sources: baseline.memoryOverview.review_sources.map(value => value.id === source.id ? { ...value, source_version: value.source_version + 1 } : value) } });
        window.dispatchEvent(new Event("focus"));
      };
    });
    await page.getByRole("button", { name: "记忆", exact: true }).click();
    await page.getByTestId("memory-nav-pending").click();
    await page.locator(".memory-review-toggle").first().click();
    await page.waitForFunction(() => window.finishOldDetails);
    await page.evaluate(() => window.upgradeMemorySource());
    await page.getByText("Latest memory preview", { exact: true }).waitFor();
    await page.evaluate(() => window.finishOldDetails());
    assert.equal(await page.getByText("Obsolete memory preview", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Latest memory preview", { exact: true }).isVisible(), true);
  });
  await check("information: unknown usage and memory previews are truthful", async page => {
    await page.evaluate(async () => {
      const { cleoClient } = await import("/src/services/cleoClient.ts");
      const original = cleoClient.loadThread.bind(cleoClient);
      cleoClient.loadThread = async id => ({ ...await original(id), usage: { used: null, limit: 128000, input: null, output: null } });
    });
    await page.getByRole("button", { name: /^完成独立桌面 UI/ }).click();
    await page.getByRole("button", { name: "上下文", exact: true }).click();
    const usage = page.locator(".inspector-section").filter({ hasText: "上下文窗口" });
    await usage.getByText("上下文用量未知", { exact: true }).waitFor();
    assert.doesNotMatch(await usage.innerText(), /0%/);
    assert.equal(await usage.locator(".usage-track").count(), 0);
    await page.locator(".memory-context summary").first().click();
    await page.locator(".memory-context").getByText(/体验型 UI 应以独立应用交付/).waitFor();
  });
  await check("information: memory model changes remain drafts until saved", async page => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "记忆整理", exact: true }).click();
    await page.getByRole("radio", { name: /关闭自动整理/ }).click();
    assert.equal(await page.evaluate(async () => {
      const { cleoClient } = await import("/src/services/cleoClient.ts");
      return (await cleoClient.getModelSettings()).dreamEnabled;
    }), true);
    assert.equal(await page.getByText("自动记忆整理已暂停", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "外观", exact: true }).click();
    await page.getByRole("button", { name: "记忆整理", exact: true }).click();
    assert.equal(await page.getByRole("radio", { name: /关闭自动整理/ }).getAttribute("aria-checked"), "true");
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await page.getByText("记忆整理设置已保存", { exact: true }).waitFor();
    assert.equal(await page.evaluate(async () => {
      const { cleoClient } = await import("/src/services/cleoClient.ts");
      return (await cleoClient.getModelSettings()).dreamEnabled;
    }), false);
  });
  await check("settings traps and restores keyboard focus", async page => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "设置", exact: true });
    for (let i = 0; i < 35; i++) {
      await page.keyboard.press(i < 20 ? "Tab" : "Shift+Tab");
      assert.equal(await dialog.evaluate(e => e.contains(document.activeElement)), true, `focus escaped on tab ${i}`);
    }
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("button", { name: "设置", exact: true }).evaluate(e => e === document.activeElement), true, "focus was not restored");
  });
  await check("command palette can reopen after opening and closing settings", async page => {
    await page.keyboard.press("Control+k");
    const search = page.getByRole("combobox", { name: "搜索命令", exact: true });
    await search.fill("设置");
    await search.press("Enter");
    await page.getByRole("dialog", { name: "设置", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await search.fill("打开");
    await search.press("ArrowDown");
    await search.press("Enter");
    await page.getByRole("heading", { name: "对话", exact: true }).waitFor();
  });
  await check("deletion failures remain visible inside the confirmation dialog", async page => {
    await page.evaluate(async () => {
      const { cleoClient } = await import("/src/services/cleoClient.ts");
      const original = cleoClient.deleteThread.bind(cleoClient);
      let failed = false;
      cleoClient.deleteThread = async id => {
        if (!failed) { failed = true; throw new Error("delete temporarily unavailable"); }
        return original(id);
      };
    });
    await page.getByTestId("delete-thread").first().click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "永久删除", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: "delete temporarily unavailable" }).waitFor();
    await dialog.getByRole("button", { name: "永久删除", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  });
  await check("settings shortcuts cannot approve or cancel the underlying request", async page => {
    await page.getByTestId("composer-input").fill("approval demo");
    await page.getByTestId("send-button").click();
    await page.getByTestId("approval-prompt").waitFor();
    assert.equal(await page.locator(".streaming-indicator, .turn-activity").count(), 0,
      "waiting for approval must not look like an active model response");
    assert.equal(await page.locator(".timeline .spin").count(), 0,
      "expanded process rows must pause their activity when waiting for approval");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "外观", exact: true }).click();
    await page.keyboard.press("1");
    assert.equal(await page.getByTestId("approval-prompt").count(), 1);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "设置", exact: true }).waitFor({ state: "hidden" });
    assert.equal(await page.getByTestId("approval-prompt").count(), 1);
    await page.getByTestId("approval-cancel").click();
    await page.getByTestId("approval-prompt").waitFor({ state: "hidden" });
    assert.equal(await page.locator(".timeline .spin").count(), 0,
      "a completed or cancelled turn must not keep an old thought spinning");
  });
  await check("nested dialogs own focus, Escape and global shortcuts", async page => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "当前配置", exact: true }).click();
    await page.getByRole("button", { name: "切换模型", exact: true }).click();
    const nested = page.getByRole("dialog", { name: "选择对话默认模型", exact: true });
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press(i < 10 ? "Tab" : "Shift+Tab");
      assert.equal(await nested.evaluate(e => e.contains(document.activeElement)), true);
    }
    await page.keyboard.press("Control+n");
    assert.equal(await page.getByTestId("conversation").getAttribute("data-cache-count"), "6");
    await page.keyboard.press("Escape");
    await nested.waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("dialog", { name: "设置", exact: true }).count(), 1);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "设置", exact: true }).waitFor({ state: "hidden" });
  });
  await check("working indicator aligns with the timeline and drafts remain editable", async page => {
    await page.evaluate(async () => {
      const { cleoClient } = await import("/src/services/cleoClient.ts");
      cleoClient.streamTurn = async function* () {
        await new Promise(resolve => { window.finishActivity = resolve; });
        yield { type: "done", summary: "finished" };
      };
    });
    await page.getByTestId("composer-input").fill("start delayed demo");
    await page.getByTestId("send-button").click();
    await page.locator(".turn-activity").waitFor();
    const gap = await page.evaluate(() => {
      const timeline = document.querySelector(".timeline");
      return document.querySelector(".turn-activity").getBoundingClientRect().left
        - timeline.getBoundingClientRect().left - parseFloat(getComputedStyle(timeline).paddingLeft);
    });
    assert(Math.abs(gap) < 2);
    await page.getByTestId("composer-input").fill("next instruction draft");
    await page.evaluate(() => window.finishActivity());
    await page.locator(".turn-activity").waitFor({ state: "hidden" });
    assert.equal(await page.getByTestId("composer-input").inputValue(), "next instruction draft");
  });
  await check("full content keeps Markdown and automatically loads the next part with retry", async page => {
    await page.evaluate(async () => {
      const { cleoClient } = await import("/src/services/cleoClient.ts");
      const original = await cleoClient.loadThread("desktop-ui");
      const text = "# Reader heading\n\n" + "A paragraph to read.\n\n".repeat(500) + "Reader end marker";
      const item = { id: "large", type: "message", role: "assistant", time: "", content: text.slice(0, 300), more: { content: text.length } };
      cleoClient.loadThread = async () => ({ ...original, items: [item], history: { before: "0", after: "0", total: 1, hasBefore: false, hasAfter: false, revision: "1" } });
      window.readerCalls = [];
      let failed = false;
      cleoClient.readTimelineContent = async (_thread, _item, _field, offset) => {
        window.readerCalls.push(offset);
        if (offset && !failed) { failed = true; throw new Error("reader offline"); }
        const part = text.slice(offset, offset + 4096);
        return { text: part, offset, next: offset + part.length, total: text.length };
      };
    });
    await page.getByRole("button", { name: /^完成独立桌面 UI/ }).click();
    await page.getByRole("button", { name: "展开全文", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "完整历史正文" });
    await dialog.getByRole("heading", { name: "Reader heading" }).waitFor();
    assert.equal(await dialog.getByRole("button", { name: /上一段|下一段/ }).count(), 0);
    await dialog.locator(".history-reader-content").evaluate(element => { element.scrollTop = element.scrollHeight; });
    await dialog.getByRole("alert").filter({ hasText: "reader offline" }).waitFor();
    assert.equal(await dialog.getByRole("heading", { name: "Reader heading" }).count(), 1);
    await dialog.getByRole("button", { name: "重试", exact: true }).click();
    await page.waitForFunction(() => window.readerCalls.length === 3);
    await dialog.locator(".history-reader-content").evaluate(element => { element.scrollTop = element.scrollHeight; });
    await dialog.getByText(/Reader end marker/).waitFor({ state: "attached" });
    assert.deepEqual(await page.evaluate(() => window.readerCalls), [0, 4096, 4096, 8192]);
  });
  await check("instruction and connection drafts survive settings navigation", async page => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "对话指令", exact: true }).click();
    const input = page.getByRole("textbox", { name: "对话指令内容" });
    await input.fill("unsaved audit draft");
    await page.getByRole("button", { name: "外观", exact: true }).click();
    await page.getByRole("button", { name: "对话指令", exact: true }).click();
    assert.equal(await input.inputValue(), "unsaved audit draft");
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    assert.equal(await input.inputValue(), "unsaved audit draft");
    await page.getByRole("button", { name: "新增连接", exact: true }).first().click();
    await page.getByRole("button", { name: /OpenAI/ }).click();
    await page.getByLabel("连接名称", { exact: true }).fill("unfinished connection");
    await page.getByRole("button", { name: "外观", exact: true }).click();
    await page.getByRole("button", { name: "新增连接", exact: true }).first().click();
    assert.equal(await page.getByLabel("连接名称", { exact: true }).inputValue(), "unfinished connection");
  });
  await check("model settings failures have a recoverable error", async page => {
    await page.evaluate(async () => {
      const { cleoClient } = await import("/src/services/cleoClient.ts");
      const original = cleoClient.getModelSettings.bind(cleoClient);
      let failed = false;
      cleoClient.getModelSettings = async () => {
        if (!failed) { failed = true; throw new Error("model settings offline"); }
        return original();
      };
    });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "当前配置", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "model settings offline" }).waitFor();
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.getByText("新对话默认模型", { exact: true }).waitFor();
  });
  await check("thread loading errors stay visible and can be retried", async page => {
    await page.evaluate(async () => {
      const { cleoClient } = await import("/src/services/cleoClient.ts");
      const original = cleoClient.loadThread.bind(cleoClient);
      let failed = false;
      cleoClient.loadThread = async id => {
        if (!failed) { failed = true; throw new Error("history offline"); }
        return original(id);
      };
    });
    await page.getByRole("button", { name: /^统一 managed 与 native sessions/ }).click();
    await page.getByRole("alert").filter({ hasText: "history offline" }).waitFor();
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.getByText(/我确认了聚合层按 native id 去重/).waitFor();
    assert.equal(await page.getByRole("alert").filter({ hasText: "history offline" }).count(), 0);
  });
  await check("memory refresh preserves navigation and drafts and rejects stale responses", async page => {
    await page.getByTestId("composer-input").fill("keep my draft");
    await page.evaluate(async () => {
      const { cleoClient } = await import("/src/services/cleoClient.ts");
      const baseline = await cleoClient.loadWorkspace();
      window.memoryReads = [];
      cleoClient.loadMemory = () => new Promise(resolve => {
        window.memoryReads.push(count => resolve({ memories: baseline.memories,
          memoryOverview: { ...baseline.memoryOverview, summary: { ...baseline.memoryOverview.summary, pending_sources: count } } }));
      });
    });
    await page.getByRole("button", { name: "记忆", exact: true }).click();
    await page.waitForFunction(() => window.memoryReads.length === 1);
    await page.getByRole("button", { name: "开发", exact: true }).click();
    assert.equal(await page.getByTestId("composer-input").inputValue(), "keep my draft");
    await page.getByRole("button", { name: "记忆", exact: true }).click();
    await page.evaluate(() => window.memoryReads[0](123));
    await page.waitForFunction(() => window.memoryReads.length === 2);
    assert.doesNotMatch(await page.getByTestId("memory-nav-pending").innerText(), /123/);
    await page.evaluate(() => window.memoryReads[1](17));
    await page.getByTestId("memory-nav-pending").getByText("17", { exact: true }).waitFor();
    await page.getByRole("button", { name: "开发", exact: true }).click();
    assert.equal(await page.getByTestId("composer-input").inputValue(), "keep my draft");
  });
  for (const space of ["开发", "对话"]) await check(`${space} completion refreshes memory without leaving the conversation`, async page => {
    await page.getByRole("button", { name: space, exact: true }).click();
    await page.evaluate(async () => {
      const { cleoClient } = await import("/src/services/cleoClient.ts");
      const baseline = await cleoClient.loadWorkspace();
      window.memoryReadCount = 0;
      cleoClient.loadMemory = async () => { window.memoryReadCount++; return { memories: baseline.memories, memoryOverview: baseline.memoryOverview }; };
    });
    await page.getByTestId("composer-input").fill("complete this demo");
    await page.getByTestId("send-button").click();
    await page.getByTestId("stop-button").waitFor({ state: "hidden" });
    await page.waitForFunction(() => window.memoryReadCount > 0);
    assert.equal(await page.getByTestId("memory-view").count(), 0);
    assert.equal(await page.getByTestId("composer-input").isVisible(), true);
  });
  await check("failed memory refresh retains entries and retries in place", async page => {
    await page.evaluate(async () => {
      const { cleoClient } = await import("/src/services/cleoClient.ts");
      const baseline = await cleoClient.loadWorkspace();
      let failed = false;
      cleoClient.loadMemory = async () => {
        if (!failed) { failed = true; throw new Error("memory unavailable"); }
        return { memories: baseline.memories, memoryOverview: baseline.memoryOverview };
      };
    });
    await page.getByRole("button", { name: "记忆", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "memory unavailable" }).waitFor();
    assert.equal(await page.getByTestId("memory-ledger").locator("article").count(), 4);
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "memory unavailable" }).waitFor({ state: "hidden" });
    assert.equal(await page.getByTestId("memory-ledger").locator("article").count(), 4);
  });
  await check("Claude messages preserve steering chronology", async page => {
    const blocks = await page.evaluate(async () => {
      const { groupTimelineItems } = await import("/src/components/Conversation.tsx");
      return groupTimelineItems([
        { id: "u1", type: "message", role: "user", content: "开始", turnId: "turn" },
        { id: "a1", type: "message", role: "assistant", content: "正在检查", turnId: "turn" },
        { id: "t1", type: "tool", name: "Read", status: "done", turnId: "turn" },
        { id: "u2", type: "message", role: "user", content: "补充要求", turnId: "turn" },
        { id: "t2", type: "tool", name: "Edit", status: "done", turnId: "turn" },
        { id: "a2", type: "message", role: "assistant", content: "已完成", turnId: "turn" },
      ]);
    });
    assert.deepEqual(blocks.map(block => block.id), ["u1", "a1", "tool-group-t1", "u2", "tool-group-t2", "a2"]);
    assert.equal(new Set(blocks.map(block => block.id)).size, blocks.length);
  });
  if (process.env.CLEO_SMOKE_OUTPUT) await mkdir(process.env.CLEO_SMOKE_OUTPUT, { recursive: true });
  assert.deepEqual(failures, []);
} finally {
  await browser?.close();
  await server.close();
  assert.equal(dirname(scratch), resolve(tmpdir()));
  await rm(scratch, { recursive: true, force: true });
}
