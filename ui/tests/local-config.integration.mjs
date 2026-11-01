import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { createServer } from "vite";

// Run explicitly with a dependency-complete Python; never use real model keys or turns.
const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = dirname(ui);
const python = process.env.CLEO_TEST_PYTHON;
assert.ok(python, "Set CLEO_TEST_PYTHON to a Python runtime with Cleo dependencies");
const scratch = mkdtempSync(join(repository, "tests/.tmp-local-config-"));
const config = join(scratch, "config");
Object.assign(process.env, {
  CLEO_PREVIEW_PYTHON: python, CLEO_HOME: scratch,
  CLEO_CONFIG_PATH: join(config, "cleo.json"), CLEO_HARNESSES_CONFIG_PATH: join(config, "harnesses.json"),
  CLEO_CODEX_BIN: "fixture-must-never-execute", CODEX_HOME: join(scratch, "codex"),
  CLAUDE_CONFIG_DIR: join(scratch, "claude"), PYTHONPATH: repository,
});
execFileSync(python, ["-X", "utf8", join(repository, "tests/routing/preview_fixture.py"), scratch], { env: process.env });
const original = readFileSync(join(config, "cleo.json"), "utf8");
const server = await createServer({ root: ui, server: { host: "127.0.0.1", port: 0 } });
try {
  await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, "");
  const session = await fetch(`${origin}/__cleo_config/session`);
  const { token } = await session.json();
  const headers = { "Content-Type": "application/json", "X-Cleo-Preview": token, Origin: origin };
  const rpc = async (method, params = {}, extraHeaders = {}) => fetch(`${origin}/__cleo_config/rpc`, {
    method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify({ method, params }),
  });
  const models = await (await rpc("get_model_settings")).json();
  assert.equal(models.result.profiles[0].model, "fixture-primary");
  assert.equal(JSON.stringify(models).includes("fixture-secret"), false);
  const task = (await (await rpc("get_task_usage_preview")).json()).result;
  assert.equal(task.sessionId, "fixture-root");
  assert.equal(task.usage.total, 120);
  assert.equal(task.usage.abstract, "Fixture current task");
  assert.equal("history" in task.usage, false);
  assert.equal("breakdown" in task.usage, false);
  assert.equal((await rpc("get_task_usage_preview", { session_id: "../outside" })).status, 400);
  const view = (await (await rpc("get_routing_settings")).json()).result;
  assert.equal(view.candidates[0].available, true);
  assert.equal(view.benchmark.recordCount, 0);
  const update = Object.fromEntries(["revision", "enabled", "preference", "fallbackCandidate"].map(key => [key, view[key]]));
  Object.assign(update, { preference: "cost", candidates: [], defaultMode: "manual",
    evaluator: { mode: "independent", profile_id: models.result.activeAgent, model: "fixture-primary" } });
  const saved = await rpc("save_routing_settings", { update });
  assert.equal(saved.status, 200);
  const savedView = (await saved.json()).result;
  assert.equal(savedView.preference, "cost");
  assert.equal(savedView.evaluator.mode, "independent");
  assert.equal(savedView.defaultMode, "manual");
  const keySaved = await rpc("save_benchmark_connection", { update: {
    revision: savedView.revision, access: "free", cacheTtlSeconds: 7200, apiKey: "fixture-aa-secret",
  } });
  assert.equal(keySaved.status, 200);
  const keyView = await keySaved.json();
  assert.equal(keyView.result.benchmark.keyConfigured, true);
  assert.equal(JSON.stringify(keyView).includes("fixture-aa-secret"), false);
  assert.equal(readFileSync(join(config, "benchmark-credentials.json"), "utf8").includes("fixture-aa-secret"), false);
  assert.equal(JSON.parse(readFileSync(join(config, "routing.json"))).preference, "cost");
  assert.equal((await rpc("save_routing_settings", { update })).status, 400);
  assert.equal((await rpc("stream_turn")).status, 403);
  assert.equal((await rpc("get_model_settings", {}, { "X-Cleo-Preview": "wrong" })).status, 403);
  assert.equal((await rpc("get_model_settings", {}, { Origin: "https://outside.invalid" })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const req = httpRequest(`${origin}/__cleo_config/session`, { headers: { Host: "outside.invalid" } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    req.on("error", reject); req.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal(readFileSync(join(config, "cleo.json"), "utf8"), original);
  if (process.env.CLEO_TEST_BROWSER) {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
      await page.route("**/*", route => route.request().url().startsWith(origin)
        ? route.continue() : route.abort());
      await page.goto(origin);
      await page.getByRole("heading", { name: "当前任务用量", exact: true }).waitFor();
      await page.getByRole("table", { name: "当前任务模型用量" }).waitFor();
      assert.equal(await page.getByText("120 token", { exact: true }).count(), 1);
      assert.equal(await page.getByText("Fixture current task", { exact: true }).count(), 1);
      assert.equal(await page.getByText(/历史任务/).count(), 0);
      await page.getByRole("button", { name: "重新读取", exact: true }).click();
      await page.getByText("120 token", { exact: true }).waitFor();
    } finally { await browser.close(); }
  }
  console.log(JSON.stringify({ status: "passed", fixtureSaveAndReload: true, staleRevisionRejected: true, inferenceBlocked: true, crossOriginBlocked: true, credentialRedaction: true, paidModelTurns: 0 }));
} finally {
  await server.close();
  assert.equal(dirname(resolve(scratch)), join(repository, "tests"));
  rmSync(scratch, { recursive: true, force: true });
}
