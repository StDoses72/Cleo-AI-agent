import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createPackage } from "@electron/asar";
import { run } from "../electron/evolution-tools.mjs";
import { EvolutionStore } from "../electron/evolution-store.mjs";

if (process.platform !== "win32") {
  console.log("Windows installed-release startup smoke skipped on this platform.");
} else {
  const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const root = await mkdtemp(join(tmpdir(), "cleo-installed-smoke-"));
  try {
    const bundle = join(root, "installed/Cleo");
    await cp(join(ui, "node_modules/electron/dist"), bundle, { recursive: true });
    await rename(join(bundle, "electron.exe"), join(bundle, "Cleo.exe"));
    await rm(join(bundle, "resources/default_app.asar"));
    // Match the real builders: every official package also carries its source snapshot.
    await run(process.execPath, [join(ui, "../scripts/bundle-evolution-source.mjs"), join(bundle, "resources")]);
    const source = join(root, "source");
    await mkdir(source);
    await cp(join(ui, "electron"), join(source, "electron"), { recursive: true });
    // Intercept dialogs so a startup failure fails the smoke rather than waiting for a human.
    const bootstrap = join(source, "electron/bootstrap.mjs");
    await writeFile(bootstrap, 'import { dialog as smokeDialog } from "electron";\n'
      + 'smokeDialog.showMessageBox = async options => { console.error(JSON.stringify(options)); throw new Error("Unexpected startup dialog"); };\n'
      + await readFile(bootstrap, "utf8"));
    await writeFile(join(source, "electron/main.mjs"), `import { app, BrowserWindow } from "electron";
import { appendFile } from "node:fs/promises";
void app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) throw new Error("Startup lock is still held");
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  await window.loadURL("data:text/html,<h1>Installed release fixture</h1>");
  await window.webContents.executeJavaScript('require("electron").ipcRenderer.invoke("cleo:evolution:healthy")');
  await appendFile(process.env.CLEO_SMOKE_STARTED, JSON.stringify({ version: app.getVersion(), executable: process.execPath }) + "\\n");
  setTimeout(() => app.quit(), 1000);
}).catch(error => { console.error(error); app.exit(1); });`);
    async function pack(directory, version) {
      await writeFile(join(source, "package.json"), JSON.stringify({ name: "cleo-desktop", type: "module", version, main: "electron/bootstrap.mjs" }));
      await createPackage(source, join(directory, "resources/app.asar"));
      await writeFile(join(directory, "release.json"), JSON.stringify({ app: "Cleo", schema_version: 1,
        version, platform: "windows-x64", evolution_protocol: 2 }));
    }
    const profile = join(root, "profile");
    const store = new EvolutionStore(join(profile, "evolution"), join(root, "home"));
    const oldBundle = join(store.root, "builds/old/Cleo");
    await cp(bundle, oldBundle, { recursive: true });
    await pack(oldBundle, "0.3.10");
    await pack(bundle, "0.4.0");
    await store.update({ active: "old", baseline: "old", workspaceBase: "old", builds: [
      { id: "old", kind: "official", version: "0.3.10", baseTag: "v0.3.10", executable: "Cleo/Cleo.exe", baseline: true },
    ] });
    await mkdir(join(store.dataHome, "data"), { recursive: true });
    await writeFile(join(store.dataHome, "data/chat.txt"), "current chat and memory");
    const started = join(root, "started.jsonl");
    const env = { ...process.env, CLEO_HOME: store.dataHome, CLEO_SMOKE_STARTED: started };
    for (const key of ["ELECTRON_RUN_AS_NODE", "CLEO_DESKTOP_MOCK", "CLEO_EVOLUTION_CHILD", "CLEO_EVOLUTION_TRANSACTION"]) delete env[key];
    const executable = join(bundle, "Cleo.exe");
    async function launch() {
      const before = (await readFile(started, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; })).trim().split("\n").filter(Boolean).length;
      await run(executable, [`--user-data-dir=${profile}`], { env, timeout: 60000 });
      const deadline = Date.now() + 10000;
      let entries = [];
      while (Date.now() < deadline) {
        entries = (await readFile(started, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; })).trim().split("\n").filter(Boolean).map(JSON.parse);
        if (entries.length > before) break;
        await new Promise(done => setTimeout(done, 50));
      }
      assert.equal(entries.length, before + 1, "Exactly one selected application must start");
      // The selected detached fixture exits one second after acknowledging startup.
      await new Promise(done => setTimeout(done, 1200));
      return entries.at(-1);
    }
    const first = await launch();
    assert.equal(first.version, "0.4.0");
    const activated = await store.read();
    assert.equal(activated.transaction, null);
    assert.equal(activated.baseTag, "v0.4.0");
    assert.equal(activated.builds.find(build => build.id === activated.active).kind, "official");
    assert.equal((await launch()).executable, first.executable, "Repeated opening must reuse the selected package");
    await store.recover("old");
    await store.update({ workspaceBase: "old", selectedBase: "old" });
    await store.pruneBuilds();
    assert.equal((await launch()).version, "0.3.10", "A deliberate rollback must remain selected");
    assert.equal(await readFile(join(store.dataHome, "data/chat.txt"), "utf8"), "current chat and memory");
    console.log(JSON.stringify({ status: "passed", newInstallationStartsNewRelease: true,
      repeatedLaunchReusesBuild: true, deliberateRollbackPreserved: true, currentDataPreserved: true }));
  } finally {
    // Only stop fixture processes from this test's owned directory before removing it.
    const literal = root.replaceAll("'", "''");
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${literal}\\', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`]);
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
