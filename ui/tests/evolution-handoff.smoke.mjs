import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, rename } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createPackage } from "@electron/asar";
import { EvolutionStore, readJson } from "../electron/evolution-store.mjs";

const execute = promisify(execFile);
const repo = resolve(".");
const root = await mkdtemp(join(tmpdir(), "cleo-visible-handoff-"));
const moduleUrl = pathToFileURL(join(repo, "ui/electron/evolution-recovery.mjs")).href;
const storeUrl = pathToFileURL(join(repo, "ui/electron/evolution-store.mjs")).href;

/** Purpose: Make tiny packaged startup fixtures on the real Electron runtime.
 * Input: directory and entry point code. Output: executable Cleo package.
 */
async function packageApp(directory, code) {
  await mkdir(directory, { recursive: true });
  await cp(join(repo, "ui/node_modules/electron/dist"), directory, { recursive: true });
  await rename(join(directory, "electron.exe"), join(directory, "Cleo.exe"));
  const staging = await mkdtemp(join(root, "stage-"));
  await writeFile(join(staging, "package.json"), JSON.stringify({ name: "cleo-fixture", type: "module", main: "main.mjs" }));
  await writeFile(join(staging, "main.mjs"), code);
  await createPackage(staging, join(directory, "resources/app.asar"));
  return join(directory, "Cleo.exe");
}

/** Purpose: Exercise the actual controller with a failed package and a real fallback window.
 * Input: whether the fallback is also broken. Output: visibility and startup assertions using temporary data only.
 */
async function scenario(allFail) {
  const directory = join(root, allFail ? "all-fail" : "fallback");
  const profile = join(directory, "profile");
  const dataHome = join(directory, "home");
  const store = new EvolutionStore(join(profile, "evolution"), dataHome);
  await mkdir(join(dataHome, "data"), { recursive: true });
  await writeFile(join(dataHome, "data/latest.txt"), "current data");
  const marker = join(directory, "healthy.json");
  const bad = 'import { app } from "electron"; app.whenReady().then(() => app.exit(1));';
  const good = `import { app, BrowserWindow } from "electron";
import { writeFile, readFile } from "node:fs/promises";
import { EvolutionStore } from ${JSON.stringify(storeUrl)};
const store = new EvolutionStore(${JSON.stringify(store.root)}, ${JSON.stringify(dataHome)});
app.whenReady().then(async () => {
 const window = new BrowserWindow({ show:false, width:400, height:240 });
 await window.loadURL("data:text/html,<h1>Cleo recovered</h1>");
 window.show();
 await store.healthy(process.env.CLEO_EVOLUTION_TRANSACTION);
 await writeFile(${JSON.stringify(marker)}, JSON.stringify({ visible:window.isVisible(), data:await readFile(${JSON.stringify(join(dataHome, "data/latest.txt"))}, "utf8") }));
});
app.on("window-all-closed", () => app.quit());`;
  await packageApp(join(store.root, "builds/base/Cleo"), allFail ? bad : good);
  await packageApp(join(store.root, "builds/draft/Cleo"), bad);
  await store.update({ active: "base", baseline: "base", candidate: "draft", iteration: { base: "base" },
    builds: ["base", "draft"].map((id) => ({ id, kind: id === "base" ? "official" : "local", executable: "Cleo/Cleo.exe" })) });
  const transaction = await store.stage("draft");
  const parent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  await new Promise((done) => parent.once("spawn", done));
  const harness = join(directory, "controller");
  await mkdir(harness);
  await writeFile(join(harness, "package.json"), JSON.stringify({ name: "cleo-handoff-controller", type: "module", main: "main.mjs" }));
  await writeFile(join(harness, "main.mjs"), `import {app} from "electron";
import {EvolutionStore} from ${JSON.stringify(storeUrl)};
import {applyFromController} from ${JSON.stringify(moduleUrl)};
app.whenReady().then(() => applyFromController(new EvolutionStore(${JSON.stringify(store.root)},${JSON.stringify(dataHome)}), ${parent.pid})).then(() => app.quit()).catch((error) => { console.error(error); app.exit(1); });`);
  let application;
  let controllerProcess;
  try {
    application = await electron.launch({ args: [harness, `--user-data-dir=${profile}`], env: { ...process.env, CLEO_HOME: dataHome } });
    controllerProcess = application.process();
    const window = await application.firstWindow();
    await window.getByText("正在重启 Cleo", { exact: true }).waitFor();
    assert.ok(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()));
    const ready = await readJson(join(store.root, "handoffs", transaction.id + ".json"));
    assert.equal(ready.id, transaction.id);
    assert.equal(parent.exitCode, null, "Restart surface must be visible while the original app still runs.");
    parent.kill();
    if (allFail) {
      await window.getByText("Cleo 需要恢复", { exact: true }).waitFor({ timeout: 20000 });
      assert.ok(await window.getByRole("link", { name: "选择可用版本" }).isVisible());
      await application.evaluate(({ dialog }) => {
        globalThis.recoveryChoices = 0;
        dialog.showMessageBox = async (...args) => { globalThis.recoveryChoices += 1; return { response: args.at(-1).cancelId }; };
      });
      await window.getByRole("link", { name: "选择可用版本" }).click({ noWaitAfter: true });
      const choiceDeadline = Date.now() + 3000;
      while (!(await application.evaluate(() => globalThis.recoveryChoices)) && Date.now() < choiceDeadline) await new Promise((done) => setTimeout(done, 50));
      assert.equal(await application.evaluate(() => globalThis.recoveryChoices), 1, "The persistent recovery action must open the version selector.");
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      assert.ok(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
        "Failure must retain an interactive recovery surface.");
      await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
    } else {
      const deadline = Date.now() + 20000;
      while (controllerProcess.exitCode === null && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
      assert.notEqual(controllerProcess.exitCode, null, "Controller should finish only after fallback startup.");
      const result = JSON.parse(await readFile(marker, "utf8"));
      assert.deepEqual(result, { visible: true, data: "current data" });
      assert.equal((await store.read()).active, "base");
    }
    console.log(JSON.stringify({ status: "passed", scenario: allFail ? "all-failed-recovery-stays-visible" : "automatic-visible-fallback" }));
  } finally {
    parent.kill();
    if (controllerProcess?.exitCode === null) await execute("taskkill.exe", ["/PID", String(controllerProcess.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
    const escaped = directory.replaceAll("'", "''");
    await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${escaped}\\', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { windowsHide: true });
  }
}

try {
  await scenario(false);
  await scenario(true);
} finally {
  assert.equal(dirname(root), resolve(tmpdir()));
  assert.ok(root.includes("cleo-visible-handoff-"));
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
