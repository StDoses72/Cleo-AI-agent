import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

if (!process.env.CLEO_TEST_PYTHON) throw new Error("CLEO_TEST_PYTHON must select a complete isolated test interpreter.");
const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "cleo-setup-native-"));
const data = join(scratch, "data");
await mkdir(data);
await copyFile(join(ui, "../cleo/config/templates/cleo.example.json"), join(data, "cleo.json"));
await copyFile(join(ui, "../cleo/config/templates/harnesses.example.json"), join(data, "harnesses.json"));
const env = { ...process.env, CLEO_DESKTOP_MOCK: "0", CLEO_PYTHON: process.env.CLEO_TEST_PYTHON,
  CLEO_HOME: data, CLEO_CONFIG_PATH: join(data, "cleo.json"), CLEO_HARNESSES_CONFIG_PATH: join(data, "harnesses.json"), PYTHONUTF8: "1" };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ executablePath: join(ui, "node_modules/electron/dist/electron.exe"),
    args: [ui, `--user-data-dir=${join(scratch, "profile")}`], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(60000);
  const dialog = page.getByRole("dialog", { name: "运行环境", exact: true });
  await dialog.waitFor();
  await dialog.getByText("Cleo 基础运行环境", { exact: true }).waitFor();
  const state = await page.evaluate(() => window.cleoDesktop.setup("status"));
  assert.equal(state.items.find(item => item.id === "runtime").ready, true, state.items.find(item => item.id === "runtime").detail);
  assert.equal(state.items.find(item => item.id === "harnesses").ready, true);
  assert.equal(state.busy, false);
  assert.equal(state.pendingIds.length, 0, "Native first-run scan must not authorize installation");
  await dialog.getByRole("button", { name: "稍后再说", exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.setup-dialog footer button:nth-last-child(3)')?.disabled);
  if (process.env.CLEO_SMOKE_OUTPUT) await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "setup-native.png") });
  await dialog.getByRole("button", { name: "稍后再说", exact: true }).click();
  await page.getByTestId("composer-input").waitFor();
  assert.equal((await page.evaluate(() => window.cleoDesktop.setup("status"))).dismissed, true);
  await app.close();
  app = await electron.launch({ executablePath: join(ui, "node_modules/electron/dist/electron.exe"),
    args: [ui, `--user-data-dir=${join(scratch, "profile")}`], env });
  const reopened = await app.firstWindow();
  await reopened.getByTestId("composer-input").waitFor();
  assert.equal((await reopened.evaluate(() => window.cleoDesktop.setup("startup"))).showOnStartup, false);
  assert.equal(await reopened.getByRole("dialog", { name: "运行环境", exact: true }).count(), 0);
  await reopened.evaluate(() => window.dispatchEvent(new Event("cleo:open-setup")));
  await reopened.getByRole("dialog", { name: "运行环境", exact: true }).waitFor();
  console.log("PASS: real main/preload/backend startup, native dependency scan, no implicit installation, skip to chat");
} finally {
  await app?.close();
  assert.equal(dirname(scratch), resolve(tmpdir()));
  await rm(scratch, { recursive: true, force: true });
}
