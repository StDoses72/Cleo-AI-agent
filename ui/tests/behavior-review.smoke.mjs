import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Serve only a component fixture: no Electron IPC, application or live data access.
const cacheDir = await mkdtemp(join(tmpdir(), "cleo-behavior-ui-"));
const server = await createServer({ cacheDir, root: fileURLToPath(new URL("../", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "behavior-fixture",
    configureServer(server) { server.middlewares.use("/__behavior", async (_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(await server.transformIndexHtml("/__behavior",
        '<div id="root"></div><script type="module" src="/tests/fixtures/behavior-review.tsx"></script>'));
    }); } }] });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__behavior`);
  await page.getByText("查看预期和修改前后结果", { exact: true }).click();
  assert.match(await page.locator(".evolution-comparison").innerText(), /源码分析显示只有固定命令/);
  assert.match(await page.locator(".evolution-comparison").innerText(), /预期效果/);
  assert.match(await page.locator(".evolution-comparison").innerText(), /输入 \/ 后显示/);
  assert.equal(await page.getByText("记录人工验收通过", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "应用", exact: true }).isEnabled(), true);
  await page.getByRole("button", { name: "切换构建检查结果" }).click();
  assert.equal(await page.getByRole("button", { name: "应用", exact: true }).isEnabled(), false);
  await page.getByRole("button", { name: "切换构建检查结果" }).click();
  await page.getByRole("button", { name: "应用", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "保存", exact: true }).isEnabled(), false);
  assert.equal(await page.getByLabel("验收依据：发现本机 skills").count(), 0);
  await page.getByRole("button", { name: "验收", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "保存", exact: true }).isEnabled(), true);
  const expanded = await page.locator(".update-notice").boundingBox();
  await page.getByRole("button", { name: "最小化更新提示" }).click();
  const minimized = await page.locator(".update-notice").boundingBox();
  assert.ok(minimized.width < expanded.width);
  assert.equal(await page.getByTestId("update-counts").innerText(), "0:0");
  await page.getByRole("button", { name: "展开更新提示" }).click();
  await page.getByRole("button", { name: "下载", exact: true }).click();
  await page.getByRole("button", { name: "最小化更新提示" }).click();
  await page.getByRole("button", { name: "展开更新提示" }).click();
  assert.equal(await page.getByRole("button", { name: "重启安装" }).isVisible(), true);
  assert.equal(await page.getByTestId("update-counts").innerText(), "1:0");
  console.log("PASS: before/expected content, apply/check/save gates, minimize/restore without installation");
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
