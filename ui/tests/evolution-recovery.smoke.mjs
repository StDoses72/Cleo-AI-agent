import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createPackage } from "@electron/asar";
import { run } from "../electron/evolution-tools.mjs";

if (process.platform !== "win32") {
  console.log("Windows packaged recovery fault-injection test skipped on this platform.");
} else {
  const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const root = await mkdtemp(join(tmpdir(), "cleo-recovery-smoke-"));
  try {
    const app = join(root, "Cleo");
    await cp(join(ui, "node_modules/electron/dist"), app, { recursive: true });
    await rename(join(app, "electron.exe"), join(app, "Cleo.exe"));
    await rm(join(app, "resources/default_app.asar"), { force: true });
    const source = join(root, "source");
    await mkdir(join(source, "electron"), { recursive: true });
    for (const name of ["bootstrap.mjs", "evolution-store.mjs", "evolution-recovery.mjs", "evolution-launch.mjs", "evolution-progress.mjs", "evolution-handoff.mjs", "platform.mjs"]) {
      await cp(join(ui, "electron", name), join(source, "electron", name));
    }
    const bootstrap = join(source, "electron/bootstrap.mjs");
    const interception = [
      'import { dialog as smokeDialog } from "electron";',
      'import { appendFileSync as smokeLog } from "node:fs";',
      'smokeDialog.showMessageBox = async (options) => {',
      '  smokeLog(process.env.CLEO_SMOKE_DIALOGS, JSON.stringify(options) + "\\n");',
      '  return { response: process.env.CLEO_SMOKE_SELECT === "1" && options.title === "Cleo · 版本与恢复" ? 0 : options.cancelId ?? 0 };',
      '};',
      "",
    ].join("\n");
    await writeFile(bootstrap, interception + await readFile(bootstrap, "utf8"));
    await writeFile(join(source, "electron/main.mjs"), 'throw new Error("INTENTIONAL_BROKEN_MAIN");');
    await writeFile(join(source, "package.json"), JSON.stringify({
      name: "cleo-desktop", productName: "Cleo", version: "0.3.9", type: "module", main: "electron/bootstrap.mjs",
    }));
    await createPackage(source, join(app, "resources/app.asar"));
    const profile = join(root, "profile");
    const registry = join(profile, "evolution");
    await mkdir(registry, { recursive: true });
    await writeFile(join(registry, "state.json"), JSON.stringify({
      active: null, baseline: "known-good", builds: [
        { id: "known-good", kind: "official", version: "0.3.9", baseline: true, executable: "Cleo/Cleo.exe" },
      ],
    }));
    const log = join(root, "dialogs.jsonl");
    const env = { ...process.env, CLEO_HOME: join(root, "home"), CLEO_SMOKE_DIALOGS: log };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.CLEO_DESKTOP_MOCK;
    delete env.CLEO_EVOLUTION_CHILD;
    await run(join(app, "Cleo.exe"), [`--user-data-dir=${profile}`], { env, timeout: 30000 });
    const failure = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(failure.some((item) => item.detail?.includes("INTENTIONAL_BROKEN_MAIN")),
      "The fixture must demonstrate a broken main application.");
    await writeFile(log, "");
    await run(join(app, "Cleo.exe"), [`--user-data-dir=${profile}`, "--cleo-recovery"], { env, timeout: 30000 });
    const dialogs = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].title, "Cleo · 版本与恢复");
    assert.ok(dialogs[0].buttons.some((label) => label.includes("保底正式版")));
    // Boot an actual retained Electron package, then inspect the data it sees.
    const goodApp = join(registry, "builds/known-good/Cleo");
    await mkdir(dirname(goodApp), { recursive: true });
    await cp(app, goodApp, { recursive: true });
    const home = env.CLEO_HOME;
    const current = {
      "data/conversation.json": '{"messages":["before","after local change"]}',
      "memory/MEMORY.md": "Latest user memory",
      "config/cleo.json": '{"newSetting":"preserved"}',
      "skills/custom.md": "Latest custom skill",
    };
    for (const [name, value] of Object.entries(current)) {
      await mkdir(dirname(join(home, name)), { recursive: true });
      await writeFile(join(home, name), value);
    }
    const observed = join(root, "observed.json");
    await writeFile(join(source, "electron/main.mjs"), [
      'import { app } from "electron";',
      'import { readFile, writeFile } from "node:fs/promises";',
      'import { join } from "node:path";',
      'const current = {};',
      'for (const name of JSON.parse(process.env.CLEO_SMOKE_ENTRIES)) {',
      '  current[name] = await readFile(join(process.env.CLEO_HOME, name), "utf8");',
      '}',
      'await writeFile(process.env.CLEO_SMOKE_OBSERVED, JSON.stringify({ current, profile: app.getPath("userData"), home: process.env.CLEO_HOME }));',
      'app.quit();',
    ].join("\n"));
    await createPackage(source, join(goodApp, "resources/app.asar"));
    await writeFile(log, "");
    await run(join(app, "Cleo.exe"), [`--user-data-dir=${profile}`, "--cleo-recovery"], {
      env: { ...env, CLEO_SMOKE_SELECT: "1", CLEO_SMOKE_OBSERVED: observed,
        CLEO_SMOKE_ENTRIES: JSON.stringify(Object.keys(current)) }, timeout: 30000,
    });
    const deadline = Date.now() + 15000;
    let readBack;
    while (Date.now() < deadline) {
      try { readBack = JSON.parse(await readFile(observed, "utf8")); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(readBack, "The selected retained program must actually start.");
    assert.deepEqual(readBack.current, current);
    assert.equal(resolve(readBack.profile), resolve(profile));
    assert.equal(resolve(readBack.home), resolve(home));
    const selected = JSON.parse(await readFile(join(registry, "state.json"), "utf8"));
    assert.equal(selected.active, "known-good");
    assert.equal(selected.transaction, null);
    const recoveryDialogs = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(recoveryDialogs.length, 1, "Recovery must not ask to replace current user data.");
    console.log(JSON.stringify({ status: "passed", brokenMainDetected: true,
      independentRecoverySelectable: true, retainedProgramStarted: true, currentDataPreserved: true }));
  } catch (error) {
    console.error(await readFile(join(root, "dialogs.jsonl"), "utf8").catch(() => "No dialog was reached."));
    throw error;
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.includes("cleo-recovery-smoke-"));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
