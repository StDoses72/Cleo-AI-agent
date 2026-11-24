/** Installs what the user's browser needs to reach Cleo: the unpacked Cleo extension and the
 * native messaging host that relays between the extension and the running app.
 *
 * Everything lives under Cleo's user data (``browser-extension``), outside the app archive, so
 * the browser can load the extension folder and launch the host. The host runs on Cleo's own
 * executable in Node mode, so no extra runtime is installed. Registration is per user: on
 * Windows a value under HKCU for each Chromium browser, elsewhere a manifest file in each
 * browser's NativeMessagingHosts folder. Nothing is written until the user asks to connect a
 * browser, and refreshes after that keep the paths current across Cleo updates.
 */

import { execFile, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const NATIVE_HOST_NAME = "ai.cleo.browser";
/** Fixed by the public key in extension/manifest.json, so the host can allow exactly this extension. */
export const EXTENSION_ID = "amhjfgfphlnaohlaoakngcopnpklaocd";

const WINDOWS_KEYS = {
  chrome: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts",
  edge: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts",
  brave: "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts",
  chromium: "HKCU\\Software\\Chromium\\NativeMessagingHosts",
};

function posixHostDirs(platform, home) {
  if (platform === "darwin") {
    const base = join(home, "Library", "Application Support");
    return { chrome: join(base, "Google", "Chrome"), edge: join(base, "Microsoft Edge"), brave: join(base, "BraveSoftware", "Brave-Browser"), chromium: join(base, "Chromium") };
  }
  const base = join(home, ".config");
  return { chrome: join(base, "google-chrome"), edge: join(base, "microsoft-edge"), brave: join(base, "BraveSoftware", "Brave-Browser"), chromium: join(base, "chromium") };
}

/** Purpose: Where each supported browser is installed. Output: [{ kind, name, executable }]. */
export function installedBrowsers({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const candidates = { chrome: [], edge: [] };
  if (platform === "win32") {
    for (const root of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean)) {
      candidates.chrome.push(join(root, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.edge.push(join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  } else if (platform === "darwin") {
    candidates.chrome.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    candidates.edge.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  } else {
    candidates.chrome.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable");
    candidates.edge.push("/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable");
  }
  const names = { chrome: "Chrome", edge: "Microsoft Edge" };
  return Object.entries(candidates).map(([kind, paths]) => ({ kind, name: names[kind], executable: paths.find(path => exists(path)) || null }));
}

export class UserBrowserSetup {
  constructor({ userData, bridgeDirectory, executable = process.execPath, platform = process.platform, home = homedir(), run = execFile, launch = spawn }) {
    Object.assign(this, { userData, bridgeDirectory, executable, platform, home, run, launch });
    this.root = join(userData, "browser-extension");
    this.extensionDir = join(this.root, "extension");
    this.hostDir = join(this.root, "host");
  }

  /** Purpose: Write the extension and host files and register the host. Output: paths. */
  async prepare() {
    mkdirSync(this.extensionDir, { recursive: true });
    mkdirSync(this.hostDir, { recursive: true });
    // Copied from the app (possibly inside app.asar, which Electron's fs reads transparently).
    for (const name of readdirSync(join(here, "extension"))) copyFileSync(join(here, "extension", name), join(this.extensionDir, name));
    writeFileSync(join(this.hostDir, "host.mjs"), readFileSync(join(here, "native-host.mjs")));
    writeFileSync(join(this.hostDir, "host-config.json"), `${JSON.stringify({ bridgeDirectory: this.bridgeDirectory }, null, 2)}\n`);
    const launcher = this.platform === "win32" ? join(this.hostDir, "cleo-browser-host.cmd") : join(this.hostDir, "cleo-browser-host.sh");
    if (this.platform === "win32") {
      writeFileSync(launcher, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${this.executable}" "${join(this.hostDir, "host.mjs")}" --cleo-native-host %*\r\n`);
    } else {
      writeFileSync(launcher, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${this.executable}" "${join(this.hostDir, "host.mjs")}" --cleo-native-host "$@"\n`);
      chmodSync(launcher, 0o755);
    }
    const manifest = { name: NATIVE_HOST_NAME, description: "Cleo browser link", path: launcher, type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] };
    const manifestPath = join(this.hostDir, `${NATIVE_HOST_NAME}.json`);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await this.register(manifestPath, manifest);
    return { extensionDir: this.extensionDir, manifestPath };
  }

  async register(manifestPath, manifest) {
    if (this.platform === "win32") {
      const reg = join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "reg.exe");
      for (const key of Object.values(WINDOWS_KEYS)) {
        await new Promise((resolve, reject) => this.run(reg, ["add", `${key}\\${NATIVE_HOST_NAME}`, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"],
          { windowsHide: true }, error => (error ? reject(error) : resolve())));
      }
      return;
    }
    for (const dir of Object.values(posixHostDirs(this.platform, this.home))) {
      if (!existsSync(dir)) continue;
      const target = join(dir, "NativeMessagingHosts");
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, `${NATIVE_HOST_NAME}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }

  /** Purpose: Open the browser's extension page so the user can load the unpacked extension. */
  openExtensionsPage(kind) {
    const browser = installedBrowsers({ platform: this.platform }).find(item => item.kind === kind);
    if (!browser?.executable) return false;
    const child = this.launch(browser.executable, [kind === "edge" ? "edge://extensions/" : "chrome://extensions/"], { detached: true, stdio: "ignore" });
    child.unref?.();
    return true;
  }
}
