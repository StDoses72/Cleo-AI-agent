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
    // Stop is accepted at once; the test then lets the held mock stream run out.
    cleoClient.cancelRun = async () => true;
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
  const menu = page.getByTestId("runtime-menu");
  // The model chip reads "harness · model name"; the name replaces the id once the models load.
  const pillModel = () => trigger.locator("span").first().innerText();
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-selector"]')?.textContent.includes("codex · GPT-5.6-Sol"));
  const originalRuntime = await pillModel();
  const fixture = () => page.evaluate(() => ({ calls: window.harnessFixture.calls.length,
    created: window.harnessFixture.created, sent: window.harnessFixture.sent }));
  // The menu opens on the current harness's models; its heading leads to the harness list, a
  // harness leads to its models, and picking a model closes the menu.
  const choose = async (provider, model) => {
    await trigger.click();
    await menu.getByTestId("runtime-harness-back").click();
    await menu.locator('[data-testid="runtime-harness"][data-connection="connected"]').filter({ hasText: provider }).click();
    await menu.getByTestId("runtime-model").filter({ hasText: model }).click();
    await menu.waitFor({ state: "detached" });
  };
  // Effort is a chip of its own; its menu lists the levels and holds the fast-mode switch.
  const effort = page.getByTestId("effort-selector");
  const effortMenu = page.getByTestId("effort-menu");
  const closeEffortMenu = async () => {
    await page.keyboard.press("Escape");
    await effortMenu.waitFor({ state: "detached" });
  };
  const toggleSpeed = async () => {
    await effort.click();
    await effortMenu.getByTestId("speed-toggle").click();
  };
  const pickEffort = async level => {
    const levels = JSON.parse(await effort.getAttribute("data-options"));
    await effort.click();
    await effortMenu.getByRole("menuitemradio").nth(levels.indexOf(level)).click();
    await effortMenu.waitFor({ state: "detached" });
  };
  // A pending pick is marked on the chip itself; no sentence about it is shown.
  const pending = page.locator('[data-testid="runtime-selector"][data-pending-switch="true"]');

  // Picking a harness shows the pick, hands nothing off and leaves the draft alone.
  await input.fill("Unsent constraint: keep the draft");
  await choose(/^claude/, /Claude Opus 5/);
  await pending.waitFor();
  assert.equal(await page.getByTestId("harness-pending").count(), 0);
  assert.equal(await pillModel(), "claude · Claude Opus 5");
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
  await page.getByRole("status").filter({ hasText: /正在交接到 claude/ }).waitFor();
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
  await page.getByRole("status").filter({ hasText: /正在交接到 claude/ }).waitFor();
  await page.evaluate(() => window.harnessFixture.resolve());
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-selector"]')?.textContent.includes("claude · Claude Opus 5"));
  await page.waitForFunction(() => Boolean(window.harnessFixture.finishTurn));
  assert.equal(await pending.count(), 0);
  assert.equal(await input.inputValue(), "");
  let state = await fixture();
  assert.equal(state.calls, 2);
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0][1], "Unsent constraint: keep the draft");

  // While a turn runs its models are listed but cannot be picked, and nothing is handed off.
  await trigger.click();
  await menu.getByTestId("runtime-model").first().waitFor();
  assert.equal(await menu.locator('[data-testid="runtime-model"]:not(:disabled)').count(), 0,
    "A model must not be picked while a turn is running");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  assert.equal(await pending.count(), 0);
  assert.equal((await fixture()).calls, 2);
  await page.evaluate(() => window.harnessFixture.finishTurn());
  await page.waitForFunction(() => !window.harnessFixture.finishTurn);

  // A pick after the turn waits for the next message, which hands off on the same task.
  await choose(/^codex/, /GPT-5.6-Terra/);
  await pending.waitFor();
  assert.equal(await pillModel(), "codex · GPT-5.6-Terra");
  assert.equal((await fixture()).calls, 2);
  await input.fill("Finish the next step on codex");
  await input.press("Enter");
  await page.getByRole("status").filter({ hasText: /正在交接到 codex/ }).waitFor();
  await page.evaluate(() => window.harnessFixture.resolve());
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-selector"]')?.textContent.includes("codex · GPT-5.6-Terra"));
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

  // Queue delivery retains text and attachments when its handoff fails, however often it is retried.
  // A harness cannot be picked during the run, so the queued message is kept by stopping the turn
  // and is sent by hand once a harness is picked.
  await page.waitForFunction(() => !window.harnessFixture.finishTurn);
  await input.fill("Original turn before failed queued handoff");
  await input.press("Enter");
  await page.waitForFunction(() => Boolean(window.harnessFixture.finishTurn));
  await page.getByRole("button", { name: "添加附件", exact: true }).click();
  await input.fill("Queued text must survive handoff failure");
  await input.press("Enter");
  const queue = page.getByTestId("queued-messages");
  await queue.waitFor();
  await input.fill("Independent unsent draft");
  const sentBeforeFailure = (await fixture()).sent.length;
  await page.getByTestId("stop-button").click();
  await page.getByTestId("stop-button").waitFor({ state: "detached" });
  await page.evaluate(() => window.harnessFixture.finishTurn());
  await page.waitForFunction(() => !window.harnessFixture.finishTurn);
  await queue.waitFor();
  assert.equal((await fixture()).sent.length, sentBeforeFailure, "A stopped turn must not deliver its queue");
  await choose(/^claude/, /Claude Opus 5/);
  await queue.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("status").filter({ hasText: /正在交接到 claude/ }).waitFor();
  await page.evaluate(() => window.harnessFixture.reject(new Error("Queued handoff failed")));
  await page.getByRole("alert").filter({ hasText: "Queued handoff failed" }).waitFor();
  await queue.waitFor();
  assert.equal(await queue.locator(".queued-text").innerText(), "Queued text must survive handoff failure");
  assert.equal(await queue.locator(".queued-attachments").innerText(), "1");
  assert.equal(await input.inputValue(), "Independent unsent draft");
  assert.equal((await fixture()).sent.length, sentBeforeFailure);
  await choose(/^claude/, /Claude Opus 5/);
  await queue.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("status").filter({ hasText: /正在交接到 claude/ }).waitFor();
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
  await toggleSpeed();
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-selector"]').dataset.speed === "fast");
  assert.equal(await effortMenu.getByTestId("speed-toggle").isChecked(), true);
  await closeEffortMenu();
  await choose(/^codex/, /GPT-5.6-Sol/);
  assert.equal(await trigger.getAttribute("data-speed"), "fast");
  await input.fill("Keep Fast on the new model");
  await input.press("Enter");
  await page.getByRole("status").filter({ hasText: /正在交接到 codex/ }).waitFor();
  await page.evaluate(() => window.harnessFixture.resolve());
  await page.waitForFunction(() => Boolean(window.harnessFixture.finishTurn));
  assert.equal(await trigger.getAttribute("data-speed"), "fast");
  await page.evaluate(() => window.harnessFixture.finishTurn());
  await page.waitForFunction(() => !window.harnessFixture.finishTurn);
  await choose(/^codex/, /GPT-5.6-Terra/);
  await toggleSpeed();
  assert.equal(await trigger.getAttribute("data-speed"), "default");
  await closeEffortMenu();
  await input.fill("Use standard speed on the new model");
  await input.press("Enter");
  await page.getByRole("status").filter({ hasText: /正在交接到 codex/ }).waitFor();
  await page.evaluate(() => window.harnessFixture.resolve());
  await page.waitForFunction(() => Boolean(window.harnessFixture.finishTurn));
  assert.equal(await trigger.getAttribute("data-speed"), "default");
  await page.evaluate(() => window.harnessFixture.finishTurn());
  await page.waitForFunction(() => !window.harnessFixture.finishTurn);

  // If the speed update fails after the model changed, keep the draft and report the live runtime.
  await toggleSpeed();
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-selector"]').dataset.speed === "fast");
  await closeEffortMenu();
  await choose(/^codex/, /GPT-5.6-Sol/);
  await toggleSpeed();
  await closeEffortMenu();
  await page.evaluate(() => { window.harnessFixture.failUpdate = true; });
  const sentBeforeSpeedFailure = (await fixture()).sent.length;
  await input.fill("Keep this draft if standard speed cannot be applied");
  await input.press("Enter");
  await page.getByRole("status").filter({ hasText: /正在交接到 codex/ }).waitFor();
  await page.evaluate(() => window.harnessFixture.resolve());
  await page.getByRole("alert").filter({ hasText: "Runtime update rejected" }).waitFor();
  assert.equal((await fixture()).sent.length, sentBeforeSpeedFailure);
  assert.equal(await input.inputValue(), "Keep this draft if standard speed cannot be applied");
  assert.equal(await pillModel(), "codex · GPT-5.6-Sol");
  assert.equal(await trigger.getAttribute("data-speed"), "fast");
  await toggleSpeed();
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-selector"]').dataset.speed === "default");
  await closeEffortMenu();
  await input.press("Enter");
  await page.waitForFunction(() => Boolean(window.harnessFixture.finishTurn));
  await page.evaluate(() => window.harnessFixture.finishTurn());
  await page.waitForFunction(() => !window.harnessFixture.finishTurn);

  // A rejected effort update rolls the preview back and can be retried with the same value.
  await page.evaluate(() => { window.harnessFixture.failUpdate = true; });
  const originalEffort = await effort.getAttribute("data-value");
  assert.notEqual(originalEffort, "ultra");
  await pickEffort("ultra");
  await page.getByRole("alert").filter({ hasText: "Runtime update rejected" }).waitFor();
  await page.waitForFunction(value => document.querySelector('[data-testid="effort-selector"]').dataset.value === value, originalEffort);
  assert.equal(await trigger.getAttribute("data-effort"), originalEffort);
  await page.evaluate(() => { window.harnessFixture.holdUpdate = true; });
  await pickEffort("ultra");
  await page.waitForFunction(() => Boolean(window.harnessFixture.finishUpdate));
  assert.equal(await effort.getAttribute("data-value"), "ultra");
  assert.equal(await trigger.getAttribute("data-effort"), originalEffort);
  await page.evaluate(() => { window.harnessFixture.holdUpdate = false; window.harnessFixture.finishUpdate(); });
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-selector"]').dataset.effort === "ultra");
  assert.equal(await effort.getAttribute("data-value"), "ultra");

  // A level picked from the menu previews at once, is sent once and waits for acknowledgment;
  // picking the previewed level again sends nothing more.
  const updatesBeforePick = await page.evaluate(() => window.harnessFixture.updates.length);
  await page.evaluate(() => { window.harnessFixture.holdUpdate = true; window.harnessFixture.finishUpdate = null; });
  await pickEffort("low");
  assert.equal(await effort.getAttribute("data-value"), "low");
  await page.waitForFunction(() => Boolean(window.harnessFixture.finishUpdate));
  assert.equal(await page.evaluate(() => window.harnessFixture.updates.length), updatesBeforePick + 1);
  await effort.click();
  const previewed = effortMenu.getByRole("menuitemradio", { checked: true });
  assert.equal(await previewed.count(), 1);
  assert.equal(await effortMenu.getByRole("menuitemradio").first().getAttribute("aria-checked"), "true");
  await previewed.click();
  await effortMenu.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.harnessFixture.updates.length), updatesBeforePick + 1);
  assert.equal(await effort.getAttribute("data-value"), "low");
  assert.equal(await trigger.getAttribute("data-effort"), "ultra");
  await page.evaluate(() => { window.harnessFixture.holdUpdate = false; window.harnessFixture.finishUpdate(); });
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-selector"]').dataset.effort === "low");
  assert.equal(await effort.getAttribute("data-value"), "low");
  assert.deepEqual(errors, []);
  console.log("PASS: deferred handoff, queue failure/retry with attachments, same-provider speed, effort failure/retry (mock UI)");
} finally {
  await browser?.close();
  await server.close();
}
