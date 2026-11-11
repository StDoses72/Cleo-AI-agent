/** Real-package regression for a version switch: the program that takes over must confirm startup.
 *
 * It starts the package as the target of a pending switch, on a data home that already holds
 * conversations with large event logs and no timeline index, the way an update finds a user's
 * history. Startup must be confirmed without indexing those conversations: v0.13.0 rebuilt every
 * index before it answered, ran past the switch's 90-second check on a 700 MB history and was
 * rolled back. `--source` runs the same history checks against this checkout (no package, so no
 * switch to confirm); it needs CLEO_PYTHON.
 *
 * CLEO_SMOKE_HOME=<directory> uses that data home instead of the seeded one, to time a switch on a
 * copy of a real history before a release. Point it at a COPY: the program under test writes to it.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron } from "playwright";
import { desktopPlatform } from "../electron/platform.mjs";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = desktopPlatform();
const executablePath = process.env.CLEO_EXECUTABLE
  || join(ui, "../release", target.bundle, target.executable);
const root = await mkdtemp(join(tmpdir(), "cleo-managed-upgrade-"));
const profile = join(root, "profile");
const statePath = join(profile, "evolution/state.json");
const transactionId = "computer-managed-upgrade-smoke";
const handoffOnly = process.env.CLEO_SMOKE_HANDOFF_ONLY === "1";
const source = process.argv.includes("--source");
const suppliedHome = process.env.CLEO_SMOKE_HOME ? resolve(process.env.CLEO_SMOKE_HOME) : null;
const home = suppliedHome || join(root, "home");
// The program that starts a switch waits this long for the new one to confirm (waitHealthy).
const SWITCH_LIMIT_SECONDS = 90;
// Each log is larger than what the backend still indexes while listing (DEFER_REBUILD_BYTES, 64 KiB).
const HISTORY = ["cleo_upgrade_history_1", "cleo_upgrade_history_2", "cleo_upgrade_history_3", "cleo_upgrade_history_4"];
const sessionDirectory = id => join(home, "memory", "non_productivity", "projects", "general", "sessions", id);
let application;

/** Purpose: Give the data home conversations the way an earlier version left them, minus indexes.
 * Input: none. Output: chat sessions under the home's memory directory, each with a manifest and a
 * 200 KiB event log; the session index and every timeline index are left for the program to build.
 */
async function seedHistory() {
  for (const [number, id] of HISTORY.entries()) {
    const directory = sessionDirectory(id);
    await mkdir(directory, { recursive: true });
    const at = `2026-10-0${number + 1}T10:00:00.000000+00:00`;
    const base = { schema_version: 1, session_id: id, space: "non_productivity", project: "general", created_at: at };
    const events = [
      { ...base, id: `${id}-created`, seq: 1, type: "session_created", actor: "system",
        data: { provider: "cleo", owner_type: "user", native_session_id: null, owner_id: null, cwd: null,
          parent_session_id: null, tags: [] } },
      { ...base, id: `${id}-user`, seq: 2, type: "user_message", actor: "user", content: `History ${number + 1}` },
      { ...base, id: `${id}-answer`, seq: 3, type: "assistant_message", actor: "assistant",
        content: `Answer ${number + 1}. ${"A long reply from an earlier version. ".repeat(5400)}` },
      { ...base, id: `${id}-done`, seq: 4, type: "session_completed", actor: "system", data: { previous_status: "created" } },
    ];
    await writeFile(join(directory, "events.jsonl"), events.map(event => `${JSON.stringify(event)}\n`).join(""));
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ schema_version: 1, id, space: "non_productivity",
      project: "general", provider: "cleo", native_session_id: null, owner_type: "user", owner_id: null,
      status: "completed", title: `Upgrade history ${number + 1}`, cwd: null, parent_session_id: null, tags: [],
      last_event_seq: 4, created_at: at, updated_at: at }, null, 2));
    assert.ok((await stat(join(directory, "events.jsonl"))).size > 128 * 1024, "the seeded log must be large");
  }
}

/** Purpose: Count the seeded conversations whose timeline index the program has built.
 * Input: none. Output: how many hold projection metadata; a missing or table-only file counts as not built.
 */
function builtIndexes() {
  let built = 0;
  for (const id of HISTORY) {
    let database;
    try {
      database = new DatabaseSync(join(sessionDirectory(id), ".desktop-timeline-v1.sqlite3"), { readOnly: true });
      if (database.prepare("SELECT count(*) AS rows FROM metadata").get().rows) built += 1;
    } catch { /* No index file, or none of its tables yet. */ }
    finally { database?.close(); }
  }
  return built;
}

async function bounded(promise, timeout) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Owned Electron cleanup timed out")), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

/** Purpose: Call the owned package's bridge without assuming a shared descriptor filename.
 * Input: Fixture tool and arguments. Output: Authenticated local tool result.
 */
