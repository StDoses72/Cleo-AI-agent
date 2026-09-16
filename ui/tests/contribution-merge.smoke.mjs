import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A component fixture only: never starts Electron or touches a user's Cleo profile.
const cacheDir = await mkdtemp(join(tmpdir(), "cleo-merge-ui-"));
const server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), cacheDir,
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "merge-fixture",
    configureServer(server) { server.middlewares.use("/__merge", async (_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(await server.transformIndexHtml("/__merge",
        '<div id="root"></div><script type="module" src="/tests/fixtures/contribution-merge.tsx"></script>'));
    }); } }] });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__merge`);
  const pr = page.getByRole("region", { name: "PR 合并辅助" });
  const check = page.getByRole("region", { name: "提交兼容性" });
  await pr.getByRole("button", { name: "帮助合并 / 刷新状态" }).click();
  await pr.getByText("ui/src/App.tsx", { exact: true }).waitFor();
  assert.match(await pr.innerText(), /FAILURE/);
  assert.match(await pr.innerText(), /没有源仓库写权限/);
  assert.equal(await pr.getByRole("link", { name: "查看具体差异" }).getAttribute("href"), "https://github.com/StDoses72/Cleo-AI-agent/pull/49/files");
  await pr.getByRole("button", { name: "调查并修复原 PR" }).click();
  assert.equal(await page.getByTestId("action").innerText(), "repairContribution:https://github.com/StDoses72/Cleo-AI-agent/pull/49");
  await page.getByRole("button", { name: "fixture clean" }).click();
  await check.getByRole("button", { name: "检查兼容性" }).click();
  await check.getByText(/目标分支为空，可提交完整源码（512 个文件）/).waitFor();
  assert.equal(await check.getByRole("button", { name: /调查并修复/ }).count(), 0);
  assert.match(await check.innerText(), /无冲突不代表满足全部合并条件/);
  await page.getByRole("button", { name: "fixture target" }).click();
  assert.equal(await check.getByRole("status").count(), 0);
  await page.getByRole("button", { name: "fixture error" }).click();
  await check.getByRole("button", { name: "检查兼容性" }).click();
  await check.getByRole("alert").waitFor();
  assert.match(await check.getByRole("alert").innerText(), /HTTP 403/);
  assert.deepEqual(errors, []);
  console.log("PASS: conflict files, CI/permissions, original PR handoff, fresh target, and error UI");
} finally { await browser?.close(); await server.close(); await rm(cacheDir, { recursive: true, force: true }); }
