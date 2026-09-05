import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { installationPaths, processStartTime, writeInstallation } from "../electron/install-state.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(appDir, "../.codex-test-tmp-update-"));
const entry = join(root, "main.mjs");
const created = join(root, "windows.txt");
const executable = fileURLToPath(new URL("../node_modules/electron/dist/electron.exe", import.meta.url));
const paths = installationPaths(root, executable);
const run = promisify(execFile);
const env = {
  ...process.env, CLEO_DESKTOP_MOCK: "0", CLEO_HOME: join(root, "home"),
  CLEO_PYTHON: process.env.CLEO_PYTHON || join(appDir, "../.venv/Scripts/python.exe"),
  CLEO_CONFIG_PATH: join(root, "home/config/cleo.json"),
  CLEO_HARNESSES_CONFIG_PATH: join(root, "home/config/harnesses.json"),
};
delete env.ELECTRON_RUN_AS_NODE;
await mkdir(join(root, "profile"));
await mkdir(join(root, "home/config"), { recursive: true });
await copyFile(join(appDir, "../cleo/config/templates/cleo.example.json"), env.CLEO_CONFIG_PATH);
await copyFile(join(appDir, "../cleo/config/templates/harnesses.example.json"), env.CLEO_HARNESSES_CONFIG_PATH);
await writeFile(entry, `
import { app } from "electron";
import { appendFileSync } from "node:fs";
import { BackendBridge } from ${JSON.stringify(pathToFileURL(join(appDir, "electron/backend.mjs")).href)};
BackendBridge.prototype.runtimePaths = () => ({ backendRoot: ${JSON.stringify(resolve(appDir, ".."))}, cleoHome: ${JSON.stringify(join(root, "home"))} });
app.setPath("temp", ${JSON.stringify(root)});
app.setPath("userData", ${JSON.stringify(join(root, "profile"))});
Object.defineProperty(app, "isPackaged", { value: true });
app.getVersion = () => "0.2.6";
globalThis.fetch = async () => { throw new Error("No release network in smoke test"); };
app.on("browser-window-created", () => appendFileSync(${JSON.stringify(created)}, "window\\n"));
await import(${JSON.stringify(pathToFileURL(join(appDir, "electron/main.mjs")).href)});
`);

let app;
try {
  await writeInstallation(paths.status, { phase: "extracting", pid: process.pid, processStartTime: await processStartTime(process.pid) });
  await run(executable, [entry], { cwd: appDir, env, windowsHide: true, timeout: 15_000 });
  await assert.rejects(readFile(created), { code: "ENOENT" });
  assert.match(await readFile(paths.attention, "utf8"), /^\d+$/);

  await writeInstallation(paths.status, { phase: "completed", version: "0.2.6" });
  app = await electron.launch({ executablePath: executable, args: [entry], cwd: appDir, env });
  let window = await app.firstWindow();
  await window.getByText("更新成功", { exact: true }).waitFor();
  await run(executable, [entry], { cwd: appDir, env, windowsHide: true, timeout: 15_000 });
  assert.equal((await readFile(created, "utf8")).trim().split("\n").length, 1);
  await app.close();
  app = null;

  await writeInstallation(paths.status, {
    phase: "failed", version: "0.2.7", error: "安装被中断，请重新检查更新。",
  });
  app = await electron.launch({ executablePath: executable, args: [entry], cwd: appDir, env });
  window = await app.firstWindow();
  await window.getByText("更新未完成", { exact: true }).waitFor();
  await window.getByText("安装被中断，请重新检查更新。", { exact: true }).waitFor();
  const output = join(appDir, "output/playwright/update-failure.png");
  await mkdir(dirname(output), { recursive: true });
  await window.screenshot({ path: output });
  console.log(JSON.stringify({ status: "passed", blockedDuringUpdate: true, singleInstance: true,
    successNotice: true, failureNotice: true, screenshot: output }));
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
