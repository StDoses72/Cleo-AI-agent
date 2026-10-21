/** Automated UI checks with controlled mock harnesses; no live Cleo process or profile.
 * Picking a harness only records the choice; the handoff happens when the next message is sent. */
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
    window.harnessFixture = { calls: [], created: 0, sent: [], deliveredAttachments: [], updates: [], snapshot };
    const update = cleoClient.updateRuntime.bind(cleoClient);
    cleoClient.updateRuntime = async (...args) => {
      window.harnessFixture.updates.push(args);
      if (window.harnessFixture.failUpdate) {
        window.harnessFixture.failUpdate = false;
        throw new Error("Runtime update rejected");
      }
      if (window.harnessFixture.holdUpdate) {
        await new Promise(resolve => { window.harnessFixture.finishUpdate = resolve; });
      }
      return update(...args);
    };
    cleoClient.pickAttachments = async () => [{ name: "queued.txt", path: "mock-attachment://queued.txt",
      mimeType: "text/plain", size: 12 }];
    const create = cleoClient.createThread.bind(cleoClient);
    cleoClient.createThread = (...args) => { window.harnessFixture.created++; return create(...args); };
    const original = cleoClient.switchHarness.bind(cleoClient);
    cleoClient.switchHarness = async (...args) => {
      window.harnessFixture.calls.push(args);
      await new Promise((resolve, reject) => { Object.assign(window.harnessFixture, { resolve, reject }); });
      return original(...args);
    };
    cleoClient.streamTurn = async function* (threadId, prompt, attachments) {
      window.harnessFixture.sent.push([threadId, prompt]);
      window.harnessFixture.deliveredAttachments.push(attachments);
      yield { type: "upsert-item", item: { id: `mock-turn-${window.harnessFixture.sent.length}`, type: "message", role: "assistant", content: "Turn result", time: "" } };
      await new Promise(resolve => { window.harnessFixture.finishTurn = resolve; });
      window.harnessFixture.finishTurn = null;
      yield { type: "done", summary: "Turn complete" };
    };
  });
  const input = page.locator("textarea").first();
  const selected = await page.locator(".thread-row.active").innerText();
  const trigger = page.getByTestId("runtime-selector");
  // The pill's first line is "harness · model"; effort and speed follow once models load.
  const pillModel = () => trigger.locator("span").first().innerText();
  const originalRuntime = await pillModel();
  const fixture = () => page.evaluate(() => ({ calls: window.harnessFixture.calls.length,
    created: window.harnessFixture.created, sent: window.harnessFixture.sent }));
  const choose = async (provider, model) => {
    await trigger.click();
    await page.getByTestId("runtime-model-row").click();
    await page.getByTestId("runtime-menu").getByRole("button", { name: provider }).click();
    await page.getByRole("button", { name: model }).click();
    // The menu returns to the settings card after a model is picked; dismiss it.
    await page.keyboard.press("Escape");
    await page.getByTestId("runtime-menu").waitFor({ state: "detached" });
  };
  const pending = page.getByTestId("harness-pending");

  // Picking a harness shows the pick, hands nothing off and leaves the draft alone.
  await input.fill("Unsent constraint: keep the draft");
  await choose(/^claude/, /Claude Opus 5/);
  await pending.waitFor();
  assert.equal(await pillModel(), "claude · claude-opus-5");
  assert.equal(await trigger.getAttribute("data-pending-switch"), "true");
  assert.equal(await trigger.isEnabled(), true);
  assert.equal(await input.inputValue(), "Unsent constraint: keep the draft");
  assert.equal(await page.locator(".thread-row.active").innerText(), selected);
  assert.equal((await fixture()).calls, 0);

  // Picking the live harness back cancels the pick without a handoff.
  await choose(/^codex/, /GPT-5.6-Sol/);
  await pending.waitFor({ state: "detached" });
  assert.equal(await pillModel(), originalRuntime);
  assert.equal(await trigger.getAttribute("data-pending-switch"), null);
  assert.equal((await fixture()).calls, 0);

  // Sending with a pick hands off first; a failed handoff keeps the draft and the live harness.
  await choose(/^claude/, /Claude Opus 5/);
  await input.press("Enter");
  await page.getByRole("status").filter({ hasText: /正在连接 claude/ }).waitFor();
  assert.equal(await trigger.isEnabled(), false);
  await page.evaluate(() => window.harnessFixture.reject(new Error("Harness login failed")));
  await page.getByRole("alert").filter({ hasText: "Harness login failed" }).waitFor();
  assert.equal(await pillModel(), originalRuntime);
  assert.equal(await input.inputValue(), "Unsent constraint: keep the draft");
  assert.equal(await pending.count(), 0);
  assert.deepEqual(await fixture(), { calls: 1, created: 0, sent: [] });

  // Pick again and send: exactly one handoff, then the message streams on the same task.
  await choose(/^claude/, /Claude Opus 5/);
  await input.press("Enter");
  await page.getByRole("status").filter({ hasText: /正在连接 claude/ }).waitFor();
  await page.evaluate(() => window.harnessFixture.resolve());
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-selector"]')?.textContent.includes("claude · claude-opus-5"));
  await page.waitForFunction(() => Boolean(window.harnessFixture.finishTurn));
  assert.equal(await pending.count(), 0);
  assert.equal(await input.inputValue(), "");
  let state = await fixture();
  assert.equal(state.calls, 2);
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0][1], "Unsent constraint: keep the draft");

  // A pick during a running turn waits too; the queued message hands off once the turn ends.
  await choose(/^codex/, /GPT-5.6-Terra/);
  await pending.waitFor();
  assert.equal(await pillModel(), "codex · gpt-5.6-terra");
  assert.equal((await fixture()).calls, 2);
  await input.fill("Finish the next step on codex");
  await input.press("Enter");
  await page.getByTestId("queue-button").waitFor({ state: "detached" }).catch(() => {});
  assert.equal((await fixture()).calls, 2);
  await page.evaluate(() => window.harnessFixture.finishTurn());
  await page.getByRole("status").filter({ hasText: /正在连接 codex/ }).waitFor();
  await page.evaluate(() => window.harnessFixture.resolve());
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-selector"]')?.textContent.includes("codex · gpt-5.6-terra"));
  await page.waitForFunction(() => Boolean(window.harnessFixture.finishTurn));
  await page.evaluate(() => window.harnessFixture.finishTurn());
  state = await fixture();
  assert.equal(state.created, 0);
  assert.equal(state.calls, 3);
  assert.ok(state.calls.length === undefined);
  const calls = await page.evaluate(() => window.harnessFixture.calls);
  assert.deepEqual(calls.map(call => call[0]), [calls[0][0], calls[0][0], calls[0][0]]);
  assert.deepEqual(calls.map(call => call.slice(1, 3)), [["claude", "claude-opus-5"], ["claude", "claude-opus-5"], ["codex", "gpt-5.6-terra"]]);
  assert.deepEqual(state.sent.map(turn => turn[0]), [calls[0][0], calls[0][0]]);
  assert.equal(state.sent[1][1], "Finish the next step on codex");
  assert.equal(await page.locator(".thread-row.active").innerText().then(t => t.split("\n")[0]), selected.split("\n")[0]);

  // Both automatic and manual queue delivery retain text and attachments when handoff fails.
  await page.waitForFunction(() => !window.harnessFixture.finishTurn);
  await input.fill("Original turn before failed queued handoff");
  await input.press("Enter");
  await page.waitForFunction(() => Boolean(window.harnessFixture.finishTurn));
  await choose(/^claude/, /Claude Opus 5/);
  await page.getByRole("button", { name: "添加附件", exact: true }).click();
  await input.fill("Queued text must survive handoff failure");
  await input.press("Enter");
  const queue = page.getByTestId("queued-messages");
  await queue.waitFor();
  await input.fill("Independent unsent draft");
  const sentBeforeFailure = (await fixture()).sent.length;
  await page.evaluate(() => window.harnessFixture.finishTurn());
  await page.getByRole("status").filter({ hasText: /正在连接 claude/ }).waitFor();
  await page.evaluate(() => window.harnessFixture.reject(new Error("Queued handoff failed")));
  await page.getByRole("alert").filter({ hasText: "Queued handoff failed" }).waitFor();
  await queue.waitFor();
  assert.equal(await queue.locator(".queued-text").innerText(), "Queued text must survive handoff failure");
  assert.equal(await queue.locator(".queued-attachments").innerText(), "1");
  assert.equal(await input.inputValue(), "Independent unsent draft");
  assert.equal((await fixture()).sent.length, sentBeforeFailure);
  await choose(/^claude/, /Claude Opus 5/);
  await queue.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("status").filter({ hasText: /正在连接 claude/ }).waitFor();
  await page.evaluate(() => window.harnessFixture.reject(new Error("Manual queued handoff failed")));
  await page.getByRole("alert").filter({ hasText: "Manual queued handoff failed" }).waitFor();
  await queue.waitFor();
  assert.equal(await queue.locator("li").count(), 1);
  assert.equal(await queue.locator(".queued-attachments").innerText(), "1");
  await queue.getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForFunction(() => Boolean(window.harnessFixture.finishTurn));
  assert.equal(await queue.count(), 0);
  assert.equal((await fixture()).sent.at(-1)[1], "Queued text must survive handoff failure");
  assert.equal(await page.evaluate(() => window.harnessFixture.deliveredAttachments.at(-1)[0].path), "mock-attachment://queued.txt");
  assert.equal(await input.inputValue(), "Independent unsent draft");
  await page.evaluate(() => window.harnessFixture.finishTurn());
  await page.waitForFunction(() => !window.harnessFixture.finishTurn);

  // Same-provider model changes preserve Fast, and an explicit standard-speed pick is applied.
  await trigger.click();
  await page.getByTestId("speed-toggle").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-selector"]').dataset.speed === "fast");
  await page.keyboard.press("Escape");
  await choose(/^codex/, /GPT-5.6-Sol/);
  assert.equal(await trigger.getAttribute("data-speed"), "fast");
  await input.fill("Keep Fast on the new model");
  await input.press("Enter");
  await page.getByRole("status").filter({ hasText: /正在连接 codex/ }).waitFor();
  await page.evaluate(() => window.harnessFixture.resolve());
  await page.waitForFunction(() => Boolean(window.harnessFixture.finishTurn));
  assert.equal(await trigger.getAttribute("data-speed"), "fast");
  await page.evaluate(() => window.harnessFixture.finishTurn());
  await page.waitForFunction(() => !window.harnessFixture.finishTurn);
  await choose(/^codex/, /GPT-5.6-Terra/);
  await trigger.click();
  await page.getByTestId("speed-toggle").click();
  assert.equal(await trigger.getAttribute("data-speed"), "default");
  await page.keyboard.press("Escape");
  await input.fill("Use standard speed on the new model");
  await input.press("Enter");
  await page.getByRole("status").filter({ hasText: /正在连接 codex/ }).waitFor();
  await page.evaluate(() => window.harnessFixture.resolve());
  await page.waitForFunction(() => Boolean(window.harnessFixture.finishTurn));
  assert.equal(await trigger.getAttribute("data-speed"), "default");
  await page.evaluate(() => window.harnessFixture.finishTurn());
  await page.waitForFunction(() => !window.harnessFixture.finishTurn);

  // If the speed update fails after the model changed, keep the draft and report the live runtime.
  await trigger.click();
  await page.getByTestId("speed-toggle").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-selector"]').dataset.speed === "fast");
  await page.keyboard.press("Escape");
  await choose(/^codex/, /GPT-5.6-Sol/);
  await trigger.click();
  await page.getByTestId("speed-toggle").click();
  await page.keyboard.press("Escape");
  await page.evaluate(() => { window.harnessFixture.failUpdate = true; });
  const sentBeforeSpeedFailure = (await fixture()).sent.length;
  await input.fill("Keep this draft if standard speed cannot be applied");
  await input.press("Enter");
  await page.getByRole("status").filter({ hasText: /正在连接 codex/ }).waitFor();
  await page.evaluate(() => window.harnessFixture.resolve());
  await page.getByRole("alert").filter({ hasText: "Runtime update rejected" }).waitFor();
  assert.equal((await fixture()).sent.length, sentBeforeSpeedFailure);
  assert.equal(await input.inputValue(), "Keep this draft if standard speed cannot be applied");
  assert.equal(await pillModel(), "codex · gpt-5.6-sol");
  assert.equal(await trigger.getAttribute("data-speed"), "fast");
  await trigger.click();
  await page.getByTestId("speed-toggle").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-selector"]').dataset.speed === "default");
  await page.keyboard.press("Escape");
  await input.press("Enter");
  await page.waitForFunction(() => Boolean(window.harnessFixture.finishTurn));
  await page.evaluate(() => window.harnessFixture.finishTurn());
  await page.waitForFunction(() => !window.harnessFixture.finishTurn);

  // A rejected effort update rolls the preview back and can be retried with the same value.
  await page.evaluate(() => { window.harnessFixture.failUpdate = true; });
  await trigger.click();
  const effort = page.getByTestId("effort-selector");
  const originalEffort = await effort.getAttribute("data-value");
  await effort.focus();
  await page.keyboard.press("End");
  await page.getByRole("alert").filter({ hasText: "Runtime update rejected" }).waitFor();
  await page.waitForFunction(value => document.querySelector('[data-testid="effort-selector"]').dataset.value === value, originalEffort);
  assert.equal(await trigger.getAttribute("data-effort"), originalEffort);
  await page.evaluate(() => { window.harnessFixture.holdUpdate = true; });
  await effort.focus();
  await page.keyboard.press("End");
  await page.waitForFunction(() => Boolean(window.harnessFixture.finishUpdate));
  assert.equal(await effort.getAttribute("data-value"), "ultra");
  assert.equal(await trigger.getAttribute("data-effort"), originalEffort);
  await page.evaluate(() => { window.harnessFixture.holdUpdate = false; window.harnessFixture.finishUpdate(); });
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-selector"]').dataset.effort === "ultra");
  assert.equal(await effort.getAttribute("data-value"), "ultra");

  // Pointer dragging still previews locally, commits once on release and waits for acknowledgment.
  const updatesBeforeDrag = await page.evaluate(() => window.harnessFixture.updates.length);
  await page.evaluate(() => { window.harnessFixture.holdUpdate = true; window.harnessFixture.finishUpdate = null; });
  const slider = await effort.boundingBox();
  await page.mouse.move(slider.x + slider.width - 2, slider.y + slider.height / 2);
  await page.mouse.down();
  await page.mouse.move(slider.x + 2, slider.y + slider.height / 2, { steps: 10 });
  assert.equal(await effort.getAttribute("data-value"), "low");
  assert.equal(await page.evaluate(() => window.harnessFixture.updates.length), updatesBeforeDrag);
  await page.mouse.up();
  await page.waitForFunction(() => Boolean(window.harnessFixture.finishUpdate));
  assert.equal(await page.evaluate(() => window.harnessFixture.updates.length), updatesBeforeDrag + 1);
  assert.equal(await effort.getAttribute("data-value"), "low");
  assert.equal(await trigger.getAttribute("data-effort"), "ultra");
  await page.evaluate(() => { window.harnessFixture.holdUpdate = false; window.harnessFixture.finishUpdate(); });
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-selector"]').dataset.effort === "low");
  assert.deepEqual(errors, []);
  console.log("PASS: deferred handoff, queue failure/retry with attachments, same-provider speed, effort failure/retry (mock UI)");
} finally {
  await browser?.close();
  await server.close();
}
