import { t as tr } from "./i18n.mjs";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { ProgramStore, exists, readJson, writeJson, ownedPath } from "./program-store.mjs";
import { fetchRelease, extract, copyProgramBundle } from "./program-bundles.mjs";
import { ReleaseDownloads } from "./release-downloads.mjs";
import { installRuntime } from "./online-runtime.mjs";
import { desktopPlatform, installationRoot } from "./platform.mjs";
import { compareVersions, validateManifest } from "./updater.mjs";
import { RELEASE_REPOSITORY as REPOSITORY, releaseTagForVersion, versionForReleaseTag } from "./release-channel.mjs";

const API = `https://api.github.com/repos/${REPOSITORY}`;

/** Purpose: Retain, download and select official programs; only explicit UI actions activate one. */
export class ProgramVersions {
  constructor({ app, root, dataHome, store, onState = () => {}, packaged = app.isPackaged, executable = process.execPath,
    downloads, extractArchive = extract }) {
    this.app = app;
    this.store = store || new ProgramStore(root, dataHome);
    this.target = desktopPlatform();
    this.packaged = packaged;
    this.executable = executable;
    this.onState = onState;
    this.phase = "idle";
    this.readOnlyOperation = false;
    this.error = null;
    this.logs = "";
    this.closed = false;
    this.operationAbort = null;
    this.operationPromise = null;
    this.downloads = downloads || new ReleaseDownloads({ root: join(this.store.root, "downloads") });
    this.extractArchive = extractArchive;
  }

  /** Input: progress line. Output: bounded UI log without credentials. */
  log(message) { this.logs = (this.logs + message).slice(-16000); this.onState(); }

  /** Input: phase and operation. Output: serial execution with retained error and previous working build. */
  async operation(phase, action, { prune = true, readOnly = false } = {}) {
    if (this.closed) throw new Error(tr("evolution.cleo_is_shutting_down_and_cannot_start_new_evolution_operations"));
    if (this.phase !== "idle") throw new Error(tr("evolution.another_evolution_operation_is_in_progress_please_wait"));
    const controller = new AbortController();
    const previous = readOnly ? { error: this.error, logs: this.logs } : null;
    this.readOnlyOperation = readOnly;
    this.operationAbort = controller;
    this.phase = phase; this.error = null; this.logs = ""; this.onState();
    try {
      this.operationPromise = this.store.exclusive(async () => {
        controller.signal.throwIfAborted();
        if ((await this.store.read()).transaction) throw new Error(tr("evolution.a_version_switch_is_in_progress_wait_for_the_restart_to_finish_or_use_recovery"));
        const result = await action(controller.signal);
        controller.signal.throwIfAborted();
        if (prune && !readOnly) await this.store.pruneBuilds();
        return result;
      });
      return await this.operationPromise;
    }
    catch (error) { this.error = error.message; throw error; }
    finally {
      if (previous) { this.error = previous.error; this.logs = previous.logs; }
      this.operationPromise = null; this.operationAbort = null; this.phase = "idle"; this.readOnlyOperation = false; this.onState();
    }
  }

  /** Purpose: Stop operation-owned writers before the app releases its single-instance lock. */
  async close() {
    this.closed = true;
    this.operationAbort?.abort(new Error(tr("evolution.cleo_is_shutting_down_the_current_evolution_operation_was_stopped")));
    const pending = this.operationPromise;
    try { await this.downloads.close?.(); }
    finally {
      // The operation's own caller receives its cancellation or cleanup failure.
      await pending?.catch(() => {});
    }
  }

