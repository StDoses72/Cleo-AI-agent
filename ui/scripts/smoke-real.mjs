import { _electron as electron } from "playwright";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(appDir, "..");
const testHome = join(sourceRoot, ".codex-test-tmp-desktop-real");
await rm(testHome, { recursive: true, force: true });
await mkdir(testHome, { recursive: true });

const electronApp = await electron.launch({
  args: ["."],
  cwd: appDir,
  env: {
    ...process.env,
    CLEO_HOME: testHome,
    CLEO_CONFIG_PATH: join(sourceRoot, "config", "cleo.json"),
    CLEO_HARNESSES_CONFIG_PATH: join(sourceRoot, "config", "harnesses.json"),
  },
});
const window = await electronApp.firstWindow();
const consoleErrors = [];
window.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

try {
  try {
    await window.getByText("connected", { exact: true }).waitFor({ timeout: 20_000 });
  } catch (error) {
    console.error(await window.locator("body").innerText());
    throw error;
  }
  await window.getByRole("button", { name: "对话", exact: true }).click();
  await window.getByTestId("new-thread").click();
  await window.getByTestId("runtime-selector").click();
  await window.getByText("gpt-5.4-mini", { exact: true }).waitFor();
  await window.getByTestId("runtime-selector").click();
  const composer = window.getByTestId("composer-input");
  await composer.fill("/");
  await window.getByTestId("slash-menu").waitFor();
  await composer.fill("");
  await window.getByText("从一个清晰的目标开始。").waitFor();
  await window.getByRole("button", { name: "记忆", exact: true }).click();
  await window.getByText("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2").waitFor();
  await window.getByTestId("memory-nav-projects").click();
  await window.getByRole("heading", { name: "项目记忆", exact: true }).waitFor();
  await window.getByTestId("memory-nav-pending").click();
  await window.getByRole("heading", { name: "待确认", exact: true }).waitFor();
  if (consoleErrors.length) throw new Error(`Console errors: ${consoleErrors.join(" | ")}`);
  console.log(JSON.stringify({ status: "passed", backend: "real", testHome }, null, 2));
} finally {
  await electronApp.close();
  await rm(testHome, { recursive: true, force: true });
}
