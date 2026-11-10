import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopPlatform } from "../electron/platform.mjs";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(appDir, "..");
const target = desktopPlatform();
const executablePath = process.env.CLEO_EXECUTABLE || join(sourceRoot, "release", target.bundle, target.executable);
const testHome = join(sourceRoot, ".codex-test-tmp-desktop-packaged");
const screenshotPath = join(appDir, "output", "playwright", "packaged-memory.png");
if (!resolve(testHome).startsWith(sourceRoot + (process.platform === "win32" ? "\\" : "/"))
    || !testHome.includes(".codex-test-tmp-")) throw new Error("Invalid packaged test directory.");
await rm(testHome, { recursive: true, force: true });
await mkdir(testHome, { recursive: true });
await mkdir(dirname(screenshotPath), { recursive: true });

const electronApp = await electron.launch({
  executablePath,
  cwd: dirname(executablePath),
  args: [`--user-data-dir=${join(testHome, "electron-profile")}`],
  env: {
    ...process.env,
    CLEO_HOME: testHome,
    CLEO_CONFIG_PATH: "",
    CLEO_HARNESSES_CONFIG_PATH: "",
  },
});
const window = await electronApp.firstWindow();
const consoleErrors = [];
window.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

try {
  await window.getByTestId("composer-input").waitFor({ timeout: 20_000 });
  const connected = await window.evaluate(async () =>
    (await window.cleoDesktop.request("load_workspace")).backend.connected);
  if (!connected) throw new Error("Packaged backend is not connected.");
  // Installation prepares the base runtime; optional setup is opened manually.
  const setup = await window.evaluate(() => window.cleoDesktop.setup("scan"));
  assert.equal(setup.items.find(item => item.id === "runtime")?.ready, true,
    `Packaged Python runtime is not ready: ${JSON.stringify(setup.items)}`);
  assert.equal(await window.getByRole("dialog", { name: "运行环境", exact: true }).count(), 0);
  // What a packaged program adds over a source run: a live updater and a startup confirmation that
  // reaches the version switch controller.
  const update = await window.evaluate(() => window.cleoDesktop.getUpdateState());
  if (update.phase === "unsupported") throw new Error("Packaged updater is unavailable.");
  await window.evaluate(() => window.cleoDesktop.confirmHealthy());
  await window.getByTestId("new-task-in-section").click();
  await window.evaluate(() => {
    const input = document.querySelector('[data-testid="composer-input"]');
    const transfer = new DataTransfer();
    transfer.items.add(new File(["%PDF-packaged-test"], "clipboard.pdf", {
      type: "application/pdf",
    }));
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: transfer });
    input?.dispatchEvent(paste);
  });
  await window.getByText("clipboard.pdf", { exact: true }).waitFor();
  await window.getByRole("button", { name: "移除 clipboard.pdf", exact: true }).click();
  await window.getByRole("button", { name: "记忆", exact: true }).click();
  await window.getByRole("button", { name: "设置", exact: true }).click();
  await window.getByRole("button", { name: "模型连接", exact: true }).click();
  await window.getByRole("button", { name: "切换模型", exact: true }).waitFor();
  await window.screenshot({ path: screenshotPath });
  if (consoleErrors.length) throw new Error(`Console errors: ${consoleErrors.join(" | ")}`);
  console.log(JSON.stringify({ status: "passed", backend: "real-packaged", executablePath, screenshotPath }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ consoleErrors, body: await window.locator("body").innerText().catch(() => "unavailable") }));
  await window.screenshot({ path: join(dirname(screenshotPath), "packaged-failure.png") }).catch(() => {});
  throw error;
} finally {
  await electronApp.close();
  await rm(testHome, { recursive: true, force: true });
}
