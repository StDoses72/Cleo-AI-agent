/** Real-package regression for applying a computer-use upgrade with existing evolution state. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
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
let application;

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
  const env = { ...process.env, CLEO_HOME: join(root, "home"), CLEO_CONFIG_PATH: "",
    CLEO_HARNESSES_CONFIG_PATH: "", CLEO_EVOLUTION_CHILD: "1", CLEO_EVOLUTION_TRANSACTION: transactionId };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLEO_DESKTOP_MOCK;
  application = await electron.launch({ executablePath, cwd: dirname(executablePath),
    args: [`--user-data-dir=${profile}`], env, timeout: 30_000 });
  const window = await application.firstWindow({ timeout: 15_000 });
  await window.getByTestId("composer-input").waitFor({ timeout: 30_000 });
  const connected = await window.evaluate(async () =>
    (await window.cleoDesktop.request("load_workspace")).backend.connected);
  assert.equal(connected, true, "Managed startup must connect the real packaged backend");
  const deadline = Date.now() + 15_000;
  let state;
  do {
    state = JSON.parse(await readFile(statePath, "utf8"));
    if (!state.transaction && state.lastApplication?.id === transactionId) break;
    await new Promise(done => setTimeout(done, 100));
  } while (Date.now() < deadline);
  assert.equal(state.transaction, null, "The real UI must acknowledge managed startup");
  assert.equal(state.lastApplication?.id, transactionId, "Health acknowledgment must match the handoff");
  assert.equal(state.active, "candidate");
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
  // The release gate stops here: the package took over a pending switch and confirmed startup.
  if (handoffOnly) {
    console.log(JSON.stringify({ status: "passed", check: "managed-upgrade-handoff",
      realBackend: true, transactionAcknowledged: true }));
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
  assert.equal(dirname(root), resolve(tmpdir()), "Cleanup must stay inside our allocated test directory");
  await rm(root, { recursive: true, force: true });
}
