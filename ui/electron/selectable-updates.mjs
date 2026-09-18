import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { DesktopUpdater, compareVersions, validateManifest } from "./updater.mjs";
import { ProgramUpdates } from "./program-updates.mjs";
import { exists, ownedPath } from "./evolution-store.mjs";
import { alphaTagPattern, versionForReleaseTag } from "./release-channel.mjs";

const repository = "StDoses72/Cleo-AI-agent";
const api = `https://api.github.com/repos/${repository}/releases`;
const assetUrl = (tag, name) => `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${name}`;

/** Remote choices and selected manifests are session state; older programs share no new format. */
export class SelectableUpdater extends DesktopUpdater {
  selectedRelease = null;
  catalog = [];

  async json(url) {
    const response = await this.fetchImpl(url, { headers: { "user-agent": `Cleo/${this.state.currentVersion}` }, redirect: "follow" });
    if (!response.ok) throw new Error(`GitHub 版本请求失败（HTTP ${response.status}），请重试。`);
    return response.json();
  }

  async refreshCatalog() {
    const releases = [];
    for (let page = 1; ; page++) {
      const items = await this.json(`${api}?per_page=100&page=${page}`);
      if (!Array.isArray(items)) throw new Error("GitHub 返回的版本列表无效。");
      for (const item of items.filter(item => !item.draft)) {
        const assets = item.assets || [];
        const reason = !versionForReleaseTag(item.tag_name) ? "版本标签不受支持"
          : alphaTagPattern.test(item.tag_name) && !item.prerelease ? "实验版必须标记为预发布"
          : !assets.some(asset => asset.name === this.target.manifest) ? "缺少当前平台的版本清单"
            : !assets.some(asset => asset.name === this.target.archive) ? "缺少当前平台的安装包" : null;
        releases.push({ tag: item.tag_name, title: item.name || item.tag_name, prerelease: Boolean(item.prerelease),
          publishedAt: item.published_at, url: item.html_url, reason,
          manifestUrl: assetUrl(item.tag_name, this.target.manifest), archiveUrl: assetUrl(item.tag_name, this.target.archive) });
      }
      if (items.length < 100) break;
    }
    this.catalog = releases;
    this.setState({ releases, currentPrerelease: releases.find(item => versionForReleaseTag(item.tag) === this.state.currentVersion)?.prerelease });
    return releases;
  }

  select(tag) {
    if (this.busy || this.state.phase === "installing") throw new Error("版本操作正在进行，请完成后再改选。");
    const release = this.catalog.find(item => item.tag === tag);
    if (!release || release.reason) throw new Error(release?.reason || "请重新检查并选择可安装版本。");
    this.selectedRelease = release;
    this.manifest = null;
    this.archivePath = null;
    this.setState({ selectedTag: tag, selectedPrerelease: release.prerelease, latestVersion: null,
      phase: "idle", downloadedBytes: 0, totalBytes: 0, error: null });
  }

  async checkInternal() {
    this.setState({ phase: "checking", error: null });
    try {
      await this.refreshCatalog();
      if (!this.selectedRelease) {
        // Automatic checks still follow stable releases. Historical/prerelease choices are explicit.
        const stable = this.catalog.filter(item => !item.prerelease && !item.reason)
          .sort((a, b) => compareVersions(b.tag, a.tag))[0];
        if (!stable) throw new Error("没有适用于当前平台的正式版本，请选择其他可用版本。");
        this.checkedRelease = stable;
      } else {
        this.checkedRelease = this.catalog.find(item => item.tag === this.selectedRelease.tag);
        if (!this.checkedRelease || this.checkedRelease.reason) throw new Error("所选版本已不可用，请重新选择。");
        this.selectedRelease = this.checkedRelease;
      }
      const release = this.checkedRelease;
      const raw = await this.json(release.manifestUrl);
      const manifest = validateManifest(raw, this.target);
      if (raw.evolution_protocol !== 2) throw new Error("该版本不支持保留当前数据的版本切换。");
      if (manifest.version !== versionForReleaseTag(release.tag)) throw new Error("版本清单与所选版本不一致。");
      this.manifest = manifest;
      const available = Boolean(this.selectedRelease) || compareVersions(manifest.version, this.state.currentVersion) > 0;
      const ready = available && this.archivePath === this.archiveFor(manifest);
      return this.setState({ phase: ready ? "ready" : available ? "available" : "up-to-date", latestVersion: manifest.version,
        checkedAt: Date.now(),
        selectedTag: this.selectedRelease?.tag || null, selectedPrerelease: release.prerelease,
        downloadedBytes: ready ? manifest.bytes : 0, totalBytes: manifest.bytes, error: null });
    } catch (error) {
      this.manifest = null; this.archivePath = null;
      return this.setState({ phase: "error", error: error.message, checkedAt: Date.now() });
    }
  }