async function modelCall(name, args = {}) {
  const bridgePath = await application.evaluate(() => process.env.CLEO_COMPUTER_BRIDGE);
  assert.ok(typeof bridgePath === "string" && resolve(bridgePath).startsWith(resolve(profile) + (process.platform === "win32" ? "\\" : "/")),
    "The test must use only its own application's descriptor");
  const descriptor = JSON.parse(await readFile(bridgePath, "utf8"));
  return new Promise((resolveCall, reject) => {
    const socket = createConnection(descriptor.address);
    const timer = setTimeout(() => {
      socket.destroy(); reject(new Error(`Model tool ${name} did not return within 3 seconds`));
    }, 3000);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.once("close", () => clearTimeout(timer));
    socket.once("connect", () => socket.write(JSON.stringify({ token: descriptor.token,
      op: "call", identity: { thread_id: "upgrade-smoke" }, name, arguments: args }) + "\n"));
    socket.on("data", chunk => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      socket.destroy();
      const result = JSON.parse(buffer.slice(0, end));
      if (!result.ok) reject(new Error(result.error));
      else resolveCall(result.content);
    });
  });
}

/** Purpose: Capture a cached startup exception when the package never opens a window.
 * Input: The owned Electron application. Output: Diagnostic text without changing app source.
 */
async function startupFailure(app) {
  return app.evaluate(async () => {
    const vm = process.getBuiltinModule("node:vm");
    const url = "file:///" + process.resourcesPath.replaceAll("\\", "/") + "/app.asar/electron/main.mjs";
    try {
      await vm.runInThisContext(`import(${JSON.stringify(url)})`, {
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      });
      return "No cached main-module exception";
    } catch (error) { return error.message; }
  }).catch(error => error.message);
}

/** Purpose: Exercise the upgraded package's computer panel in the complete app.
 * Input: the main window. Output: assertions on the bridge, file previews, browser occlusion and screenshots.
 * A feature suite: the release gate (CLEO_SMOKE_HANDOFF_ONLY=1) stops after the handover.
 */
async function computerPanelChecks(window) {
  const computer = await window.evaluate(() => window.cleoDesktop.computer("state"));
  assert.equal(computer.bridgeError, "", "The upgraded computer bridge must start");
  const imagePreview = await window.evaluate(async root => {
    const preview = await window.cleoDesktop.files("read", { root, path: "preview.png" });
    return new Promise(resolve => {
      const image = new Image();
      image.onload = () => resolve({ loaded: true, width: image.naturalWidth });
      image.onerror = () => resolve({ loaded: false, width: 0 });
      image.src = preview.url;
    });
  }, root);
  assert.deepEqual(imagePreview, { loaded: true, width: 2 }, "The real UI session must render workspace images");
  // Exercise the complete app: settings dialogs stay mounted after closing.
  // A component-only fixture without retained dialogs misses permanent browser occlusion.
  // The runtime setup dialog opens only from Settings now; dismiss it if a build shows it at startup.
  await window.evaluate(() => window.cleoDesktop.setup("startup"));
  const onboarding = window.getByRole("dialog", { name: "运行环境", exact: true });
  if (await onboarding.isVisible()) {
    await onboarding.getByRole("button", { name: "稍后再说", exact: true }).click();
    await onboarding.waitFor({ state: "hidden" });
  }
  await window.getByTestId("new-task-in-section").click();
  const openInspector = window.getByRole("button", { name: "打开检查器", exact: true });
  if (await openInspector.isVisible()) await openInspector.click();
  await window.getByRole("tab", { name: "电脑", exact: true }).click();
  async function browserVisible(expected) {
    const deadline = Date.now() + 5_000;
    let visible;
    do {
      visible = await window.evaluate(async () => (await window.cleoDesktop.computer("state")).browser.visible);
      if (visible === expected) break;
      await new Promise(done => setTimeout(done, 100));
    } while (Date.now() < deadline);
    assert.equal(visible, expected, "The native browser must follow visible dialogs in the full app");
  }
  await browserVisible(true);
  await window.getByRole("button", { name: "设置", exact: true }).click();
  await browserVisible(false);
  await window.getByRole("button", { name: "关闭设置", exact: true }).click();
  await browserVisible(true);
  const firstShot = await modelCall("browser_screenshot");
  assert.equal(firstShot.some(block => block.type === "image"), true,
    "The model must receive its first screenshot before any webpage navigation");
}

