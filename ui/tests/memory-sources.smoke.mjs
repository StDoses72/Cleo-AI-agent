import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { snapshot } from "../src/services/mockData.ts";

// Real components, IPC client, Python RPC handlers and on-disk settings; no model requests.
const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(ui, "..");
const scratch = await mkdtemp(join(tmpdir(), "cleo-memory-sources-"));
const home = join(scratch, "home");
const configPath = join(home, "config", "cleo.json");
const native = join(scratch, "codex");
const manual = join(scratch, "manual");
let server, browser, backend;
const pending = new Map();
let sequence = 0;
let stderr = "";
function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = String(++sequence);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); }, 20_000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    backend.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
try {
  await mkdir(dirname(configPath), { recursive: true });
  await mkdir(join(native, "memories"), { recursive: true });
  await mkdir(manual);
  await writeFile(join(native, "memories", "MEMORY.md"), "Reference only\n");
  await writeFile(join(manual, "summary.md"), "Manual reference\n");
  const config = JSON.parse(await readFile(join(repo, "cleo/config/templates/cleo.example.json"), "utf8"));
  config.profiles.directories.default.root_dir = home;
  config.profiles.agents.moonshot_openai_compatible.base_url = "http://127.0.0.1:1/v1";
  config.active_profiles.dream_enabled = false;
  await writeFile(configPath, JSON.stringify(config));
  backend = spawn(process.env.CLEO_TEST_PYTHON || "python", ["-m", "cleo.desktop.server"], {
    cwd: repo, windowsHide: true, env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1",
      CLEO_HOME: home, CLEO_CONFIG_PATH: configPath, CODEX_HOME: native,
      CODEX_SQLITE_HOME: native, CLAUDE_CONFIG_DIR: join(scratch, "claude") },
  });
  backend.stderr.on("data", data => { stderr += data; });
  createInterface({ input: backend.stdout }).on("line", line => {
    const message = JSON.parse(line);
    const handler = pending.get(message.id);
    if (!handler || message.type === "event") return;
    pending.delete(message.id);
    if (message.type === "error") handler.reject(new Error(message.error.message));
    else handler.resolve(message.result);
  });
  const initial = await request("get_memory_sources");
  assert.equal(initial.settings.sync_enabled, false);
  server = await createServer({ root: ui, cacheDir: join(scratch, "vite"), server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.exposeFunction("memoryRequest", request);
  await page.addInitScript(fixture => {
    window.cleoDesktop = {
      request: async (method, params = {}) => {
        if (["get_memory_sources", "save_memory_sources", "get_model_settings", "save_dream_settings",
          "get_background_memory_state", "save_background_memory_settings", "get_harness_sync"].includes(method)) return window.memoryRequest(method, params);
        if (method === "load_workspace") return fixture;
        if (method === "load_memory") return { memories: fixture.memories, memoryOverview: fixture.memoryOverview };
        if (method === "load_thread") return fixture.threads.find(thread => thread.id === params.thread_id);
        if (["get_pending_questions", "get_local_skills"].includes(method)) return [];
        if (method === "get_ui_language") return "zh-CN";
        if (method === "get_runtime_catalog") return { nonProductivityProfiles: [], defaultNonProductivityProfile: "", defaultProductivityProvider: "codex", productivityProviders: [] };
        if (method === "get_productivity_models") return { provider: "codex", source: "sdk", models: [] };
        if (method === "get_agent_instructions") return { content: "", path: "AGENTS.md", exists: false };
        if (method === "get_config_status") return { version: 1, error: null, restartRequired: false };
        throw new Error(`Unhandled fixture method: ${method}`);
      },
      getEvolutionState: async () => ({ phase: "idle", supported: false, builds: [], releases: [] }),
      onEvolutionState: () => () => {}, confirmHealthy: async () => {}, onStreamEvent: () => () => {},
      getUpdateState: async () => ({ phase: "idle", currentVersion: "0.11.0", latestVersion: null, error: null }),
      onUpdateState: () => () => {},
    };
  }, snapshot);
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByTestId("composer-input").waitFor();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "数据与记忆", exact: true }).click();
  const sources = page.getByRole("region", { name: "记忆来源", exact: true });
  const sync = sources.getByRole("checkbox", { name: "提示原生工具维护记忆", exact: true });
  await sync.waitFor();
  assert.equal(await sync.isChecked(), false);
  await sync.click();
  await page.waitForFunction(() => !document.querySelector('input[aria-label="提示原生工具维护记忆"]').disabled);
  assert.equal((await request("get_memory_sources")).settings.sync_enabled, true);
  await sources.getByRole("checkbox", { name: "允许读取来源 codex", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('input[aria-label="允许读取来源 codex"]').disabled);
  assert.ok((await request("get_memory_sources")).settings.disabled_sources.includes("codex"));
  await sources.getByLabel("来源标识", { exact: true }).fill("fixture");
  await sources.getByLabel("原生目录（绝对路径）", { exact: true }).fill(manual);
  await sources.getByRole("button", { name: "添加只读来源", exact: true }).click();
  await sources.getByText("fixture", { exact: true }).waitFor();
  assert.equal((await request("get_memory_sources")).settings.sources[0].root, manual);
  await sync.click();
  await page.waitForFunction(() => !document.querySelector('input[aria-label="提示原生工具维护记忆"]').disabled);
  assert.equal((await request("get_memory_sources")).settings.sync_enabled, false);
  assert.equal((await request("get_background_memory_state")).dreamEnabled, false);
  const saved = JSON.parse(await readFile(join(home, "config", "memory-sources.json"), "utf8"));
  assert.equal(saved.sources.length, 1);
  assert.equal(saved.sync_enabled, false);
  await sources.getByRole("heading", { name: "记忆来源", exact: true }).scrollIntoViewIfNeeded();
  assert.deepEqual(errors, []);
  if (process.env.CLEO_TEST_SCREENSHOT) await page.screenshot({ path: process.env.CLEO_TEST_SCREENSHOT });
  await page.getByRole("button", { name: "原生目录", exact: true }).click();
  const nativeCard = page.getByRole("region", { name: "Codex", exact: true });
  await nativeCard.waitFor();
  assert.ok((await nativeCard.innerText()).includes(native));
  assert.equal(await nativeCard.getByRole("button", { name: /导入|导出/ }).count(), 0);
  await page.getByRole("button", { name: "记忆整理", exact: true }).click();
  await page.getByRole("radio", { name: /跟随对话/ }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByText("记忆整理设置已保存", { exact: true }).waitFor();
  assert.equal((await request("get_model_settings")).dreamEnabled, true);
  await page.getByRole("radio", { name: /关闭自动整理/ }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.ms-save-footer'));
  assert.equal((await request("get_model_settings")).dreamEnabled, false);
  assert.equal((await request("get_memory_sources")).settings.sources.length, 1);
  assert.deepEqual(errors, []);
  console.log("PASS: real memory UI/RPC persistence, source revocation/manual add, optional sync, native shared-home card and Dream enable/disable");
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  if (backend) {
    try { await request("shutdown"); } catch { /* process may already have exited */ }
    backend.stdin.end();
    if (backend.exitCode === null) await Promise.race([
      new Promise(resolve => backend.once("exit", resolve)),
      new Promise(resolve => setTimeout(() => { backend.kill(); resolve(); }, 5000)),
    ]);
  }
  for (const handler of pending.values()) handler.reject(new Error("Test closed"));
  await rm(scratch, { recursive: true, force: true });
}
