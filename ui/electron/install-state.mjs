import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ACTIVE_PHASES = new Set(["starting", "verifying", "extracting", "waiting", "replacing"]);

export function installationPaths(tempRoot, executablePath) {
  const identity = resolve(dirname(executablePath)).toLowerCase();
  const key = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  const root = join(tempRoot, `cleo-install-${key}`);
  return { root, status: join(root, "status.json"), attention: join(root, "attention") };
}

export async function readInstallation(path) {
  try {
    return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      return { phase: "failed", error: "更新状态文件损坏，安装未确认完成。请重新检查更新。" };
    }
    throw error;
  }
}

export async function writeInstallation(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), "utf8");
  await rename(temporary, path);
}

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

export async function activeInstallation(paths, identity = processStartTime) {
  const state = await readInstallation(paths.status);
  if (!state || !ACTIVE_PHASES.has(state.phase)) return null;
  const running = state.processStartTime && await identity(state.pid) === state.processStartTime;
  const latest = await readInstallation(paths.status);
  if (!latest || latest.operationId !== state.operationId || latest.phase !== state.phase
      || latest.pid !== state.pid) return activeInstallation(paths, identity);
  if (running) return state;
  await writeInstallation(paths.status, {
    ...state, phase: "failed", error: "更新进程意外退出，安装未确认完成。请重新检查更新。",
  });
  return null;
}

export async function interceptUpdateStartup(paths, identity = processStartTime) {
  if (!await activeInstallation(paths, identity)) return false;
  // The short-lived attempted launch must release its executable immediately.
  // The independent progress window observes this signal and takes focus.
  await writeFile(paths.attention, String(Date.now()));
  return true;
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
