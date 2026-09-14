import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = joinDist("");
function joinDist(name) { return resolve(ui, "dist", name); }
const server = createServer(async (req, res) => {
  const name = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const path = joinDist(name === "/" ? "index.html" : `.${name}`);
  if (!path.startsWith(dist + sep)) { res.writeHead(403); res.end(); return; }
  try {
    res.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".html") ? "text/html" : "application/octet-stream");
    res.end(await readFile(path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.setDefaultTimeout(6000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const inspector = page.getByTestId("inspector");
const handle = page.getByRole("separator", { name: "调整检查器宽度" });
const width = async () => (await inspector.boundingBox()).width;
/** Purpose: Exercise real pointer capture outside the handle. Input: horizontal delta. Output: resulting width. */
async function dragBy(delta) {
  const rect = await handle.boundingBox();
  await page.mouse.move(rect.x + 3, rect.y + 150);
  await page.mouse.down();
  await page.mouse.move(rect.x + 3 + delta, rect.y + 200, { steps: 8 });
  await page.mouse.up();
  return width();
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("button", { name: "开发", exact: true }).click();
  await inspector.waitFor();
  await page.waitForFunction(() => document.querySelector('.inspector').getBoundingClientRect().width >= 280);
  assert.equal(await handle.evaluate((el) => getComputedStyle(el).cursor), "col-resize");
  const original = await width();
  const conversation = await page.getByTestId("conversation").boundingBox();
  const expanded = await dragBy(-100);
  assert.ok(Math.abs(expanded - original - 100) < 2, `Width did not follow pointer: ${original} -> ${expanded}`);
  const smallerConversation = await page.getByTestId("conversation").boundingBox();
  assert.ok(Math.abs(conversation.width - smallerConversation.width - 100) < 2);
  await page.mouse.move(250, 450);
  assert.equal(await width(), expanded, "Pointer movement after release still resizes");
  assert.ok(Math.abs(await dragBy(45) - (expanded - 45)) < 2);

  for (const name of ["上下文", "运行", "变更"]) {
    const before = await width();
    await inspector.locator(".inspector-tabs button").filter({ hasText: name }).click();
    assert.equal(await width(), before, "Tab change reset the width");
    assert.ok(Math.abs(await dragBy(-15) - before - 15) < 2);
  }
  await dragBy(-1500);
  assert.ok((await page.getByTestId("conversation").boundingBox()).width >= 359);
  await dragBy(1800);
  assert.ok(Math.abs(await width() - 280) < 2);
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => document.querySelector('.inspector').getBoundingClientRect().width >= 289);
  const selected = await width();
  await inspector.getByRole("button", { name: "关闭检查器", exact: true }).click();
  await inspector.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "打开检查器", exact: true }).click();
  await inspector.waitFor();
  await page.waitForFunction((expected) => Math.abs(document.querySelector('.inspector').getBoundingClientRect().width - expected) < 1, selected);

  await page.setViewportSize({ width: 800, height: 760 });
  await handle.waitFor();
  await dragBy(-1000);
  const narrow = await inspector.boundingBox();
  assert.ok(narrow.x >= 320 && narrow.x + narrow.width <= 801, "Narrow overlay exceeds available space");
  await inspector.getByRole("button", { name: "关闭检查器", exact: true }).click({ trial: true });
  for (const name of ["上下文", "运行", "变更"]) await inspector.locator(".inspector-tabs button").filter({ hasText: name }).click();
  const rect = await handle.boundingBox();
  await page.mouse.move(rect.x + 2, rect.y + 100); await page.mouse.down();
  await page.mouse.move(rect.x - 20, rect.y + 100);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  assert.equal(await page.locator(".inspector-resizing").count(), 0);
  const dimensions = await page.evaluate(() => [innerWidth, document.documentElement.scrollWidth]);
  assert.equal(dimensions[0], dimensions[1]);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "passed", scenarios: ["continuous drag and synchronized layout", "release and repeated drag", "all three tabs", "bounds and viewport shrink", "keyboard and reopen", "focus-loss cleanup"] }));
} catch (error) {
  console.error(JSON.stringify({ errors, body: await page.locator("body").innerText() }));
  throw error;
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