  async downloadInternal() {
    if (!this.manifest || this.state.phase !== "available") await this.checkInternal();
    if (!this.manifest || this.state.phase !== "available") return this.getState();
    const manifest = this.manifest;
    this.setState({ phase: "downloading", downloadedBytes: 0, totalBytes: manifest.bytes, error: null });
    try {
      this.archivePath = await this.releaseDownloads().get(manifest, { url: this.checkedRelease.archiveUrl,
        onProgress: (downloadedBytes, totalBytes) => this.setState({ downloadedBytes, totalBytes }) });
      return this.setState({ phase: "ready", downloadedBytes: manifest.bytes, totalBytes: manifest.bytes });
    } catch (error) {
      this.archivePath = null;
      return this.setState({ phase: "error", error: error.message });
    }
  }
}

/** Register a verified package using the existing build record, then let the unchanged controller activate it. */
export async function prepareSelectedRelease(manager, updater, tag, { onProgress } = {}) {
  return manager.operation("downloading", async signal => {
    const release = updater.checkedRelease;
    const manifest = updater.manifest;
    if (!release || release.tag !== tag || !manifest || manifest.version !== versionForReleaseTag(tag))
      throw new Error("所选版本已变化，请重新下载并校验。");
    await manager.ensureBaseline();
    const archive = await manager.downloads.get(manifest, { url: release.archiveUrl, onProgress });
    signal.throwIfAborted();
    const state = await manager.store.read();
    for (const build of state.builds) {
      if (build.kind !== "official" || build.version !== manifest.version || build.baseTag !== tag || build.sha256 !== manifest.sha256) continue;
      const directory = ownedPath(manager.store.root, "builds", build.id);
      if (!await exists(ownedPath(directory, build.executable))) continue;
      await manager.store.build(build.id);
      await manager.store.update({ downloadedOfficial: build.id });
      return build.id;
    }
    const id = `official-${randomUUID()}`;
    const directory = ownedPath(manager.store.root, "builds", id);
    try {
      await manager.extractArchive(archive, directory, { signal });
      signal.throwIfAborted();
      const record = { id, kind: "official", version: manifest.version, baseTag: tag, sha256: manifest.sha256,
        executable: `${manager.target.bundle}/${manager.target.executable}`, createdAt: new Date().toISOString() };
      if (!await exists(ownedPath(directory, record.executable))) throw new Error("所选版本的安装包目录结构不正确。");
      await manager.store.update({ downloadedOfficial: id, builds: [...state.builds, record] });
      return id;
    } catch (error) {
      const filesystem = process.versions.electron ? createRequire(import.meta.url)("original-fs").promises : { rm };
      await filesystem.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }, { prune: false });
}

export class SelectableProgramUpdates extends ProgramUpdates {
  constructor(options) {
    const { evolution, updater } = options;
    super({ ...options, apply: async id => {
      const state = await evolution.store.read();
      const alreadyActive = state.active === id && !state.transaction;
      const result = await options.apply(id);
      if (alreadyActive) updater.setState({ phase: "updated", installStage: null, error: null });
      return result;
    }, evolution: {
      assertOfficialSwitchAllowed: () => evolution.assertOfficialSwitchAllowed(),
      releases: async () => updater.checkedRelease ? [updater.checkedRelease] : [],
      downloadRelease: (tag, progress) => prepareSelectedRelease(evolution, updater, tag, progress),
    } });
  }

  check(tag) {
    if (this.closed) return Promise.resolve(this.updater.getState());
    if (tag === undefined && this.updater.getState().phase === "ready") return Promise.resolve(this.updater.getState());
    if (this.checking) return this.checking.tag === tag ? this.checking.promise
      : Promise.reject(new Error("版本检查正在进行，请完成后再改选。"));
    const promise = this.run(async () => {
      if (tag !== undefined) this.updater.select(tag);
      return this.updater.check();
    }, { allowRunning: true });
    const request = { tag, promise: promise.finally(() => {
      if (this.checking === request) this.checking = null;
    }) };
    this.checking = request;
    return request.promise;
  }
}
