import { spawn } from "node:child_process";

/** Purpose: Launch a user-facing Cleo process without hiding its first native window on Windows.
 * Input: executable, arguments and environment. Output: detached child after successful spawn.
 */
export function launchDesktop(executable, args, env = process.env) {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, {
      detached: true, windowsHide: false, stdio: "ignore", env,
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); done(child); });
  });
}
