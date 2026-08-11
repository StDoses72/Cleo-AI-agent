import { _electron as electron } from "playwright";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(appDir, "..");
const executablePath = join(sourceRoot, "release", "Cleo", "Cleo.exe");
const testHome = join(sourceRoot, ".codex-test-tmp-desktop-packaged");
const screenshotPath = join(appDir, "output", "playwright", "packaged-memory.png");
await rm(testHome, { recursive: true, force: true });
await mkdir(testHome, { recursive: true });
await mkdir(dirname(screenshotPath), { recursive: true });

const electronApp = await electron.launch({
  executablePath,
  cwd: dirname(executablePath),
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
  await window.getByText("connected", { exact: true }).waitFor({ timeout: 20_000 });
  await window.getByRole("button", { name: "记忆", exact: true }).click();
  await window.getByText("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2").waitFor();
  await window.getByRole("button", { name: "设置", exact: true }).click();
  await window.getByRole("button", { name: "模型", exact: true }).click();
  await window.getByLabel("模型名称").waitFor();
  await window.screenshot({ path: screenshotPath });
  if (consoleErrors.length) throw new Error(`Console errors: ${consoleErrors.join(" | ")}`);
  console.log(JSON.stringify({ status: "passed", backend: "real-packaged", executablePath, screenshotPath }, null, 2));
} finally {
  await electronApp.close();
  await rm(testHome, { recursive: true, force: true });
}
