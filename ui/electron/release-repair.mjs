import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { run } from "./evolution-tools.mjs";

/** Launch a separate harness process so normal conversations and cancellation stay independent. */
export async function runReleaseRepair(backend, request, signal) {
  const paths = backend.runtimePaths();
  const input = join(dirname(request.source), "repair.json");
  await writeFile(input, JSON.stringify(request), { mode: 0o600 });
  await run(process.env.CLEO_PYTHON || paths.python || (process.platform === "win32" ? "python" : "python3"),
    ["-m", "cleo.desktop.release_repair", input], {
      cwd: paths.backendRoot, signal, timeout: 21 * 60 * 1000, outputMode: "tail",
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1",
        PYTHONPATH: backend.app.isPackaged ? "" : paths.backendRoot,
        PATH: backend.runtimePath(paths), CLEO_HOME: process.env.CLEO_HOME || paths.cleoHome,
        CLEO_EVOLUTION_WORKSPACE: request.source,
        CLEO_CONFIG_PATH: process.env.CLEO_CONFIG_PATH || paths.configPath,
        CLEO_HARNESSES_CONFIG_PATH: process.env.CLEO_HARNESSES_CONFIG_PATH || paths.harnessesPath,
        ...(paths.codexBin ? { CLEO_CODEX_BIN: paths.codexBin } : {}),
      },
    });
}
