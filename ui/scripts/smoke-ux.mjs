import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { snapshot } from "../src/services/mockData.ts";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(appDir, "output", "playwright", "ux");
await mkdir(outputDir, { recursive: true });
const app = await electron.launch({ args: ["."], cwd: appDir, env: { ...process.env, CLEO_DESKTOP_MOCK: "1" } });
const page = await app.firstWindow();
page.setDefaultTimeout(4000);
const results = [];
const input = page.getByTestId("composer-input");
const rail = (name) => page.getByRole("button", { name, exact: true });

async function check(name, run) {
  await page.reload();
  await page.getByTestId("conversation").waitFor({ timeout: 15000 });
  try {
    await run();
    results.push({ name, status: "passed" });
  } catch (error) {
    results.push({ name, status: "failed", error: error.message });
  }
  await page.screenshot({ path: join(outputDir, `${name}.png`) });
}

try {
  await check("native-titlebar-theme", async () => {
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const applyOverlay = window.setTitleBarOverlay.bind(window);
      window.setTitleBarOverlay = (options) => {
        applyOverlay(options);
        globalThis.uxTitleBarOverlay = options;
      };
    });
    await page.evaluate(() => localStorage.setItem("cleo-theme", "dark"));
    await page.reload();
    await page.getByTestId("conversation").waitFor();
    await rail("设置").click();
    for (const [label, color, symbolColor] of [
      ["雾白", "#e9e9e6", "#59636f"],
      ["夜色", "#0b0e12", "#848c98"],
      ["雾白", "#e9e9e6", "#59636f"],
    ]) {
      await rail(label).click();
      await page.waitForFunction(() => window.cleoWindow !== undefined);
      await app.evaluate(() => new Promise((resolve) => setImmediate(resolve)));
      assert.deepEqual(await app.evaluate(() => globalThis.uxTitleBarOverlay), { color, symbolColor });
    }
    await app.evaluate(() => { globalThis.uxTitleBarOverlay = null; });
    await page.reload();
    await page.getByTestId("conversation").waitFor();
    assert.equal((await app.evaluate(() => globalThis.uxTitleBarOverlay))?.color, "#e9e9e6", "Saved light theme must restore native controls");
    await rail("设置").click();
    await rail("夜色").click();
    await page.keyboard.press("Escape");
  });
  await check("chat-welcome", async () => {
    await rail("对话").click();
    await page.getByTestId("new-thread").click();
    await page.getByRole("heading", { name: "今天想聊些什么？" }).waitFor();
    await page.locator(".suggestion-list button").first().click();
    assert.ok((await input.inputValue()).length > 0, "Suggestion should populate an editable draft");
    assert.equal(await page.getByTestId("stop-button").count(), 0);
    assert.equal(await page.getByTestId("effort-selector").count(), 0);
    await rail("运行记录").click();
    await page.locator(".run-status").getByText("尚未运行", { exact: true }).waitFor();
  });
  await check("command-keyboard", async () => {
    await page.keyboard.press("Control+k");
    const search = page.locator(".command-search input");
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
  await check("rename-dialog", async () => {
    await page.locator(".thread-actions-wrap > button").click();
    await rail("重命名").click();
    const dialog = page.getByRole("dialog", { name: "重命名任务" });
    await dialog.waitFor();
    await dialog.getByRole("textbox").fill("   ");
    assert.equal(await dialog.getByRole("button", { name: "保存", exact: true }).isDisabled(), true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  });
  await check("draft-isolation", async () => {
    await input.fill("只属于开发任务的草稿");
    await input.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["draft attachment"], "draft.txt", { type: "text/plain" }));
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
    });
    await page.locator(".attachment-chip").first().waitFor();
    await rail("对话").click();
    assert.equal(await input.inputValue(), "");
    assert.equal(await page.locator(".attachment-chip").count(), 0);
    await input.fill("只属于对话的草稿");
    await rail("记忆").click();
    await rail("对话").click();
    assert.equal(await input.inputValue(), "只属于对话的草稿");
    await rail("开发").click();
    assert.equal(await input.inputValue(), "只属于开发任务的草稿");
    assert.equal(await page.locator(".attachment-chip").count(), 1);
    await page.getByTestId("new-thread").click();
    assert.equal(await input.inputValue(), "");
    assert.equal(await page.locator(".attachment-chip").count(), 0);
  });
  await check("busy-send-preserves-draft", async () => {
    await input.fill("正在运行的测试");
    await input.press("Enter");
    await page.getByTestId("stop-button").waitFor();
    await rail("对话").click();
    await input.fill("等待发送的草稿");
    await input.press("Enter");
    assert.equal(await input.inputValue(), "等待发送的草稿");
    await page.getByText("另一个任务正在运行，完成或停止后即可发送。", { exact: true }).waitFor();
  });
  await check("ime-enter", async () => {
    await input.fill("还在选字");
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    assert.equal(await input.inputValue(), "还在选字");
    assert.equal(await page.getByTestId("stop-button").count(), 0);
  });
  await check("model-checkbox-layout", async () => {
    await rail("设置").click();
    await rail("模型").click();
    const box = await page.locator(".model-profile-roles input").first().boundingBox();
    assert.ok(box && box.width <= 20 && box.height <= 20, `Checkbox is oversized: ${JSON.stringify(box)}`);
  });
  await check("motion-setting", async () => {
    await rail("设置").click();
    await page.getByRole("checkbox", { name: "动态效果" }).uncheck();
    await page.reload();
    await page.getByTestId("conversation").waitFor();
    assert.equal(await page.locator("html").getAttribute("data-motion"), "reduced");
    await rail("设置").click();
    assert.equal(await page.getByRole("checkbox", { name: "动态效果" }).isChecked(), false);
    await page.getByRole("checkbox", { name: "动态效果" }).check();
  });
  // Exercise the production IPC client with a controllable create boundary.
  await page.addInitScript((fixture) => {
    const listeners = new Set();
    const workspace = { ...fixture, threads: [], activeThreadId: null, activeSpace: "chat" };
    const ux = window.__ux = { creates: 0, sent: [], failCreate: false, releaseCreate: null };
    window.cleoDesktop = {
      getUpdateState: async () => ({ phase: "unsupported", currentVersion: "test" }),
      onUpdateState: () => () => {},
      onStreamEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      request: async (method, params, streamId) => {
        if (method === "load_workspace") return structuredClone(workspace);
        if (method === "get_runtime_catalog") return {
          nonProductivityProfiles: [{ id: "test", provider: "openai", model: "test", maxTokens: 100000, active: true }],
          productivityProviders: [], defaultNonProductivityProfile: "test", defaultProductivityProvider: "",
        };
        if (method === "create_thread") {
          ux.creates += 1;
          await new Promise((resolve) => { ux.releaseCreate = resolve; });
          if (ux.failCreate) throw new Error("模拟创建失败");
          const thread = {
            id: "created-chat", space: "chat", projectId: "general", title: "新对话", summary: "", updatedAt: "刚刚", status: "idle", items: [], changes: [],
            usage: { used: 0, limit: 100000, input: 0, output: 0 }, runtime: workspace.runtime,
          };
          workspace.threads.push(thread);
          return structuredClone(thread);
        }
        if (method === "stream_turn") {
          ux.sent.push(params);
          listeners.forEach((listener) => listener({ streamId, event: { type: "done", summary: "完成" } }));
          return {};
        }
        throw new Error(`Unexpected test request: ${method}`);
      },
    };
  }, snapshot);
  await check("create-failure-retains-draft", async () => {
    await input.fill("创建失败也应保留这段输入");
    await page.evaluate(() => { window.__ux.failCreate = true; });
    await input.press("Enter");
    await page.waitForFunction(() => window.__ux.releaseCreate !== null);
    await page.evaluate(() => window.__ux.releaseCreate());
    await page.getByRole("alert").getByText("模拟创建失败", { exact: true }).waitFor();
    assert.equal(await input.inputValue(), "创建失败也应保留这段输入");
    assert.equal(await page.getByTestId("send-button").isEnabled(), true);
  });
  await check("pending-create-navigation", async () => {
    await input.fill("只能发送一次");
    await input.evaluate((element) => {
      for (let index = 0; index < 2; index += 1) element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => window.__ux.releaseCreate !== null);
    await rail("记忆").click();
    await page.evaluate(() => window.__ux.releaseCreate());
    await page.waitForFunction(() => window.__ux.sent.length === 1);
    assert.equal(await page.evaluate(() => window.__ux.creates), 1);
    await page.getByTestId("memory-view").waitFor();
  });
  console.log(JSON.stringify(results, null, 2));
  if (results.some((result) => result.status === "failed")) process.exitCode = 1;
} finally {
  await app.close();
}
