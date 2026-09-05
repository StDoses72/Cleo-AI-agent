import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const windows = process.platform === "win32";
const command = windows ? "powershell.exe" : "uv";
const args = windows
  ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(scripts, "build-release.ps1")]
  : ["run", "--no-project", "--python", "3.12", join(scripts, "build-release.py")];
const result = spawnSync(command, [...args, ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
