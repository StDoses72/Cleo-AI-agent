import { t as tr } from "./i18n.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { desktopPlatform } from "./platform.mjs";
import { ReleaseDownloads } from "./release-downloads.mjs";
import { releaseTagForVersion } from "./release-channel.mjs";

export const RELEASE_MANIFEST_URL =
  "https://github.com/StDoses72/Cleo-AI-agent/releases/latest/download/release.json";
export const RELEASE_ASSET_BASE_URL =
  "https://github.com/StDoses72/Cleo-AI-agent/releases/download/";

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
    ![1, 2].includes(manifest.schemaVersion) ||
    (manifest.schemaVersion === 2 && value.evolution_protocol !== 3) ||
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

export class DesktopUpdater {
  constructor({
    app,
    onState = () => {},
    fetchImpl = globalThis.fetch,
    manifestUrl,
    assetBaseUrl = RELEASE_ASSET_BASE_URL,
    resourcesPath,
    platform = process.platform,
    arch = process.arch,
    downloads,
  }) {
    this.app = app;
    this.onState = onState;
    this.fetchImpl = fetchImpl;
    this.target = desktopPlatform(platform, arch);
    this.manifestUrl = manifestUrl || new URL(this.target.manifest, RELEASE_MANIFEST_URL).href;
    this.assetBaseUrl = assetBaseUrl;
    this.resourcesPath = resourcesPath;
    this.downloads = downloads;
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
      error: this.packageManaged ? tr("updater.this_linux_installation_is_managed_by_the_system_package_manager_install_a_newer_deb_") : null,
    };
  }

  getState() {
    return { ...this.state };
  }

  archiveFor(manifest) {
    return this.releaseDownloads().pathFor(manifest);
  }

  releaseDownloads() {
    this.downloads ??= new ReleaseDownloads({
      root: join(this.app.getPath("userData"), "evolution", "downloads"),
      fetchImpl: this.fetchImpl,
      legacyPaths: (manifest) => {
        const suffix = this.target.platform === "win32" ? "" : `-${this.target.id}`;
        return [join(this.app.getPath("temp"), `cleo-update-${manifest.version}${suffix}`, manifest.archive)];
      },
    });
    return this.downloads;
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
      const ready = available && this.archivePath && this.archivePath === this.archiveFor(manifest);
      return this.setState({
        phase: ready ? "ready" : available ? "available" : "up-to-date",
        latestVersion: manifest.version,
        downloadedBytes: ready ? manifest.bytes : 0,
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
    this.setState({
      phase: "downloading",
      downloadedBytes: 0,
      totalBytes: manifest.bytes,
      error: null,
    });
    try {
      this.archivePath = await this.releaseDownloads().get(manifest, {
        url: new URL(`${releaseTagForVersion(manifest.version)}/${manifest.archive}`, this.assetBaseUrl).href,
        onProgress: (downloadedBytes, totalBytes) => this.setState({ downloadedBytes, totalBytes }),
      });
      // A verified download is available, but does not authorize installation on a later launch.
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

  /** Purpose: Hand a verified download to the evolution version switch; Cleo never replaces itself in place.
   * Input: switch callback receiving the manifest version. Output: true once the callback reports a completed switch.
   */
  async install(installVersion) {
    if (!this.app.isPackaged || this.state.phase !== "ready" || !this.manifest || !this.archivePath) {
      return false;
    }
    if (typeof installVersion !== "function") throw new Error(tr("updater.version_switching_did_not_complete_check_for_updates_and_retry"));
    this.setState({ phase: "installing", error: null });
    try {
      const switched = await installVersion(this.manifest.version);
      if (!switched) throw new Error(tr("updater.version_switching_did_not_complete_check_for_updates_and_retry"));
      return true;
    } catch (error) {
      this.setState({
        phase: "install-failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