  /** Detect a newly opened official installation without overriding retained local work or a deliberate rollback. */
  async installedRelease() {
    if (!this.packaged) return null;
    const child = relative(this.store.root, resolve(this.executable));
    if (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)) return null;
    const state = await this.store.read();
    const active = state.builds.find(build => build.id === state.active);
    const candidate = state.builds.find(build => build.id === state.candidate);
    if (state.transaction || active?.kind !== "official" || state.iteration || state.draftDirty
        || (candidate?.kind === "local" && !candidate.savedAt)) return null;
    const source = installationRoot(this.executable, this.target);
    const resources = join(source, this.target.resources);
    const metadata = await readJson(join(this.target.platform === "darwin" ? resources : source, "release.json"));
    if (metadata?.app !== "Cleo" || metadata.platform !== this.target.id || ![2, 3].includes(metadata.evolution_protocol)
        || metadata.version !== this.app.getVersion() || !/^\d+\.\d+\.\d+(?:-alpha)?$/.test(metadata.version)
        || (metadata.build_kind && metadata.build_kind !== "official")) return null;
    if (metadata.version.endsWith("-alpha") !== Boolean(active.version?.endsWith("-alpha"))) return null;
    if (state.builds.some(build => build.id === state.baseline && build.version === metadata.version)) return null;
    const path = this.target.platform === "win32" ? resolve(this.executable).toLowerCase() : resolve(this.executable);
    const previous = state.installedReleases?.[path] || active.version;
    if (!previous || compareVersions(metadata.version, previous) <= 0
        || compareVersions(metadata.version, active.version) <= 0) return null;
    return { path, source, version: metadata.version };
  }

  /** Retain the verified local installation and journal its first activation under the desktop instance lock. */
  async stageInstalledRelease() {
    return this.operation("preparing", async (signal) => {
      const installed = await this.installedRelease();
      if (!installed) return null;
      const state = await this.store.read();
      const filesystem = process.versions.electron ? createRequire(import.meta.url)("original-fs").promises : { readFile, rm };
      const archiveHash = async source => createHash("sha256").update(await filesystem.readFile(join(source, this.target.resources, "app.asar"))).digest("hex");
      const hash = await archiveHash(installed.source);
      let record = state.builds.find(build => build.kind === "official" && build.installSource === installed.path
        && build.version === installed.version && build.installHash === hash);
      if (record && !await exists(join(this.store.root, "builds", record.id, record.executable))) record = null;
      if (!record) {
        const id = `official-${randomUUID()}`;
        const directory = ownedPath(this.store.root, "builds", id);
        try {
          const bundle = join(directory, this.target.bundle);
          await copyProgramBundle(installed.source, bundle, { signal });
          if (await archiveHash(bundle) !== hash || !await exists(join(bundle, this.target.executable))) {
            throw new Error(tr("evolution.new_program_copy_verification_failed_reinstall_and_retry"));
          }
          record = { id, kind: "official", version: installed.version, baseTag: releaseTagForVersion(installed.version),
            executable: `${this.target.bundle}/${this.target.executable}`, createdAt: new Date().toISOString(),
            installSource: installed.path, installHash: hash };
          await this.store.update({ builds: [...state.builds, record] });
        } catch (error) {
          await filesystem.rm(directory, { recursive: true, force: true });
          throw error;
        }
      }
      return this.store.stage(record.id, { officialSelection: true,
        installedRelease: { path: installed.path, version: installed.version } });
    }, { prune: false });
  }

  /** Input: none. Output: a retained baseline executable before any mutable app is used. */
  async ensureBaseline() {
    const state = await this.store.read();
    if (state.baseline) return this.store.build(state.baseline);
    if (!this.packaged) throw new Error(tr("evolution.apply_changes_in_a_packaged_cleo_app_development_mode_can_display_the_evolution_inter"));
    const id = `baseline-${randomUUID()}`;
    const bundle = this.target.bundle;
    const directory = join(this.store.root, "builds", id, bundle);
    this.log(tr("evolution.saving_the_current_working_program_and_independent_recovery_entry_point"));
    await mkdir(dirname(directory), { recursive: true });
    await copyProgramBundle(installationRoot(this.executable, this.target), directory, { signal: this.operationAbort?.signal });
    const record = { id, kind: "official", version: this.app.getVersion(), baseTag: releaseTagForVersion(this.app.getVersion()),
      executable: `${bundle}/${this.target.executable}`, createdAt: new Date().toISOString(), baseline: true };
    const path = this.target.platform === "win32" ? resolve(this.executable).toLowerCase() : resolve(this.executable);
    await this.store.update({ active: id, baseline: id, builds: [...state.builds, record],
      installedReleases: { ...state.installedReleases, [path]: this.app.getVersion() } });
    const baseline = await this.store.build(id);
    if (process.platform === "win32") {
      // A separate shortcut remains usable even when the current app's JavaScript cannot load.
      const { shell } = createRequire(import.meta.url)("electron");
      const shortcut = join(this.app.getPath("desktop"), this.app.getVersion().endsWith("-alpha")
        ? "Cleo Alpha 恢复.lnk" : "Cleo 恢复.lnk");
      if (!shell.writeShortcutLink(shortcut, "create", {
        target: baseline.executable, args: "--cleo-recovery",
      })) throw new Error(tr("evolution.could_not_create_the_cleo_recovery_shortcut"));
    }
    return baseline;
  }

  /** Input: none. Output: only published, non-prerelease official versions; never merged commits. */
  async releases() {
    return this.operation("checking", async () => {
      const releases = await fetchRelease(`${API}/releases?per_page=100`, true, { signal: this.operationAbort?.signal });
      const available = releases.filter((item) => !item.draft && !item.prerelease
        && /^v?\d+\.\d+\.\d+$/.test(item.tag_name)
        && item.assets.some((asset) => asset.name === this.target.manifest))
        .map((item) => ({ tag: item.tag_name, title: item.name || item.tag_name, publishedAt: item.published_at,
          url: item.html_url, manifestUrl: item.assets.find((asset) => asset.name === this.target.manifest).browser_download_url }));
      await writeJson(join(this.store.root, "releases.json"), available);
      return available;
    });
  }

  /** Input: published tag. Output: downloaded official build, including older releases, without activation. */
  async downloadRelease(tag, { onProgress } = {}) {
    return this.operation("downloading", async (signal) => {
      await this.ensureBaseline();
      const releases = await readJson(join(this.store.root, "releases.json"), []);
      const release = releases.find((item) => item.tag === tag);
      if (!release) throw new Error(tr("evolution.check_official_versions_and_select_a_published_version_first"));
      const rawManifest = await fetchRelease(release.manifestUrl, true, { signal });
      if (![2, 3].includes(rawManifest.evolution_protocol)) throw new Error(tr("evolution.this_version_does_not_support_switching_while_preserving_current_user_data_so_it_cann"));
      const manifest = validateManifest(rawManifest, this.target);
      if (manifest.version !== versionForReleaseTag(tag)) throw new Error(tr("evolution.the_version_manifest_does_not_match_the_selected_release"));
      const archive = await this.downloads.get(manifest, {
        url: `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${manifest.archive}`, onProgress,
      });
      signal.throwIfAborted();
      const state = await this.store.read();
      for (const build of state.builds) {
        if (build.kind === "official" && build.version === manifest.version && build.sha256 === manifest.sha256) {
          const directory = ownedPath(this.store.root, "builds", build.id);
          if (!await exists(ownedPath(directory, build.executable))) continue;
          await this.store.build(build.id);
          await installRuntime({ resources: join(directory, this.target.bundle, this.target.resources),
            root: join(this.store.dataHome, "runtimes/online"), signal, log: text => this.log(text) });
          await this.store.update({ downloadedOfficial: build.id });
          return build.id;
        }
      }
      const id = `official-${randomUUID()}`;
      const directory = ownedPath(this.store.root, "builds", id);
      try {
        await this.extractArchive(archive, directory, { signal });
        await installRuntime({ resources: join(directory, this.target.bundle, this.target.resources),
          root: join(this.store.dataHome, "runtimes/online"), signal, log: text => this.log(text) });
        signal.throwIfAborted();
        const record = { id, kind: "official", version: manifest.version, baseTag: tag, sha256: manifest.sha256,
          executable: `${this.target.bundle}/${this.target.executable}`, createdAt: new Date().toISOString() };
        if (!await exists(join(directory, record.executable))) throw new Error(tr("evolution.the_official_release_package_has_an_incorrect_directory_structure"));
        await this.store.update({ downloadedOfficial: id, builds: [...state.builds, record] });
        return id;
      } catch (error) {
        const filesystem = process.versions.electron
          ? createRequire(import.meta.url)("original-fs").promises : { rm };
        await filesystem.rm(directory, { recursive: true, force: true });
        throw error;
      }
    }, { prune: false });
  }

  /** Purpose: Keep official updates from replacing an unfinished local iteration. */
  async assertOfficialSwitchAllowed() {
    const state = await this.store.read();
    if (state.transaction) throw new Error(tr("evolution.a_version_switch_is_in_progress_wait_for_the_restart_to_finish_or_use_recovery"));
    const candidate = state.builds.find((build) => build.id === state.candidate);
    if (state.iteration || state.draftDirty || (candidate?.kind === "local" && !candidate.savedAt)) {
      throw new Error(tr("evolution.save_or_discard_this_iteration_s_local_changes_before_updating_the_official_version"));
    }
  }

  /** Purpose: Journal a switch to a retained program for the stable controller.
   * Input: registered build id. Output: durable transaction; shared user data is unchanged.
   */
  async stage(id) {
    return this.operation("applying", async () => {
      const build = await this.store.build(id);
      const state = await this.store.read();
      await this.assertStageAllowed(build, state);
      return this.store.stage(id, { officialSelection: build.kind === "official" });
    });
  }

  /** Input: registered build and current registry. Output: rejection when this program must not be selected now. */
  async assertStageAllowed(build) {
    if (build.kind === "official") await this.assertOfficialSwitchAllowed();
  }
}
