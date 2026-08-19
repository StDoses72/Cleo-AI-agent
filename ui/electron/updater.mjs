import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";

export const RELEASE_MANIFEST_URL =
  "https://github.com/StDoses72/Cleo-AI-agent/releases/latest/download/release.json";
export const RELEASE_ASSET_BASE_URL =
  "https://github.com/StDoses72/Cleo-AI-agent/releases/download/";

const UPDATE_ARCHIVE = "Cleo-windows-x64.zip";
const UPDATE_PLATFORM = "windows-x64";
const DOWNLOAD_ATTEMPTS = 5;

function parseVersion(value) {
  const match = String(value).trim().match(
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) throw new Error(`Invalid Cleo version: ${value}`);
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split(".") ?? [],
  };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.core.length; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length ? -1 : 1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) > Number(rightPart) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export function validateManifest(value) {
  if (!value || typeof value !== "object") throw new Error("The update manifest is invalid.");
  const manifest = {
    schemaVersion: Number(value.schema_version),
    app: String(value.app || ""),
    version: String(value.version || ""),
    platform: String(value.platform || ""),
    archive: String(value.archive || ""),
    sha256: String(value.sha256 || "").toLowerCase(),
    bytes: Number(value.bytes),
  };
  parseVersion(manifest.version);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.app !== "Cleo" ||
    manifest.platform !== UPDATE_PLATFORM ||
    manifest.archive !== UPDATE_ARCHIVE ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes <= 0
  ) {
    throw new Error("The update manifest contains unexpected release metadata.");
  }
  return manifest;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class DesktopUpdater {
  constructor({
    app,
    onState = () => {},
    fetchImpl = globalThis.fetch,
    spawnImpl = spawn,
    manifestUrl = RELEASE_MANIFEST_URL,
    assetBaseUrl = RELEASE_ASSET_BASE_URL,
    resourcesPath,
    executablePath = process.execPath,
    processId = process.pid,
  }) {
    this.app = app;
    this.onState = onState;
    this.fetchImpl = fetchImpl;
    this.spawnImpl = spawnImpl;
    this.manifestUrl = manifestUrl;
    this.assetBaseUrl = assetBaseUrl;
    this.resourcesPath = resourcesPath;
    this.executablePath = executablePath;
    this.processId = processId;
    this.manifest = null;
    this.archivePath = null;
    this.busy = null;
    this.state = {
      phase: app.isPackaged ? "idle" : "unsupported",
      currentVersion: app.getVersion(),
      latestVersion: null,
      downloadedBytes: 0,
      totalBytes: 0,
      error: null,
    };
  }

  getState() {
    return { ...this.state };
  }

  setState(update) {
    this.state = { ...this.state, ...update };
    this.onState(this.getState());
    return this.getState();
  }

  async check() {
    if (!this.app.isPackaged) return this.getState();
    if (this.busy) return this.busy;
    this.busy = this.checkInternal();
    try {
      return await this.busy;
    } finally {
      this.busy = null;
    }
  }

  async checkInternal() {
    this.setState({ phase: "checking", error: null });
    try {
      const response = await this.fetchImpl(this.manifestUrl, {
        headers: { "user-agent": `Cleo/${this.state.currentVersion}` },
        redirect: "follow",
      });
      if (!response.ok) throw new Error(`Update server returned HTTP ${response.status}.`);
      const manifest = validateManifest(await response.json());
      this.manifest = manifest;
      const available = compareVersions(manifest.version, this.state.currentVersion) > 0;
      return this.setState({
        phase: available ? "available" : "up-to-date",
        latestVersion: manifest.version,
        downloadedBytes: 0,
        totalBytes: manifest.bytes,
        error: null,
      });
    } catch (error) {
      return this.setState({
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async download() {
    if (!this.app.isPackaged) return this.getState();
    if (this.busy) return this.busy;
    this.busy = this.downloadInternal();
    try {
      return await this.busy;
    } finally {
      this.busy = null;
    }
  }

  async downloadInternal() {
    if (!this.manifest || this.state.phase !== "available") {
      await this.checkInternal();
    }
    if (!this.manifest || this.state.phase !== "available") return this.getState();

    const manifest = this.manifest;
    const stagingRoot = join(this.app.getPath("temp"), `cleo-update-${manifest.version}`);
    const archivePath = join(stagingRoot, manifest.archive);
    await mkdir(stagingRoot, { recursive: true });
    this.setState({
      phase: "downloading",
      downloadedBytes: 0,
      totalBytes: manifest.bytes,
      error: null,
    });
    try {
      await this.downloadArchive(
        new URL(`v${manifest.version.replace(/^v/, "")}/${manifest.archive}`, this.assetBaseUrl).href,
        archivePath,
        manifest.bytes,
      );
      const actualHash = await sha256(archivePath);
      if (actualHash !== manifest.sha256) {
        await rm(archivePath, { force: true });
        throw new Error("The downloaded update failed its SHA-256 verification.");
      }
      this.archivePath = archivePath;
      return this.setState({
        phase: "ready",
        downloadedBytes: manifest.bytes,
        totalBytes: manifest.bytes,
      });
    } catch (error) {
      return this.setState({
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async downloadArchive(url, path, expectedBytes) {
    let downloaded = 0;
    try {
      downloaded = (await stat(path)).size;
      if (downloaded > expectedBytes) {
        await rm(path, { force: true });
        downloaded = 0;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS && downloaded < expectedBytes; attempt += 1) {
      let file;
      try {
        const headers = downloaded ? { Range: `bytes=${downloaded}-` } : {};
        const response = await this.fetchImpl(url, { headers, redirect: "follow" });
        if (!response.ok && response.status !== 206) {
          throw new Error(`Update download returned HTTP ${response.status}.`);
        }
        if (!response.body) throw new Error("The update server returned an empty response.");
        if (downloaded && response.status !== 206) {
          await rm(path, { force: true });
          downloaded = 0;
        }
        file = await open(path, downloaded ? "a" : "w");
        let lastNotification = 0;
        for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk);
          await file.writeFile(buffer);
          downloaded += buffer.length;
          if (downloaded > expectedBytes) throw new Error("The update is larger than its manifest.");
          const now = Date.now();
          if (now - lastNotification >= 250 || downloaded === expectedBytes) {
            lastNotification = now;
            this.setState({ downloadedBytes: downloaded, totalBytes: expectedBytes });
          }
        }
        await file.close();
        file = null;
        if (downloaded < expectedBytes && attempt < DOWNLOAD_ATTEMPTS) await delay(1000 * attempt);
      } catch (error) {
        await file?.close().catch(() => {});
        if (attempt === DOWNLOAD_ATTEMPTS) throw error;
        try {
          downloaded = (await stat(path)).size;
        } catch {
          downloaded = 0;
        }
        await delay(1000 * attempt);
      }
    }
    if (downloaded !== expectedBytes) {
      throw new Error(`The update download is incomplete (${downloaded} of ${expectedBytes} bytes).`);
    }
  }

  async install() {
    if (!this.app.isPackaged || this.state.phase !== "ready" || !this.manifest || !this.archivePath) {
      return false;
    }
    const scriptSource = join(this.resourcesPath, "update.ps1");
    const scriptPath = join(dirname(this.archivePath), "update.ps1");
    await copyFile(scriptSource, scriptPath);
    const installRoot = dirname(this.executablePath);
    if (basename(this.executablePath).toLowerCase() !== "cleo.exe") {
      throw new Error("Cleo can only update a packaged Cleo.exe installation.");
    }
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const powershell = join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const child = this.spawnImpl(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-PackagePath",
        this.archivePath,
        "-Sha256",
        this.manifest.sha256,
        "-InstallRoot",
        installRoot,
        "-WaitForProcessId",
        String(this.processId),
        "-RemovePackage",
        "-Launch",
        "-NoPause",
      ],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    child.unref();
    this.setState({ phase: "installing", error: null });
    setImmediate(() => this.app.quit());
    return true;
  }
}
