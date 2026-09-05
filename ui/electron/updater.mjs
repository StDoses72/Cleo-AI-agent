import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  copyFile,
  chmod,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { desktopPlatform, installationRoot } from "./platform.mjs";
import { installationPaths, processStartTime, readInstallation, writeInstallation } from "./install-state.mjs";

export const RELEASE_MANIFEST_URL =
  "https://github.com/StDoses72/Cleo-AI-agent/releases/latest/download/release.json";
export const RELEASE_ASSET_BASE_URL =
  "https://github.com/StDoses72/Cleo-AI-agent/releases/download/";

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

export function validateManifest(value, target = desktopPlatform()) {
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
    manifest.platform !== target.id ||
    manifest.archive !== target.archive ||
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

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export class DesktopUpdater {
  constructor({
    app,
    onState = () => {},
    fetchImpl = globalThis.fetch,
    spawnImpl = spawn,
    manifestUrl,
    assetBaseUrl = RELEASE_ASSET_BASE_URL,
    resourcesPath,
    executablePath = process.execPath,
    processId = process.pid,
    platform = process.platform,
    arch = process.arch,
    processIdentity = processStartTime,
  }) {
    this.app = app;
    this.onState = onState;
    this.fetchImpl = fetchImpl;
    this.spawnImpl = spawnImpl;
    this.target = desktopPlatform(platform, arch);
    this.manifestUrl = manifestUrl || new URL(this.target.manifest, RELEASE_MANIFEST_URL).href;
    this.assetBaseUrl = assetBaseUrl;
    this.resourcesPath = resourcesPath;
    this.executablePath = executablePath;
    this.processId = processId;
    this.processIdentity = processIdentity;
    this.manifest = null;
    this.archivePath = null;
    this.busy = null;
    this.packageManaged = platform === "linux" && resourcesPath
      && existsSync(join(resourcesPath, "package-manager"));
    this.state = {
      phase: app.isPackaged && !this.packageManaged ? "idle" : "unsupported",
      currentVersion: app.getVersion(),
      latestVersion: null,
      downloadedBytes: 0,
      totalBytes: 0,
      error: this.packageManaged ? "此 Linux 安装由系统软件包管理器维护，请安装新版 .deb 软件包更新。" : null,
    };
  }

  getState() {
    return { ...this.state };
  }

  posixResultPath() {
    const key = createHash("sha256").update(installationRoot(this.executablePath, this.target)).digest("hex").slice(0, 24);
    return join(this.app.getPath("userData"), `update-result-${key}.json`);
  }

  async takeInstallResult() {
    if (!this.app.isPackaged || this.target.platform === "win32") return null;
    const path = this.posixResultPath();
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      await rm(path);
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async restoreInstallationResult() {
    if (!this.app.isPackaged || this.target.platform !== "win32") return false;
    const paths = installationPaths(this.app.getPath("temp"), this.executablePath);
    const result = await readInstallation(paths.status);
    if (!result || result.acknowledged || !["completed", "failed"].includes(result.phase)) return false;
    const succeeded = result.phase === "completed" && result.version === this.app.getVersion();
    this.setState({
      phase: succeeded ? "updated" : "install-failed",
      latestVersion: result.version || null,
      error: succeeded ? null : result.error || "更新未完成，请重新检查更新。",
    });
    await writeInstallation(paths.status, { ...result, acknowledged: true });
    return true;
  }

  setState(update) {
    this.state = { ...this.state, ...update };
    this.onState(this.getState());
    return this.getState();
  }

  async check() {
    if (!this.app.isPackaged || this.packageManaged) return this.getState();
    if (this.state.phase === "installing") return this.getState();
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
      const manifest = validateManifest(await response.json(), this.target);
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
    if (!this.app.isPackaged || this.packageManaged) return this.getState();
    if (this.state.phase === "installing") return this.getState();
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
    const suffix = this.target.platform === "win32" ? "" : `-${this.target.id}`;
    const stagingRoot = join(this.app.getPath("temp"), `cleo-update-${manifest.version}${suffix}`);
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
    this.setState({ phase: "installing", error: null });
    try {
      await this.launchInstaller();
    } catch (error) {
      this.setState({
        phase: "ready",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    setImmediate(() => this.app.quit());
    return true;
  }

  async launchInstaller() {
    if (this.target.platform !== "win32") return this.launchPosixInstaller();
    const scriptSource = join(this.resourcesPath, "update.ps1");
    const scriptPath = join(dirname(this.archivePath), "update.ps1");
    await copyFile(scriptSource, scriptPath);
    const progressPath = join(dirname(this.archivePath), "update-progress.ps1");
    await copyFile(join(this.resourcesPath, "update-progress.ps1"), progressPath);
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
    const paths = installationPaths(this.app.getPath("temp"), this.executablePath);
    const operationId = randomUUID();
    const installerArguments = [
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
      "-Version",
      this.manifest.version,
      "-StatusPath",
      paths.status,
      "-OperationId",
      operationId,
      "-ProgressScript",
      progressPath,
    ].map((argument) => `"${argument}"`).join(" ");
    const stagingRoot = dirname(scriptPath);
    const starting = {
      operationId, phase: "starting", pid: this.processId,
      version: this.manifest.version, installRoot, error: null,
      processStartTime: await this.processIdentity(this.processId),
    };
    if (!starting.processStartTime) throw new Error("无法确认 Cleo 进程身份，请重试更新。");
    await writeInstallation(paths.status, starting);
    // Windows PowerShell can exit without running its script under Node's
    // detached flag. Start-Process gives the installer an independent lifetime.
    // Both processes must run outside the installation to avoid locking it.
    const launchCommand = [
      "$ErrorActionPreference = 'Stop'",
      `Start-Process -FilePath ${powershellLiteral(powershell)}`
        + ` -ArgumentList ${powershellLiteral(installerArguments)}`
        + ` -WorkingDirectory ${powershellLiteral(stagingRoot)}`
        + ` -RedirectStandardOutput ${powershellLiteral(join(stagingRoot, "install.log"))}`
        + ` -RedirectStandardError ${powershellLiteral(join(stagingRoot, "install-error.log"))}`
        + " -WindowStyle Hidden",
    ].join("; ");
    try {
      const child = this.spawnImpl(
        powershell,
        [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text",
          "-EncodedCommand", Buffer.from(launchCommand, "utf16le").toString("base64"),
        ],
        { cwd: stagingRoot, stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
      );
      let launchError = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { launchError = `${launchError}${chunk}`.slice(-8000); });
      let code;
      try {
        [code] = await once(child, "exit");
      } finally {
        // The independent installer may inherit a pipe handle; do not wait for
        // that pipe to close while the installer is waiting for Cleo to exit.
        child.stderr.destroy();
      }
      if (code !== 0) {
        throw new Error(launchError.trim() || `Unable to start the Cleo installer (exit code ${code}).`);
      }
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const status = await readInstallation(paths.status);
        if (status?.operationId === operationId && status.phase !== "starting") {
          if (status.phase === "failed") throw new Error(status.error || "更新程序启动失败。");
          if (status.pid !== this.processId) return;
        }
        await delay(100);
      }
      throw new Error("更新程序未确认启动，Cleo 将保持打开。请重试。");
    } catch (error) {
      await writeInstallation(paths.status, { ...starting, phase: "failed", error: error.message });
      throw error;
    }
  }

  async launchPosixInstaller() {
    const staging = dirname(this.archivePath);
    for (const file of ["posix-installer.mjs", "platform.mjs"]) {
      await copyFile(join(this.resourcesPath, "update", file), join(staging, file));
    }
    const node = join(staging, "node");
    await copyFile(join(this.resourcesPath, "browser", "node"), node);
    await chmod(node, 0o755);
    const requestPath = join(staging, "install-request.json");
    await writeFile(requestPath, JSON.stringify({
      platform: this.target.id, version: this.manifest.version,
      sha256: this.manifest.sha256, bytes: this.manifest.bytes,
      archive: this.archivePath, parentPid: this.processId,
      installRoot: installationRoot(this.executablePath, this.target), resultPath: this.posixResultPath(),
    }));
    const log = await open(join(staging, "install-error.log"), "w");
    let child;
    try {
      child = this.spawnImpl(node, [join(staging, "posix-installer.mjs"), requestPath], {
        cwd: staging, detached: true, stdio: ["ignore", "pipe", log.fd],
      });
    } finally {
      await log.close();
    }
    await new Promise((done, reject) => {
      const lines = createInterface({ input: child.stdout });
      const failed = (error) => { lines.close(); reject(error); };
      child.once("error", failed);
      child.once("exit", (code) => failed(new Error(`Update preparation failed (exit ${code}).`)));
      lines.on("line", (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === "ready") {
          lines.close();
          child.stdout.destroy();
          child.unref();
          done();
        } else if (event.type === "error") failed(new Error(event.error));
      });
    });
  }
}
