import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Read frozen fixtures; run current source in temporary homes without writing acceptance receipts.
const source = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evolution = resolve(source, "..");
const state = JSON.parse(await readFile(join(evolution, "state.json"), "utf8"));
const resources = join(evolution, "builds", state.active, "Cleo/resources");
const python = join(resources, process.platform === "win32" ? "python/python.exe" : "python/bin/python3");
const cases = JSON.parse(await readFile(join(evolution, "acceptance/suite.json"), "utf8"))
  .filter((item) => item.enabled && item.kind === "dream-format");
assert.ok(cases.length, "No frozen Dream regressions available");
const runner = await readFile(join(source, "ui/electron/acceptance-dream.py"), "utf8");
const home = await mkdtemp(join(tmpdir(), "cleo-dream-regression-"));
try {
  await mkdir(join(home, "config"));
  for (const name of ["cleo.json", "harnesses.json"]) await copyFile(join(resources, "defaults/config", name), join(home, "config", name));
  const env = { ...process.env, CLEO_HOME: home, CLEO_CONFIG_PATH: join(home, "config/cleo.json"),
    CLEO_HARNESSES_CONFIG_PATH: join(home, "config/harnesses.json"), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
  delete env.PYTHONPATH;
  for (const item of cases) {
    const result = spawnSync(python, ["-I", "-c", `import sys; sys.path.insert(0, ${JSON.stringify(source)}); exec(${JSON.stringify(runner)})`],
      { cwd: home, env, input: JSON.stringify(item.fixture), encoding: "utf8", timeout: 60000, windowsHide: true });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    const replay = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.equal(replay.status, "passed", replay.detail);
    console.log(JSON.stringify({ id: item.id, ...replay }));
  }
} finally {
  assert.equal(dirname(home), resolve(tmpdir()));
  await rm(home, { recursive: true, force: true });
}
