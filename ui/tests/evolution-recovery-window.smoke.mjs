import assert from "node:assert/strict";
import { launchDesktop } from "../electron/evolution-launch.mjs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";

const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "cleo-recovery-window-"));
const executable = resolve(process.env.CLEO_EXECUTABLE || "release/Cleo-evolution/Cleo.exe");
const profile = join(root, "profile");
const control = join(profile, "evolution");
let child;
const inspectScript = `
param([int]$TargetPid, [switch]$Close)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WindowProbe {
 public delegate bool Callback(IntPtr window, IntPtr arg);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr arg);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
}
'@
$found = [System.Collections.Generic.List[object]]::new()
[WindowProbe]::EnumWindows({
 param($window, $argument)
 $ownerPid = 0
 [void][WindowProbe]::GetWindowThreadProcessId($window, [ref]$ownerPid)
 if ($ownerPid -eq $TargetPid) {
   $title = [System.Text.StringBuilder]::new(512)
   [void][WindowProbe]::GetWindowText($window, $title, 512)
   $found.Add([PSCustomObject]@{Title=$title.ToString(); Visible=[WindowProbe]::IsWindowVisible($window)})
   if ($Close) { [void][WindowProbe]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
 }
 return $true
}, [IntPtr]::Zero) | Out-Null
ConvertTo-Json -InputObject @($found.ToArray()) -Compress
`;
try {
  await mkdir(join(control, "builds/base/Cleo"), { recursive: true });
  await writeFile(join(control, "builds/base/Cleo/Cleo.exe"), "Never launched: cancel-only fixture.");
  await writeFile(join(control, "state.json"), JSON.stringify({
    baseline: "base", active: "base", builds: [{ id: "base", kind: "official", version: "fixture", executable: "Cleo/Cleo.exe" }],
  }));
  const probe = join(root, "windows.ps1");
  await writeFile(probe, inspectScript);
  const recoveryArgs = ["--cleo-recovery", `--user-data-dir=${profile}`];
  const environment = { ...process.env, CLEO_HOME: join(root, "home") };
  if (process.argv.includes("--reproduce-hidden")) {
    child = spawn(executable, recoveryArgs, { windowsHide: true, stdio: "ignore", env: environment });
    await new Promise((done, reject) => { child.once("spawn", done); child.once("error", reject); });
  } else child = await launchDesktop(executable, recoveryArgs, environment);
  await new Promise((done) => setTimeout(done, 1600));
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", probe, "-TargetPid", String(child.pid)];
  const { stdout } = await execute("powershell.exe", args, { windowsHide: true, timeout: 10000 });
  const windows = JSON.parse(stdout.trim() || "[]");
  await execute("powershell.exe", [...args, "-Close"], { windowsHide: true, timeout: 10000 });
  await new Promise((done) => setTimeout(done, 1000));
  console.log(JSON.stringify({ windows, exitedAfterClose: child.exitCode !== null }));
  assert.ok(windows.some((window) => window.Visible && window.Title.includes("Cleo")), "Recovery is still running with no visible recovery window.");
  assert.notEqual(child.exitCode, null, "Closing recovery left its process running.");
} finally {
  if (child?.pid && child.exitCode === null) {
    await execute("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
  }
  assert.equal(dirname(root), resolve(tmpdir()));
  assert.ok(root.includes("cleo-recovery-window-"));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
