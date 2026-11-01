import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SourceTextModule, SyntheticModule, createContext } from "node:vm";
import { acquireSingleInstance } from "../../electron/install-state.mjs";

// Purpose: Evaluate the real entry module with fake Electron. Input: lock outcome. Output: events.
const accepted = process.argv[2] === "accepted";
const events = [];
const app = { isPackaged: true,
  requestSingleInstanceLock: () => { events.push("lock"); return accepted; },
  exit: code => { assert.equal(code, 0); events.push("exit"); }, on: () => {} };
const main = new URL("../../electron/main.mjs", import.meta.url);
const source = await readFile(main, "utf8");
const imports = new Map([...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)]
  .map(([, bindings, specifier]) => [specifier, bindings.split(",").map(name => name.trim()).filter(Boolean)]));
const context = createContext({ process: { argv: [] } });
const module = new SourceTextModule(source, { context, identifier: main.href,
  initializeImportMeta: meta => { meta.url = main.href; } });
await module.link(async specifier => {
  const names = imports.get(specifier);
  assert.ok(names, `Unrecognized entry import: ${specifier}`);
  const native = specifier.startsWith("node:") ? await import(specifier) : {};
  const values = Object.fromEntries(names.map(name => [name, native[name] ?? (() => {
    throw new Error(`Unexpected initialization: ${name}`);
  })]));
  if (specifier === "electron") values.app = app;
  if (specifier === "./install-state.mjs") values.acquireSingleInstance = acquireSingleInstance;
  if (specifier === "./release-channel.mjs") values.configureReleaseChannel = () => { events.push("scope"); return false; };
  if (specifier === "./computer/index.mjs") values.registerComputerSchemes = () => { events.push("schemes"); };
  if (specifier === "./backend.mjs") values.BackendBridge = class {
    constructor() { events.push("runtime"); throw new Error("desktop-runtime-initialized"); }
  };
  return new SyntheticModule(names, function () {
    for (const name of names) this.setExport(name, values[name]);
  }, { context });
});
if (accepted) {
  await assert.rejects(module.evaluate(), /desktop-runtime-initialized/);
  assert.deepEqual(events, ["scope", "lock", "schemes", "runtime"]);
} else {
  await module.evaluate();
  assert.deepEqual(events, ["scope", "lock", "exit"]);
}
console.log(JSON.stringify({ accepted, events }));
