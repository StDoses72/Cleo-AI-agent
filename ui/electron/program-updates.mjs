import { t as tr } from "./i18n.mjs";
import { versionForReleaseTag } from "./release-channel.mjs";

/** Coordinate user-requested program changes across the update and evolution entry points. */
export class ProgramUpdates {
  constructor({ updater, evolution, apply, hasRunningTask = () => false }) {
    this.updater = updater;
    this.evolution = evolution;
    this.apply = apply;
    this.hasRunningTask = hasRunningTask;
    this.active = false;
    this.blocking = false;
    this.restarting = false;
    this.closed = false;
    this.installation = null;
    this.downloading = null;
  }

  get busy() { return this.active || this.restarting || this.closed; }
  get blocksTasks() { return (this.active && this.blocking) || this.restarting || this.closed; }

  async run(action, { allowRunning = false } = {}) {
    if (this.busy) throw new Error(tr("program_updates.another_version_operation_is_in_progress_please_wait"));
    if (!allowRunning && this.hasRunningTask()) throw new Error(tr("main.wait_for_the_current_task_to_finish_or_stop_it"));
    this.active = true;
    this.blocking = !allowRunning;
    this.updater.setState({ operationBusy: true, blocksTasks: this.blocksTasks });
    try { return await action(); }
    finally {
      this.active = false;
      this.blocking = false;
      this.updater.setState({ operationBusy: this.busy, blocksTasks: this.blocksTasks });
    }
  }

  check() { return this.closed ? Promise.resolve(this.updater.getState()) : this.updater.check(); }

  download() {
    if (this.downloading) return this.downloading;
    this.downloading = this.run(() => this.updater.download(), { allowRunning: true })
      .finally(() => { this.downloading = null; });
    return this.downloading;
  }

  install() {
    if (this.installation) return this.installation;
    this.installation = this.run(async () => {
      const state = this.updater.getState();
      if (state.phase !== "ready" || !this.updater.manifest) throw new Error(tr("program_updates.download_and_verify_the_update_first"));
      const version = this.updater.manifest.version;
      this.updater.setState({ phase: "installing", installStage: "preparing", error: null });
      try {
        await this.evolution.assertOfficialSwitchAllowed();
        const releases = await this.evolution.releases();
        const release = releases.find(item => versionForReleaseTag(item.tag) === version);
        if (!release) throw new Error(tr("program_updates.the_downloaded_release_was_not_found_check_for_updates_again"));
        const id = await this.evolution.downloadRelease(release.tag, {
          onProgress: (downloadedBytes, totalBytes) => this.updater.setState({ downloadedBytes, totalBytes }),
        });
        this.updater.setState({ installStage: "restarting" });
        await this.apply(id);
        return true;
      } catch (error) {
        this.updater.setState({ phase: "ready", installStage: null, error: error.message });
        throw error;
      }
    }).finally(() => { this.installation = null; });
    return this.installation;
  }

  beginRestart() {
    this.restarting = true;
    this.updater.setState({ operationBusy: true, blocksTasks: true });
  }

  close() { this.closed = true; }
}
