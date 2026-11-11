/** UI smoke for the composer's slash menu: skill search, IME Enter, keyboard choice and harness switches.
 * Formerly part of interaction-ui.smoke.mjs, whose acceptance-case half went with local evolution (ADR 0009).
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "cleo-composer-slash-"));
const server = await createServer({ root: ui, cacheDir: join(root, "vite-cache"), server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${server.resolvedUrls.local[0]}tests/composer-slash-fixture.html`);
  const input = page.getByTestId("composer-input");
  const options = page.locator('[data-testid="slash-menu"] [role="option"]');

  // Commands and this harness's skills, narrowed as the user types.
  await input.fill("/"); assert.equal(await options.count(), 5);
  await input.fill("/g"); assert.equal(await options.count(), 3);
  await input.fill("/gri"); assert.equal(await options.count(), 2);
  if (process.env.CLEO_SMOKE_OUTPUT) {
    await mkdir(process.env.CLEO_SMOKE_OUTPUT, { recursive: true });
    await page.getByTestId("composer").screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "composer-slash.png") });
  }

  // Enter that confirms an IME composition neither picks an option nor sends.
  await input.dispatchEvent("compositionstart");
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, keyCode: 229 });
  assert.equal(await input.inputValue(), "/gri");
  assert.equal(await page.getByTestId("sent").textContent(), "[]");
  await input.dispatchEvent("compositionend");

  // Choosing with the keyboard fills the command; only the next Enter sends.
  await input.press("ArrowDown"); await input.press("Enter");
  assert.equal(await input.inputValue(), "/grilling ");
  assert.equal(await page.getByTestId("sent").textContent(), "[]");
  await input.fill("/grilling explain this plan"); await input.press("Enter");
  assert.match(await page.getByTestId("sent").textContent(), /grilling explain this plan/);

  // No match shows nothing; deleting a character searches again.
  await input.fill("/unmatched"); assert.equal(await options.count(), 0);
  await input.fill("/gri"); await input.press("Backspace"); assert.equal(await options.count(), 2);

  // Another harness lists its own skills, chosen by mouse, with focus kept in the composer.
  await page.getByRole("button", { name: "切换测试 harness" }).click();
  assert.equal(await options.count(), 0);
  await input.fill("/"); assert.equal(await options.count(), 3);
  await page.getByTestId("slash-menu").getByRole("option", { name: /claude-only/ }).click();
  assert.equal(await input.inputValue(), "/claude-only ");
  assert.ok(await input.evaluate((element) => element === document.activeElement));

  assert.deepEqual(errors, []);
  console.log("PASS: slash menu search, IME Enter, keyboard and mouse choice, harness switch");
} finally {
  await browser?.close();
  await server.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
