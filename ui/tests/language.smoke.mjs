import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "cleo-language-ui-"));
const server = await createServer({ root: ui, cacheDir: join(scratch, "vite"), server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
  const startup = await browser.newPage();
  await startup.addInitScript(() => {
    window.cleoWindow = { language: "en", platform: "win32", setTheme() {}, setBadge() {} };
    window.cleoDesktop = new Proxy({ getUiLanguage: () => new Promise(resolve => { window.finishLanguage = resolve; }) }, {
      get(target, key) {
        if (key in target) return target[key];
        return String(key).startsWith("on") ? () => () => {} : () => new Promise(() => {});
      },
    });
  });
  await startup.goto(server.resolvedUrls.local[0]);
  await startup.getByText("Opening the local workspace", { exact: true }).waitFor();
  assert.equal(await startup.locator("html").getAttribute("lang"), "en");
  await startup.evaluate(() => window.finishLanguage("en"));
  await startup.close();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  page.setDefaultTimeout(8000);
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByTestId("composer-input").fill("保留我的草稿 — do not translate this");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const select = page.getByRole("combobox", { name: "语言", exact: true });
  assert.equal(await select.inputValue(), "zh-CN", "OS locale must not choose the language");
  assert.deepEqual(await select.locator("option").allTextContents(), ["简体中文", "English"]);
  await select.selectOption("en");
  await page.getByRole("heading", { name: "Appearance", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  await page.getByRole("button", { name: "Dark", exact: true }).waitFor();
  await page.evaluate(async () => {
    const { cleoClient } = await import("/src/services/cleoClient.ts");
    window.saveLanguage = cleoClient.setUiLanguage.bind(cleoClient);
    cleoClient.setUiLanguage = async () => { throw new Error("disk full"); };
  });
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("zh-CN");
  await page.getByRole("alert").filter({ hasText: "disk full" }).waitFor();
  assert.equal(await page.getByRole("combobox", { name: "Language", exact: true }).inputValue(), "en");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  assert.equal(await page.getByTestId("composer-input").inputValue(), "保留我的草稿 — do not translate this");
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  assert.equal(await page.getByRole("combobox", { name: "Language", exact: true }).inputValue(), "en");
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("zh-CN");
  await page.getByRole("heading", { name: "外观", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.getByTestId("composer-input").fill("approval demo 保留用户原文");
  await page.getByTestId("send-button").click();
  await page.getByTestId("approval-prompt").waitFor();
  await page.getByTestId("composer-input").fill("下一条草稿不应丢失");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("combobox", { name: "语言", exact: true }).selectOption("en");
  await page.getByRole("combobox", { name: "Language", exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('select[aria-label="Language"]').disabled);
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  assert.equal(await page.getByTestId("composer-input").inputValue(), "下一条草稿不应丢失");
  await page.getByTestId("approval-prompt").waitFor();
  assert.match(await page.locator(".conversation-viewport").textContent(), /保留用户原文/);
  await page.getByTestId("approval-cancel").click();
  await page.getByTestId("approval-prompt").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.setViewportSize({ width: 980, height: 800 });
  assert.equal(await page.locator(".settings-modal").evaluate(node => node.scrollWidth <= node.clientWidth + 2), true);
  if (process.env.CLEO_SMOKE_OUTPUT) await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "language-en.png") });
  console.log("PASS: explicit language choice, live switching, draft preservation, restart persistence, and save failure");
} finally {
  await browser?.close(); await server.close();
  await rm(scratch, { recursive: true, force: true });
}
