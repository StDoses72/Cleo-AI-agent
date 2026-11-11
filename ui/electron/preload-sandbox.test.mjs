import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
// Electron 45 removed these from sandboxed preloads (sandbox: true); touching one throws "X is not defined" at runtime.
const removedGlobals = [/(?<![\w.])Buffer\b(?!\s*:)/, /(?<![\w.])setImmediate\b/, /(?<![\w.])clearImmediate\b/];
const removedModules = /require\(\s*["'](node:)?(events|timers|url|buffer|fs|path|os|child_process)["']/;

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

for (const name of ["preload.cjs"]) {
  test(`${name} only relies on what a sandboxed preload still provides`, async () => {
    const source = withoutComments(await readFile(join(here, name), "utf8"));
    for (const pattern of removedGlobals) {
      assert.doesNotMatch(source, pattern, `${name} must not use a global that sandboxed preloads lost: ${pattern}`);
    }
    assert.doesNotMatch(source, removedModules, `${name} may only require electron modules`);
  });
}

/** Purpose: Evaluate the real preload with a recording IPC. Input: UI language flag. Output: bridge and invoked channels. */
async function bridge(language) {
  const ipcRenderer = new EventEmitter();
  const invoked = [];
  ipcRenderer.invoke = async (channel, ...args) => { invoked.push([channel, ...args]); };
  const exposed = {};
  runInNewContext(await readFile(join(here, "preload.cjs"), "utf8"), {
    process: { platform: "win32", argv: [`--cleo-ui-language=${language}`] },
    require: () => ({ ipcRenderer, webUtils: {}, contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } } }),
  });
  return { desktop: exposed.cleoDesktop, ipcRenderer, invoked };
}

test("the bridge no longer exposes local evolution (ADR 0009)", async () => {
  const { desktop } = await bridge("zh-CN");
  for (const name of ["getEvolutionState", "evolutionAction", "onEvolutionState", "onCompanionThread"]) {
    assert.equal(desktop[name], undefined, `${name} should be gone`);
  }
});

test("startup confirmation and in-app recovery use the version switch channels", async () => {
  const { desktop, invoked } = await bridge("en");
  await desktop.confirmHealthy();
  await desktop.openRecovery();
  assert.deepEqual(invoked, [["cleo:program:healthy"], ["cleo:program:recovery"]]);
});
