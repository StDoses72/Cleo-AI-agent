import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import { join } from "node:path";

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

export async function processStartTime(pid) {
  if (!processIsAlive(pid)) return null;
  const powershell = join(process.env.SystemRoot || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await promisify(execFile)(powershell, ["-NoProfile", "-NonInteractive",
    "-Command", `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | ForEach-Object { $_.StartTime.ToUniversalTime().Ticks }`,
  ], { windowsHide: true, timeout: 5000 });
  return stdout.trim() || null;
}

/** Purpose: Detect an executable image that a running process still holds open.
 * Input: executable path. Output: true while Windows refuses write access to it; a missing file is not in use.
 * Windows maps a running program's image with a read-only share, so a write-mode open fails until it exits.
 */
export async function executableInUse(path, filesystem = fs) {
  let handle;
  try { handle = await filesystem.open(path, "r+"); }
  catch (error) {
    if (["EBUSY", "EPERM", "EACCES", "ETXTBSY"].includes(error.code)) return true;
    if (error.code === "ENOENT") return false;
    throw error;
  }
  await handle.close();
  return false;
}

/** Probe executable images before deleting any part of a runtime; never follow links.
 * Windows sharing violations and POSIX ETXTBSY defer the whole directory, including CLI children.
 */
export async function runtimeInUse(directory, filesystem = fs) {
  for (const name of await filesystem.readdir(directory)) {
    const path = join(directory, name);
    const info = await filesystem.lstat(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      if (await runtimeInUse(path, filesystem)) return true;
    } else if (info.isFile() && (process.platform === "win32"
      ? /\.(exe|dll|pyd|node)$/i.test(name) : (info.mode & 0o111) !== 0)) {
      if (await executableInUse(path, filesystem)) return true;
    }
  }
  return false;
}

export function acquireSingleInstance(app, windows) {
  if (!app.requestSingleInstanceLock()) return false;
  app.on("second-instance", () => {
    const window = windows().find((item) => !item.isDestroyed());
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  return true;
}