try {
  await mkdir(dirname(statePath), { recursive: true });
  // The real handoff starts with existing state and these child/transaction variables.
  // A null baseline keeps this isolated fixture from pruning any retained build directories.
  await writeFile(statePath, JSON.stringify({ schema: 1, active: "candidate", baseline: null,
    builds: [], transaction: { id: transactionId, phase: "starting", from: "old", to: "candidate" } }));
  await writeFile(join(root, "preview.png"), Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==", "base64"));
  if (!suppliedHome) await seedHistory();
  if (source) {
    // A checkout has no installer to seed its configuration.
    const defaults = join(ui, "..", "cleo", "config", "templates");
    const config = JSON.parse(await readFile(join(defaults, "cleo.example.json"), "utf8"));
    for (const agent of Object.values(config.profiles.agents)) {
      agent.api_key = "test-not-a-real-key";
      agent.base_url = "http://127.0.0.1:9/v1";
    }
    await mkdir(join(home, "config"), { recursive: true });
    await writeFile(join(home, "config", "cleo.json"), JSON.stringify(config));
    await copyFile(join(defaults, "harnesses.example.json"), join(home, "config", "harnesses.json"));
  }
  const env = { ...process.env, CLEO_HOME: home, CLEO_CONFIG_PATH: "",
    CLEO_HARNESSES_CONFIG_PATH: "", CLEO_EVOLUTION_CHILD: "1", CLEO_EVOLUTION_TRANSACTION: transactionId };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLEO_DESKTOP_MOCK;
  const launchedAt = Date.now();
  application = await electron.launch({ ...(source ? {} : { executablePath }),
    cwd: source ? ui : dirname(executablePath),
    args: [...(source ? [ui] : []), `--user-data-dir=${profile}`], env, timeout: 30_000 });
  const window = await application.firstWindow({ timeout: 30_000 });
  // The same condition the switching program polls for, timed from the moment it starts this one.
  let confirmedSeconds = null;
  if (!source) {
    const deadline = launchedAt + SWITCH_LIMIT_SECONDS * 1000;
    let state;
    do {
      state = JSON.parse(await readFile(statePath, "utf8"));
      if (!state.transaction && state.lastApplication?.id === transactionId) break;
      await new Promise(done => setTimeout(done, 100));
    } while (Date.now() < deadline);
    confirmedSeconds = (Date.now() - launchedAt) / 1000;
    assert.equal(state.transaction, null,
      `Startup was not confirmed within the ${SWITCH_LIMIT_SECONDS} seconds a version switch allows`);
    assert.equal(state.lastApplication?.id, transactionId, "Health acknowledgment must match the handoff");
    assert.equal(state.active, "candidate");
    assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
  }
  await window.getByTestId("composer-input").waitFor({ timeout: 30_000 });
  const workspace = await window.evaluate(() => window.cleoDesktop.request("load_workspace"));
  assert.equal(workspace.backend.connected, true, "Managed startup must connect the real packaged backend");
  let built = null;
  if (!suppliedHome) {
    // Startup was confirmed with the earlier history on disk: every conversation is listed, and at
    // most the one the workspace opened had its index built. The others wait until they are opened.
    const listed = new Set(workspace.threads.map(thread => thread.id));
    assert.deepEqual(HISTORY.filter(id => !listed.has(id)), [], "Earlier conversations must be listed");
    built = builtIndexes();
    assert.ok(built <= 1, `Startup indexed ${built} of ${HISTORY.length} earlier conversations; only the open one may be`);
  }
  // The release gate stops here: the package took over a pending switch and confirmed startup.
  if (handoffOnly || source || suppliedHome) {
    console.log(JSON.stringify({ status: "passed", check: source ? "startup-history-source" : "managed-upgrade-handoff",
      realBackend: true, transactionAcknowledged: !source, confirmedSeconds,
      conversations: workspace.threads.length, indexedAtStartup: built }));
  } else {
    await computerPanelChecks(window);
    console.log(JSON.stringify({ status: "passed", check: "computer-managed-upgrade",
      realBackend: true, transactionAcknowledged: true, fullAppBrowserViewport: true,
      modelFirstScreenshot: true }));
  }
} catch (error) {
  const reason = application && !application.windows().length ? await startupFailure(application) : error.message;
  throw new Error(`Managed upgrade startup failed: ${reason}`, { cause: error });
} finally {
  if (application) {
    const child = application.process();
    await bounded(application.evaluate(({ app }) => { app.exit(0); }), 3000).catch(() => {});
    try { await bounded(application.close(), 3000); }
    catch (error) {
      if (child.exitCode === null && process.platform === "win32") {
        const taskkill = join(process.env.SystemRoot || "C:/Windows", "System32/taskkill.exe");
        await promisify(execFile)(taskkill, ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, timeout: 10_000 });
      } else if (child.exitCode === null) { child.kill("SIGKILL"); }
      if (child.exitCode === null) throw error;
    }
  }
  // Only the directory this run allocated is removed; a supplied data home is never touched here.
  assert.equal(dirname(root), resolve(tmpdir()), "Cleanup must stay inside our allocated test directory");
  await rm(root, { recursive: true, force: true });
}
