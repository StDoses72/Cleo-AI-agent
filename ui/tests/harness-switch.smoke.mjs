/** Automated UI checks with controlled mock harnesses; no live Cleo process or profile. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER
    || (existsSync(macChrome) ? macChrome : undefined), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByTestId("runtime-selector").waitFor();
  await page.evaluate(async () => {
    const { cleoClient } = await import("/src/services/cleoClient.ts");
    const { snapshot } = await import("/src/services/mockData.ts");
    window.harnessFixture = { calls: [], created: 0, snapshot };
    const create = cleoClient.createThread.bind(cleoClient);
    cleoClient.createThread = (...args) => { window.harnessFixture.created++; return create(...args); };
    const original = cleoClient.switchHarness.bind(cleoClient);
    cleoClient.switchHarness = async (...args) => {
      window.harnessFixture.calls.push(args);
      await new Promise((resolve, reject) => { Object.assign(window.harnessFixture, { resolve, reject }); });
      return original(...args);
    };
    cleoClient.streamTurn = async function* (threadId, prompt) {
      window.harnessFixture.sent = [threadId, prompt];
      yield { type: "upsert-item", item: { id: "mock-turn", type: "message", role: "assistant", content: "Original turn result", time: "" } };
      await new Promise(resolve => { window.harnessFixture.finishTurn = resolve; });
      yield { type: "done", summary: "Original turn complete" };
    };
  });
  const input = page.locator("textarea").first();
  const selected = await page.locator(".thread-row.active").innerText();
  const originalRuntime = await page.getByTestId("runtime-selector").innerText();
  const choose = async () => {
    await page.getByTestId("runtime-selector").click();
    await page.getByTestId("runtime-menu").getByRole("button", { name: /^claude/ }).click();
    await page.getByRole("button", { name: /Claude Opus 5/ }).click();
  };
  await input.fill("Unsent constraint: keep the draft");
  await choose();
  await page.getByRole("status").filter({ hasText: /正在连接 claude/ }).waitFor();
  assert.equal(await page.locator(".thread-row.active").innerText(), selected);
  assert.equal(await input.inputValue(), "Unsent constraint: keep the draft");
  assert.equal(await page.getByTestId("runtime-selector").innerText(), originalRuntime);
  assert.equal(await page.getByTestId("runtime-selector").isEnabled(), false);
  await page.evaluate(() => window.harnessFixture.reject(new Error("Harness login failed")));
  await page.getByRole("alert").filter({ hasText: "Harness login failed" }).waitFor();
  assert.equal(await page.getByTestId("runtime-selector").innerText(), originalRuntime);
  assert.equal(await input.inputValue(), "Unsent constraint: keep the draft");
  // Queue a switch while an original turn is still running.
  await input.fill("Finish the original step");
  await input.press("Enter");
  await page.waitForFunction(() => Boolean(window.harnessFixture.finishTurn));
  assert.equal(await page.getByTestId("runtime-selector").isEnabled(), true);
  await choose();
  await page.getByRole("status").filter({ hasText: /等待当前轮结束/ }).waitFor();
  await page.evaluate(() => window.harnessFixture.finishTurn());
  await page.getByRole("status").filter({ hasText: /正在连接 claude/ }).waitFor();
  await page.evaluate(() => window.harnessFixture.resolve());
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-selector"]')?.textContent.includes("claude · claude-opus-5"));
  assert.equal(await page.locator(".thread-row.active").innerText().then(t => t.split("\n")[0]), selected.split("\n")[0]);
  const result = await page.evaluate(() => ({ calls: window.harnessFixture.calls, created: window.harnessFixture.created, sent: window.harnessFixture.sent }));
  assert.equal(result.created, 0);
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0][0], result.calls[1][0]);
  assert.equal(result.sent[0], result.calls[0][0]);
  assert.deepEqual(errors, []);
  console.log("PASS: picker failure/retry, running-turn wait, same thread, unsent draft, no new task (mock UI)");
} finally {
  await browser?.close();
  await server.close();
}
