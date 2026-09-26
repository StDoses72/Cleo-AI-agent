import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { snapshot } from "../src/services/mockData.ts";

// Exercise the real UI and IPC client; the fixture replaces only the native bridge.
const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "cleo-projects-"));
const server = await createServer({ root: ui, cacheDir: join(scratch, "vite"), server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(fixture => {
    const control = window.projectTest = { calls: [], picked: null, picks: 0, fail: false, hold: false, release: null };
    window.cleoDesktop = {
      pickWorkspace: async () => { control.picks++; return control.picked; },
      request: async (method, params = {}) => {
        control.calls.push({ method, params });
        if (method === "load_workspace") return structuredClone(fixture);
        if (method === "load_memory") return { memories: fixture.memories, memoryOverview: fixture.memoryOverview };
        if (method === "load_thread") return structuredClone(fixture.threads.find(thread => thread.id === params.thread_id));
        if (method === "get_pending_questions" || method === "get_local_skills") return [];
        if (method === "get_runtime_catalog") return { nonProductivityProfiles: [], defaultNonProductivityProfile: "", defaultProductivityProvider: "codex", productivityProviders: [] };
        if (method === "get_productivity_models") return { provider: "codex", source: "sdk", models: [] };
        if (method === "get_model_settings") return { profiles: [], connections: [], activeAgent: "", activeDreamAgent: "" };
        if (method === "get_agent_instructions") return { content: "", path: "AGENTS.md", exists: false };
        if (method === "add_project") {
          if (control.fail) throw new Error("项目文件夹无法访问");
          if (control.hold) await new Promise(resolve => { control.release = resolve; });
          // Deliberately different from the basename: selection must use the backend identity.
          const id = "productivity:canonical-project";
          if (!fixture.projects.some(project => project.id === id)) fixture.projects.push({
            id, name: "新建项目", space: "productivity", path: params.project_path, branch: "", dirtyFiles: 0, accent: "#6be4ed", removable: true,
          });
          return { ...structuredClone(fixture), selectedProjectId: id };
        }
        if (method === "create_thread") {
          const thread = { ...structuredClone(fixture.threads[0]), id: "new-project-thread", projectId: params.project_id_value, title: "工作区测试", space: "productivity", items: [] };
          fixture.threads.unshift(thread);
          return thread;
        }
        if (method === "stream_turn") return null;
        throw new Error(`Unhandled fixture method: ${method}`);
      },
      getEvolutionState: async () => ({ phase: "idle", supported: false, builds: [], releases: [] }),
      onEvolutionState: () => () => {}, confirmHealthy: async () => {}, onStreamEvent: () => () => {},
      getUpdateState: async () => ({ phase: "unsupported", currentVersion: "0.5.14" }),
      onUpdateState: () => () => {},
    };
  }, snapshot);
  await page.goto(server.resolvedUrls.local[0]);
  const composer = page.getByTestId("composer-input");
  const newProject = page.getByTestId("new-project");
  const pickerName = page.locator(".project-picker-copy strong");
  const settled = () => newProject.and(page.locator(":enabled")).waitFor();
  await composer.waitFor();
  const originalProject = await pickerName.innerText();
  await page.getByTestId("new-thread").click();
  await composer.fill("保留的草稿");
  assert.equal(await page.evaluate(() => window.projectTest.picks), 0);
  assert.equal(await page.evaluate(() => window.projectTest.calls.filter(c => c.method === "create_thread").length), 0);
  await newProject.click(); await settled();
  assert.equal(await pickerName.innerText(), originalProject);
  assert.equal(await composer.inputValue(), "保留的草稿");
  assert.equal(await page.evaluate(() => window.projectTest.calls.filter(c => c.method === "add_project").length), 0);

  await page.evaluate(() => { window.projectTest.picked = "C:\\Projects\\中文 文件夹"; window.projectTest.fail = true; });
  await newProject.click(); await settled();
  await page.getByRole("alert").getByText("项目文件夹无法访问").waitFor();
  assert.equal(await pickerName.innerText(), originalProject);
  assert.equal(await composer.inputValue(), "保留的草稿");

  await page.evaluate(() => { window.projectTest.fail = false; window.projectTest.hold = true; });
  await newProject.click();
  await page.waitForFunction(() => Boolean(window.projectTest.release));
  assert.equal(await newProject.isDisabled(), true);
  await page.getByRole("button", { name: /^统一 managed 与 native sessions/ }).click();
  await page.evaluate(() => { window.projectTest.hold = false; window.projectTest.release(); });
  await settled();
  assert.equal(await pickerName.innerText(), originalProject, "Slow folder registration stole navigation");

  await newProject.click(); await settled();
  assert.equal(await pickerName.innerText(), "新建项目");
  assert.equal(await composer.inputValue(), "");
  if (process.env.CLEO_SMOKE_OUTPUT) await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "project-workspaces.png") });
  await composer.fill("检查这个工作区");
  await composer.press("Enter");
  await page.waitForFunction(() => window.projectTest.calls.some(c => c.method === "create_thread"));
  const created = await page.evaluate(() => window.projectTest.calls.find(c => c.method === "create_thread").params);
  assert.equal(created.project_id_value, "productivity:canonical-project");
  assert.equal(created.project_path, "C:\\Projects\\中文 文件夹");
  assert.deepEqual(errors, []);
  console.log("PASS: quick empty task, cancellation preserves draft, failure recovery, busy picker, late response isolation, canonical project selection and new session working directory");
} finally {
  await browser?.close(); await server.close();
  assert.equal(dirname(scratch), resolve(tmpdir()));
  await rm(scratch, { recursive: true, force: true });
}
