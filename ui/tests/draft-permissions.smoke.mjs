import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { permissionPresets, snapshot } from "../src/services/mockData.ts";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "cleo-draft-permissions-"));
const server = await createServer({ root: ui, cacheDir: join(scratch, "vite"), server: { host: "127.0.0.1", port: 0 } });
const providers = [
  { id: "custom-codex", type: "codex_sdk", defaultModel: "test-model", modelSource: "dynamic", permissionOptions: permissionPresets.codex },
  { id: "custom-claude", type: "claude_sdk", defaultModel: "test-model", modelSource: "dynamic", permissionOptions: permissionPresets.claude },
  { id: "custom-acp", type: "acp", defaultModel: "test-model", modelSource: "dynamic", permissionOptions: {
    access: [], approval: ["user", "auto_allow", "deny_all"].map(value => ({ value, label: value, description: "" })),
  } },
];
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
  const errors = [];
  for (const provider of providers) {
    for (const inherited of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      page.setDefaultTimeout(8000);
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(({ fixture, providers, provider, inherited }) => {
        const nativeDefaults = {
          "custom-codex": { access: "full-access", approval: "deny_all" },
          "custom-claude": { access: "default", approval: "acceptEdits" },
          "custom-acp": { access: "default", approval: "auto_allow" },
        };
        const template = { ...fixture.threads[0], runtime: {
          provider: provider.id, model: "test-model", effort: null,
          ...nativeDefaults[provider.id], permissionOptions: provider.permissionOptions,
        } };
        fixture.threads = inherited ? [template] : [];
        const control = window.draftPermissionTest = { calls: [] };
        window.cleoDesktop = {
          request: async (method, params = {}) => {
            if (method === "load_workspace") return structuredClone(fixture);
            if (method === "load_memory") return { memories: fixture.memories, memoryOverview: fixture.memoryOverview };
            if (method === "load_thread") return structuredClone(fixture.threads.find(thread => thread.id === params.thread_id));
            if (method === "get_pending_questions" || method === "get_local_skills") return [];
            if (method === "get_runtime_catalog") return { nonProductivityProfiles: [], defaultNonProductivityProfile: "",
              defaultProductivityProvider: provider.id, productivityProviders: providers };
            if (method === "get_productivity_models") return { provider: params.provider, source: "sdk", models: [
              { id: "test-model", label: "Test model", description: "", supportedEfforts: [], defaultEffort: null },
            ] };
            if (method === "get_model_settings") return { profiles: [], connections: [], activeAgent: "", activeDreamAgent: "" };
            if (method === "get_agent_instructions") return { content: "", path: "AGENTS.md", exists: false };
            if (method === "create_thread") {
              const selected = providers.find(item => item.id === params.provider);
              if (selected.type !== "codex_sdk" && params.access !== undefined) throw new Error("This backend has no sandbox field");
              control.calls.push(structuredClone(params));
              const thread = { ...structuredClone(template), id: `created-${control.calls.length}`,
                projectId: params.project_id_value, items: [], runtime: { ...template.runtime,
                  provider: params.provider, ...nativeDefaults[params.provider],
                  ...(params.access !== undefined ? { access: params.access } : {}),
                  ...(params.approval !== undefined ? { approval: params.approval } : {}),
                  permissionOptions: selected.permissionOptions,
                } };
              fixture.threads.unshift(thread);
              return thread;
            }
            if (method === "stream_turn") return null;
            throw new Error(`Unhandled fixture method: ${method}`);
          },
          getEvolutionState: async () => ({ phase: "idle", supported: false, builds: [], releases: [] }),
          onEvolutionState: () => () => {}, confirmHealthy: async () => {}, onStreamEvent: () => () => {},
          getUpdateState: async () => ({ phase: "unsupported", currentVersion: "0.10.0" }), onUpdateState: () => () => {},
        };
      }, { fixture: snapshot, providers, provider, inherited });
      await page.goto(server.resolvedUrls.local[0]);
      const input = page.getByTestId("composer-input");
      await input.waitFor();
      if (inherited) await page.getByTestId("new-thread").click();
      if (provider.type === "codex_sdk") {
        assert.equal(await page.getByTestId("permission-selector").inputValue(), inherited ? "full" : "ask");
      } else if (provider.type === "claude_sdk") {
        assert.equal(await page.getByTestId("permission-selector").inputValue(), inherited ? "custom" : "ask");
      }
      const send = async () => {
        const before = await page.evaluate(() => window.draftPermissionTest.calls.length);
        await input.fill("Check initial permissions");
        await page.getByTestId("send-button").click();
        await page.waitForFunction(count => window.draftPermissionTest.calls.length > count, before);
        return page.evaluate(() => window.draftPermissionTest.calls.at(-1));
      };
      const initial = await send();
      const expectedApproval = inherited
        ? { codex_sdk: "deny_all", claude_sdk: "acceptEdits", acp: "auto_allow" }[provider.type]
        : { codex_sdk: "user", claude_sdk: "default", acp: "user" }[provider.type];
      assert.equal(initial.approval, expectedApproval, `${provider.type} draft permission must be applied at creation`);
      assert.equal(initial.access, provider.type === "codex_sdk" ? inherited ? "full-access" : "workspace-write" : undefined);
      // Every visible preset is sent using its native values, including after a harness switch.
      for (const preset of provider.permissionOptions.presets ?? []) {
        await page.getByTestId("new-thread").click();
        await page.getByTestId("permission-selector").selectOption(preset.value);
        const created = await send();
        assert.deepEqual([created.access, created.approval], [preset.update.access, preset.update.approval]);
      }
      if (provider.type === "codex_sdk") {
        await page.getByTestId("new-thread").click();
        await page.getByTestId("permission-selector").selectOption("full");
        await page.getByTestId("runtime-selector").click();
        await page.getByTestId("runtime-model-row").click();
        await page.getByTestId("runtime-menu").getByRole("button", { name: /^custom-claude/ }).click();
        await page.getByRole("button", { name: /^Test model/ }).click();
        await page.keyboard.press("Escape");
        assert.equal(await page.getByTestId("permission-selector").inputValue(), "ask");
        const switched = await send();
        assert.deepEqual([switched.provider, switched.access, switched.approval], ["custom-claude", undefined, "default"]);
      }
      console.log(`PASS: ${provider.type} ${inherited ? "inherited" : "fresh"} draft uses backend fields and visible permissions`);
      await page.close();
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close(); await server.close();
  assert.equal(dirname(scratch), resolve(tmpdir()));
  await rm(scratch, { recursive: true, force: true });
}
