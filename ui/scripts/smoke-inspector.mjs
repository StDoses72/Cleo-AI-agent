import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { snapshot } from "../src/services/mockData.ts";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(appDir, "output", "playwright", "inspector");
await mkdir(outputDir, { recursive: true });
const fixture = structuredClone(snapshot);
const thread = fixture.threads[0];
const longName = "very-long-file-name-".repeat(24);
thread.changes = [{
  path: `nested/${longName}.ts`, status: "modified", additions: 160, deletions: 1,
  diff: `@@ -1 +1,160 @@\n-${"old_value_".repeat(100)}\n` + Array.from({ length: 160 }, (_, index) => `+line_${index} = "${"long_value_".repeat(100)}"; END_${index}`).join("\n"),
}];
thread.changeHistory = [{ id: "long-history", title: longName, createdAt: "刚刚", changes: Array.from({ length: 30 }, (_, index) => ({ ...thread.changes[0], path: `file-${index}/${longName}.ts` })) }];
thread.terminal = [`command --path=C:\\${"long-workspace-path\\".repeat(40)}\n`, ...Array.from({ length: 160 }, (_, index) => `output_${index}: ${"long_argument_".repeat(100)} END_${index}\n`)];
thread.items.push({ id: "long-tool", type: "tool", name: "long_tool_name_".repeat(45), command: "test", status: "done", output: "done" });
fixture.projects[0].path = `C:\\${"long-workspace-path\\".repeat(40)}`;
fixture.activeThreadId = thread.id;

const app = await electron.launch({ args: [".", `--user-data-dir=${join(outputDir, "profile")}`], cwd: appDir, env: { ...process.env, CLEO_DESKTOP_MOCK: "1" } });
const page = await app.firstWindow();
page.setDefaultTimeout(5000);
await page.emulateMedia({ reducedMotion: "reduce" });
await page.addInitScript((data) => {
  window.cleoDesktop = {
    request: async (method) => {
      if (method === "load_workspace") return structuredClone(data);
      if (method === "get_runtime_catalog") return { nonProductivityProfiles: [], productivityProviders: [], defaultNonProductivityProfile: "", defaultProductivityProvider: "test" };
      if (method === "get_productivity_models") return { provider: "test", source: "config", models: [] };
      throw new Error(`Unexpected test request: ${method}`);
    },
    getUpdateState: async () => ({ phase: "unsupported", currentVersion: "test" }),
    onUpdateState: () => () => {},
  };
}, fixture);
await page.reload();
await page.getByTestId("inspector").waitFor();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const results = [];

async function verifyScroll(frameSelector, panelSelector, fixedSelectors) {
  const frame = page.locator(frameSelector);
  await frame.evaluate((element) => { element.scrollLeft = 0; element.scrollTop = 0; });
  const before = await page.evaluate((selectors) => selectors.map((selector) => document.querySelector(selector).getBoundingClientRect().toJSON()), fixedSelectors);
  const geometry = await page.evaluate(({ frameSelector, panelSelector }) => {
    const frame = document.querySelector(frameSelector);
    const panel = document.querySelector(panelSelector);
    const rect = frame.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    return { left: rect.left, right: rect.right, panelLeft: bounds.left, panelRight: bounds.right, frameWidth: frame.clientWidth, contentWidth: frame.scrollWidth, frameHeight: frame.clientHeight, contentHeight: frame.scrollHeight, panelWidth: panel.clientWidth, panelContentWidth: panel.scrollWidth };
  }, { frameSelector, panelSelector });
  assert.ok(geometry.left >= geometry.panelLeft && geometry.right <= geometry.panelRight + 1, `Content frame exceeds panel: ${JSON.stringify(geometry)}`);
  assert.equal(geometry.panelContentWidth, geometry.panelWidth, "The sidebar body must not scroll horizontally");
  assert.ok(geometry.contentWidth > geometry.frameWidth, "Long content must be accessible through inner horizontal scrolling");
  assert.ok(geometry.contentHeight > geometry.frameHeight, "Long output must have an inner vertical scrollbar");
  await frame.hover();
  await page.mouse.wheel(350, 0);
  await page.waitForFunction((selector) => document.querySelector(selector).scrollLeft > 0, frameSelector);
  await frame.evaluate((element) => { element.scrollLeft = element.scrollWidth; element.scrollTop = element.scrollHeight; });
  const after = await page.evaluate(({ frameSelector, panelSelector, fixedSelectors }) => {
    const frame = document.querySelector(frameSelector);
    return { x: frame.scrollLeft, y: frame.scrollTop, maxX: frame.scrollWidth - frame.clientWidth, panelX: document.querySelector(panelSelector).scrollLeft, documentX: document.documentElement.scrollLeft, fixed: fixedSelectors.map((selector) => document.querySelector(selector).getBoundingClientRect().toJSON()) };
  }, { frameSelector, panelSelector, fixedSelectors });
  assert.ok(after.x > 0 && after.y > 0 && Math.abs(after.x - after.maxX) <= 1, "Inner content cannot be reached at the end of both scroll axes");
  assert.equal(after.panelX, 0);
  assert.equal(after.documentX, 0);
  for (let index = 0; index < before.length; index += 1) {
    assert.ok(Math.abs(before[index].left - after.fixed[index].left) < 1 && Math.abs(before[index].top - after.fixed[index].top) < 1, `Scrolling moved ${fixedSelectors[index]}`);
  }
  await frame.focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(({ selector, previousX }) => document.querySelector(selector).scrollLeft < previousX, { selector: frameSelector, previousX: after.x });
}

try {
  for (const [width, height] of [[1440, 920], [1000, 700]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
    await page.waitForFunction((compact) => matchMedia("(max-width: 1180px)").matches === compact, width < 1180);
    if (!(await page.getByTestId("inspector").count())) await page.getByRole("button", { name: "打开检查器", exact: true }).click();
    for (const tab of ["changes", "history", "run"]) {
      await page.locator(".inspector-tabs button").nth(tab === "run" ? 2 : 0).click();
      const name = `${tab}-${width}`;
      try {
        if (tab !== "run") {
          await page.getByTestId("change-history-picker").selectOption(tab === "history" ? "long-history" : "workspace");
          if (tab === "history") {
            const files = page.locator(".changed-files");
            assert.ok(await files.evaluate((element) => element.scrollHeight > element.clientHeight), "Many changed files need their own vertical scroll region");
            await files.locator("button").last().click();
            await page.locator('.diff-viewer header span[title^="file-29/"]').waitFor();
          }
          await verifyScroll(".diff-viewer pre", ".changes-panel", [".inspector-header", ".change-history-picker", ".changed-files", ".diff-viewer header"]);
        } else {
          await verifyScroll(".terminal-output", ".run-panel", [".inspector-header", ".run-status", ".terminal-head"]);
        }
        results.push({ name, status: "passed" });
      } catch (error) {
        results.push({ name, status: "failed", error: error.message });
      }
      await page.screenshot({ path: join(outputDir, `${name}.png`) });
    }
  }
  console.log(JSON.stringify({ results, errors }, null, 2));
  if (errors.length || results.some((result) => result.status === "failed")) process.exitCode = 1;
} finally {
  await app.close();
}
