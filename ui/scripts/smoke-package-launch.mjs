import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopPlatform } from "../electron/platform.mjs";

// Distribution check: a fresh installation must render and reach its bundled backend.
// Product buttons, workflows and optional integrations are deliberately not required.
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = desktopPlatform();
const executablePath = process.env.CLEO_EXECUTABLE
  || join(appDir, "..", "release", target.bundle, target.executable);
const testHome = await mkdtemp(join(tmpdir(), "cleo-package-launch-"));
const screenshotPath = join(appDir, "output", "playwright", "package-launch.png");
let application;
let window;
const crashes = [];

try {
  await mkdir(dirname(screenshotPath), { recursive: true });
  application = await electron.launch({
    executablePath,
    cwd: dirname(executablePath),
    args: [`--user-data-dir=${join(testHome, "electron-profile")}`],
    env: { ...process.env, CLEO_HOME: testHome, CLEO_CONFIG_PATH: "", CLEO_HARNESSES_CONFIG_PATH: "" },
    timeout: 60_000,
  });
  window = await application.firstWindow({ timeout: 60_000 });
  window.on("crash", () => crashes.push("Renderer process crashed"));
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(() => {
    const body = document.body;
    return body && body.getBoundingClientRect().height > 0
      && (body.innerText.trim().length > 0 || body.querySelector("canvas, svg, img"));
  }, null, { timeout: 30_000 });
  const connected = await window.evaluate(async () => {
    let timer;
    try {
      return await Promise.race([
        window.cleoDesktop.request("load_workspace").then(state => state.backend?.connected),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Backend startup timed out")), 30000); }),
      ]);
    } finally { clearTimeout(timer); }
  });
  if (!connected) throw new Error("The packaged backend did not become ready.");
  // Let startup settle; this checks process health without exercising features.
  await window.waitForTimeout(3_000);
  if (window.isClosed() || crashes.length) throw new Error(crashes.join("; ") || "Application closed during startup");
  await window.screenshot({ path: screenshotPath });
  console.log(JSON.stringify({ status: "passed", check: "package-launch", executablePath, screenshotPath }));
} catch (error) {
  if (window && !window.isClosed())
    await window.screenshot({ path: screenshotPath.replace(".png", "-failure.png") }).catch(() => {});
  throw error;
} finally {
  try {
    if (application) await application.close();
  } finally {
    // Only remove the unique temporary profile allocated by this check.
    if (dirname(testHome) !== resolve(tmpdir())) throw new Error("Unexpected temporary profile path");
    await rm(testHome, { recursive: true, force: true });
  }
}
