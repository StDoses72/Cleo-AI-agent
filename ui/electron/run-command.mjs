import { t as tr } from "./i18n.mjs";
import { spawn } from "node:child_process";

/** Purpose: Run an argument array without a shell. Input: executable, args, process options. Output: stdout or a bounded diagnostic tail. */
export async function run(command, args, { cwd, env = process.env, log = () => {}, timeout = 1_800_000, successCodes = [0], signal, outputMode = "capture", stdin = "ignore", trimOutput = true, rejectStderr = false } = {}) {
  signal?.throwIfAborted();
  if (!["capture", "tail"].includes(outputMode)) throw new Error(`Unknown command output mode: ${outputMode}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", windowsHide: true, stdio: [stdin, "pipe", "pipe"] });
    let output = "";
    let tail = "";
    let stderrTail = "";
    let timedOut = false;
    let oversized = false;
    const collect = (chunk, isStdout) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-64 * 1024);
      if (!isStdout) stderrTail = (stderrTail + text).slice(-64 * 1024);
      // Metadata must be complete; installation diagnostics only need a bounded tail.
      if (isStdout && outputMode === "capture" && !oversized) {
        if (output.length + text.length > 16 * 1024 * 1024) { oversized = true; output = ""; }
        else output += text;
      }
      log(text);
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => collect(chunk, true));
    child.stderr.setEncoding("utf8").on("data", (chunk) => collect(chunk, false));
    // Both cancellation and timeout stop descendants before releasing the operation.
    const stop = () => {
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill(); }
      }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    signal?.addEventListener("abort", stop, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (code) => {
      cleanup();
      if (signal?.aborted) { reject(signal.reason); return; }
      if (timedOut) { reject(new Error(tr("evolution_tools.the_operation_timed_out_and_its_process_was_stopped_review_the_logs_and_retry"))); return; }
      if (!successCodes.includes(code)) { reject(new Error(tr("evolution_tools.value_failed_value_value", { p0: command.split(/[\\/]/).at(-1), p1: code, p2: tail.slice(-3000) }))); return; }
      if (oversized) { reject(new Error(tr("evolution_tools.operation_output_exceeded_the_limit_the_incomplete_result_will_not_be_used"))); return; }
      if (rejectStderr && stderrTail) { reject(new Error(tr("evolution_tools.the_command_returned_diagnostics_so_complete_output_cannot_be_confirmed_check_source_", { p0: stderrTail.slice(-3000) }))); return; }
      const result = outputMode === "tail" ? tail : output;
      resolve(trimOutput ? result.trim() : result);
    });
  });
}
