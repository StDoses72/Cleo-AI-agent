import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";

const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "cleo-close-smoke-"));
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
  desktop = await electron.launch({
    executablePath: resolve(process.env.CLEO_EXECUTABLE || "release/Cleo-evolution/Cleo.exe"),
    args: [`--user-data-dir=${join(root, "profile")}`],
    env: { ...process.env, CLEO_HOME: join(root, "home"), CLEO_CONFIG_PATH: "", CLEO_HARNESSES_CONFIG_PATH: "" },
  });
  desktopProcess = desktop.process();
  const window = await desktop.firstWindow();
  await window.getByText("connected", { exact: true }).waitFor({ timeout: 25000 });
  tracked = await descendants(desktop.process().pid);
  assert.ok(tracked.some((item) => item.Name === "python.exe"), "The real backend must be running before closing.");
  const exited = new Promise((done) => desktopProcess.once("exit", done));
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  let timer;
  try {
    await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Closing the main window left Cleo running.")), 15000);
    })]);
  } finally { clearTimeout(timer); }
  const ids = tracked.map((item) => item.ProcessId).join(",");
  const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in @(${ids}) } | Select-Object Name,ProcessId,CreationDate) -Compress`],
  { windowsHide: true });
  const remaining = JSON.parse(stdout.trim() || "[]").filter((item) =>
    tracked.some((old) => old.ProcessId === item.ProcessId && old.CreationDate === item.CreationDate));
  console.log(JSON.stringify({ tracked: tracked.map(({ Name }) => Name), remaining }));
  assert.deepEqual(remaining, [], "Cleo or its backend/helper processes remained after closing.");
} finally {
  const pid = desktopProcess?.pid;
  if (pid && desktopProcess.exitCode === null) {
    await execute("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
  }
  assert.equal(dirname(root), resolve(tmpdir()));
  assert.ok(root.includes("cleo-close-smoke-"));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
