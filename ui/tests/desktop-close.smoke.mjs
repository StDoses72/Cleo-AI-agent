import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const tempRoot = resolve(process.env.CLEO_TEST_TEMP_DIR || tmpdir());
const root = await mkdtemp(join(tempRoot, "cleo-close-smoke-"));
const source = process.argv.includes("--source");
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let desktop;
let desktopProcess;
let tracked = [];
/** Purpose: Read only this test app's descendant process identities.
 * Input: Electron root pid. Output: pid/name/start time for checking cleanup without matching unrelated apps.
 */
async function descendants(pid) {
  const command = `$all = @(Get-CimInstance Win32_Process); $ids = [System.Collections.Generic.HashSet[uint32]]::new(); [void]$ids.Add(${pid}); do { $added = $false; foreach ($p in $all) { if ($ids.Contains([uint32]$p.ParentProcessId) -and $ids.Add([uint32]$p.ProcessId)) { $added = $true } } } while ($added); ConvertTo-Json -InputObject @($all | Where-Object { $ids.Contains([uint32]$_.ProcessId) } | Select-Object Name,ProcessId,CreationDate) -Compress`;
  const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true });
  return JSON.parse(stdout.trim() || "[]");
}
try {
  if (source) {
    const configRoot = join(root, "home", "config");
    await mkdir(configRoot, { recursive: true });
    const defaults = join(appDir, "..", "cleo", "config", "templates");
    const config = JSON.parse(await readFile(join(defaults, "cleo.example.json"), "utf8"));
    for (const profile of Object.values(config.profiles.agents)) {
      profile.api_key = "test-not-a-real-key";
      profile.base_url = "http://127.0.0.1:9/v1";
    }
    await writeFile(join(configRoot, "cleo.json"), JSON.stringify(config));
    await copyFile(join(defaults, "harnesses.example.json"), join(configRoot, "harnesses.json"));
  }
  desktop = await electron.launch({
    ...(source ? {} : { executablePath: resolve(process.env.CLEO_EXECUTABLE || "release/Cleo-evolution/Cleo.exe") }),
    args: [...(source ? [appDir] : []), `--user-data-dir=${join(root, "profile")}`],
    env: { ...process.env, CLEO_HOME: join(root, "home"), CLEO_CONFIG_PATH: "", CLEO_HARNESSES_CONFIG_PATH: "",
      HOME: join(root, "user"), USERPROFILE: join(root, "user"), CODEX_HOME: join(root, "user", ".codex") },
  });
  desktopProcess = desktop.process();
  const window = await desktop.firstWindow();
  await window.waitForFunction(() => Boolean(window.cleoDesktop), null, { timeout: 25000 });
  assert.equal(await window.evaluate(async () =>
    (await window.cleoDesktop.request("load_workspace")).backend.connected), true);
  tracked = await descendants(desktop.process().pid);
  assert.ok(tracked.some((item) => item.Name === "python.exe"), "The real backend must be running before closing.");
  await window.evaluate(() => { window.traySmokeSentinel = "preserved"; });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(desktopProcess.exitCode, null, "Closing the window should leave Cleo in the tray.");
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  assert.equal(await window.evaluate(async () =>
    (await window.cleoDesktop.request("load_workspace")).backend.connected), true,
  "The real backend must remain available while the main window is hidden.");
  const hidden = await descendants(desktopProcess.pid);
  for (const previous of tracked.filter(item => item.Name === "python.exe")) {
    assert.ok(hidden.some(item => item.ProcessId === previous.ProcessId && item.CreationDate === previous.CreationDate),
      "Hiding the window must preserve the running backend process.");
  }
  await desktop.evaluate(({ app }) => app.emit("activate"));
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  assert.equal(await window.evaluate(() => window.traySmokeSentinel), "preserved",
    "Restoring from the tray must preserve the renderer and its current work.");
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("cleo:open-memory"));
  await window.getByTestId("memory-nav-pending").waitFor();
  const initial = await window.evaluate(() => window.cleoDesktop.request("get_background_memory_state"));
  assert.equal(initial.enabled, false, "Automatic memory organization must be opt-in.");
  await window.getByRole("button", { name: "设置", exact: true }).click();
  await window.getByRole("button", { name: "记忆整理", exact: true }).click();
  const settings = window.getByRole("form", { name: "后台记忆整理设置" });
  const automatic = settings.getByRole("checkbox", { name: "后台记忆整理", exact: true });
  assert.equal(await automatic.isChecked(), false);
  await automatic.check();
  await settings.getByRole("spinbutton", { name: "整理间隔（分钟）" }).fill("12");
  await settings.getByRole("spinbutton", { name: "待整理会话数" }).fill("3");
  await settings.getByRole("button", { name: "保存后台设置" }).click();
  await settings.getByText("后台整理设置已保存", { exact: true }).waitFor();
  if (process.env.CLEO_TEST_SCREENSHOT) await window.screenshot({ path: process.env.CLEO_TEST_SCREENSHOT });
  const enabled = await window.evaluate(() => window.cleoDesktop.request("get_background_memory_state"));
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.intervalMinutes, 12);
  assert.equal(enabled.pendingThreshold, 3);
  await window.getByRole("button", { name: "关闭设置", exact: true }).click();
  await window.getByRole("button", { name: "设置", exact: true }).click();
  assert.equal(await automatic.isChecked(), true);
  assert.equal(await settings.getByRole("spinbutton", { name: "整理间隔（分钟）" }).inputValue(), "12");
  await automatic.uncheck();
  await settings.getByRole("button", { name: "保存后台设置" }).click();
  await settings.getByText("后台整理设置已保存", { exact: true }).waitFor();
  assert.equal(await window.evaluate(async () =>
    (await window.cleoDesktop.request("get_background_memory_state")).enabled), false);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const exited = new Promise((done) => desktopProcess.once("exit", done));
  await desktop.evaluate(({ app }) => app.quit());
  let timer;
  try {
    await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Explicit quit left Cleo running.")), 15000);
    })]);
  } finally { clearTimeout(timer); }
  const ids = tracked.map((item) => item.ProcessId).join(",");
  const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in @(${ids}) } | Select-Object Name,ProcessId,CreationDate) -Compress`],
  { windowsHide: true });
  const remaining = JSON.parse(stdout.trim() || "[]").filter((item) =>
    tracked.some((old) => old.ProcessId === item.ProcessId && old.CreationDate === item.CreationDate));
  console.log(JSON.stringify({ tracked: tracked.map(({ Name }) => Name), remaining }));
  assert.deepEqual(remaining, [], "Cleo or its backend/helper processes remained after explicit quit.");
} finally {
  const pid = desktopProcess?.pid;
  if (pid && desktopProcess.exitCode === null) {
    await execute("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
  }
  assert.equal(dirname(root), tempRoot);
  assert.ok(root.includes("cleo-close-smoke-"));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
