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
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "外观", exact: true }).click();
    await page.keyboard.press("1");
    assert.equal(await page.getByTestId("approval-prompt").count(), 1);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "设置", exact: true }).waitFor({ state: "hidden" });
    assert.equal(await page.getByTestId("approval-prompt").count(), 1);
    await page.getByTestId("approval-cancel").click();
    await page.getByTestId("approval-prompt").waitFor({ state: "hidden" });
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
    await page.getByRole("button", { name: "Agent 指令", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Non-productivity Agent 指令" });
    await input.fill("unsaved audit draft");
    await page.getByRole("button", { name: "外观", exact: true }).click();
    await page.getByRole("button", { name: "Agent 指令", exact: true }).click();
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
    await page.getByText("默认对话模型", { exact: true }).waitFor();
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
  if (process.env.CLEO_SMOKE_OUTPUT) await mkdir(process.env.CLEO_SMOKE_OUTPUT, { recursive: true });
  assert.deepEqual(failures, []);
} finally {
  await browser?.close();
  await server.close();
  assert.equal(dirname(scratch), resolve(tmpdir()));
  await rm(scratch, { recursive: true, force: true });
}
