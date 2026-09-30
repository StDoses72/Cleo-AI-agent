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
    if (this.busy) throw new Error("另一项版本操作正在进行，请稍候。");
    if (!allowRunning && this.hasRunningTask()) throw new Error("请先等待当前任务完成或停止任务。");
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
      if (state.phase !== "ready" || !this.updater.manifest) throw new Error("请先下载并校验更新。");
      const version = this.updater.manifest.version;
      this.updater.setState({ phase: "installing", installStage: "preparing", error: null });
      try {
        await this.evolution.assertOfficialSwitchAllowed();
        const releases = await this.evolution.releases();
        const release = releases.find(item => versionForReleaseTag(item.tag) === version);
        if (!release) throw new Error("找不到已下载的发布版本，请重新检查更新。");
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
