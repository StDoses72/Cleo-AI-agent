import { t as tr } from "./i18n.mjs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { DesktopUpdater, compareVersions, validateManifest } from "./updater.mjs";
import { ProgramUpdates } from "./program-updates.mjs";
import { installRuntime } from "./online-runtime.mjs";
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
    if (!response.ok) throw new Error(tr("selectable_updates.github_version_request_failed_http_value_try_again", { p0: response.status }));
    return response.json();
  }

  async refreshCatalog() {
    const releases = [];
    for (let page = 1; ; page++) {
      const items = await this.json(`${api}?per_page=100&page=${page}`);
      if (!Array.isArray(items)) throw new Error(tr("selectable_updates.github_returned_an_invalid_version_list"));
      for (const item of items.filter(item => !item.draft)) {
        const assets = item.assets || [];
        const reason = !versionForReleaseTag(item.tag_name) ? tr("selectable_updates.unsupported_version_tag")
          : alphaTagPattern.test(item.tag_name) && !item.prerelease ? tr("selectable_updates.experimental_versions_must_be_marked_as_pre_releases")
          : !assets.some(asset => asset.name === this.target.manifest) ? tr("selectable_updates.missing_version_manifest_for_this_platform")
            : !assets.some(asset => asset.name === this.target.archive) ? tr("selectable_updates.missing_installation_package_for_this_platform") : null;
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
    if (this.busy || this.state.phase === "installing") throw new Error(tr("selectable_updates.a_version_operation_is_running_wait_for_it_to_finish_before_changing_the_selection"));
    const release = this.catalog.find(item => item.tag === tag);
    if (!release || release.reason) throw new Error(release?.reason || tr("selectable_updates.check_again_and_select_an_installable_version"));
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
        if (!stable) throw new Error(tr("selectable_updates.no_official_version_is_available_for_this_platform_choose_another_available_version"));
        this.checkedRelease = stable;
      } else {
        this.checkedRelease = this.catalog.find(item => item.tag === this.selectedRelease.tag);
        if (!this.checkedRelease || this.checkedRelease.reason) throw new Error(tr("selectable_updates.the_selected_version_is_no_longer_available_choose_another"));
        this.selectedRelease = this.checkedRelease;
      }
      const release = this.checkedRelease;
      const raw = await this.json(release.manifestUrl);
      const manifest = validateManifest(raw, this.target);
      if (![2, 3].includes(raw.evolution_protocol)) throw new Error(tr("selectable_updates.this_version_does_not_support_switching_while_preserving_current_data"));
      if (manifest.version !== versionForReleaseTag(release.tag)) throw new Error(tr("selectable_updates.the_version_manifest_does_not_match_the_selected_version"));
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
      throw new Error(tr("selectable_updates.the_selected_version_changed_download_and_verify_again"));
    await manager.ensureBaseline();
    const archive = await manager.downloads.get(manifest, { url: release.archiveUrl, onProgress });
    signal.throwIfAborted();
    const state = await manager.store.read();
    for (const build of state.builds) {
      if (build.kind !== "official" || build.version !== manifest.version || build.baseTag !== tag || build.sha256 !== manifest.sha256) continue;
      const directory = ownedPath(manager.store.root, "builds", build.id);
      if (!await exists(ownedPath(directory, build.executable))) continue;
      await manager.store.build(build.id);
      await installRuntime({ resources: join(directory, manager.target.bundle, manager.target.resources),
        root: join(manager.store.dataHome, "runtimes/online"), signal, log: text => manager.log(text) });
      await manager.store.update({ downloadedOfficial: build.id });
      return build.id;
    }
    const id = `official-${randomUUID()}`;
    const directory = ownedPath(manager.store.root, "builds", id);
    try {
      await manager.extractArchive(archive, directory, { signal });
      await installRuntime({ resources: join(directory, manager.target.bundle, manager.target.resources),
        root: join(manager.store.dataHome, "runtimes/online"), signal,
        log: text => manager.log(text) });
      signal.throwIfAborted();
      const record = { id, kind: "official", version: manifest.version, baseTag: tag, sha256: manifest.sha256,
        executable: `${manager.target.bundle}/${manager.target.executable}`, createdAt: new Date().toISOString() };
      if (!await exists(ownedPath(directory, record.executable))) throw new Error(tr("selectable_updates.the_selected_package_has_an_incorrect_directory_structure"));
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
      : Promise.reject(new Error(tr("selectable_updates.version_checking_is_in_progress_wait_for_it_to_finish_before_changing_the_selection")));
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
