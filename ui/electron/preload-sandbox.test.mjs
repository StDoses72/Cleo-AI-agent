import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
// Electron 45 removed these from sandboxed preloads (sandbox: true); touching one throws "X is not defined" at runtime.
const removedGlobals = [/(?<![\w.])Buffer\b(?!\s*:)/, /(?<![\w.])setImmediate\b/, /(?<![\w.])clearImmediate\b/];
const removedModules = /require\(\s*["'](node:)?(events|timers|url|buffer|fs|path|os|child_process)["']/;

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

for (const name of ["preload.cjs", "evolution-monitor-preload.cjs"]) {
  test(`${name} only relies on what a sandboxed preload still provides`, async () => {
    const source = withoutComments(await readFile(join(here, name), "utf8"));
    for (const pattern of removedGlobals) {
      assert.doesNotMatch(source, pattern, `${name} must not use a global that sandboxed preloads lost: ${pattern}`);
    }
    assert.doesNotMatch(source, removedModules, `${name} may only require electron modules`);
  });
}
