import { randomUUID, createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile, rename, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { EvolutionStore, exists, fileHash, readJson, writeJson, ownedPath } from "./evolution-store.mjs";
import { EvolutionTools, run, fetchRelease, downloadVerified, extract } from "./evolution-tools.mjs";
import { desktopPlatform, installationRoot } from "./platform.mjs";
import { validateManifest } from "./updater.mjs";

const REPOSITORY = "StDoses72/Cleo-AI-agent";
const REPO_URL = `https://github.com/${REPOSITORY}.git`;
const API = `https://api.github.com/repos/${REPOSITORY}`;
const PROTECTED = ["bootstrap.mjs", "evolution.mjs", "evolution-store.mjs", "evolution-tools.mjs", "evolution-recovery.mjs", "evolution-launch.mjs", "evolution-progress.mjs", "evolution-handoff.mjs"];

/** Purpose: Retain an installation as physical files without Electron expanding ASAR archives.
 * Input: installation root and destination. Output: byte-preserving bundle copy, including native symlinks.
 */
async function copyProgramBundle(source, destination) {
  if (process.platform === "win32") {
    // Native copying avoids ASAR expansion and per-file JS overhead in the large Python runtime.
    await run("robocopy.exe", [source, destination, "/E", "/SL", "/COPY:DAT", "/R:0", "/W:0",
      "/MT:8", "/NFL", "/NDL", "/NP", "/NJH", "/NJS"],
    { successCodes: [0, 1, 2, 3, 4, 5, 6, 7], timeout: 600000 });
    return;
  }
  const filesystem = process.versions.electron
    ? createRequire(import.meta.url)("original-fs").promises
    : { cp };
  await filesystem.cp(source, destination, { recursive: true, verbatimSymlinks: true });
}

/** Purpose: Coordinate local evolution; only explicit UI actions build, activate, or publish contributions. */
export class EvolutionManager {
  constructor({ app, root, dataHome, onState = () => {}, packaged = app.isPackaged, executable = process.execPath, sourceRepository = REPO_URL }) {
    this.app = app;
    this.store = new EvolutionStore(root, dataHome);
    this.source = join(root, "source");
    this.target = desktopPlatform();
    this.packaged = packaged;
    this.executable = executable;
    this.sourceRepository = sourceRepository;
    this.onState = onState;
    this.phase = "idle";
    this.error = null;
    this.logs = "";
    this.tools = new EvolutionTools(join(root, "tools"), (message) => this.log(message));
  }

  /** Input: progress line. Output: bounded UI log without credentials. */
  log(message) { this.logs = (this.logs + message).slice(-16000); this.onState(); }

  /** Input: phase and operation. Output: serial execution with retained error and previous working build. */
  async operation(phase, action) {
    if (this.phase !== "idle") throw new Error("另一项进化操作正在进行，请稍候。");
    this.phase = phase; this.error = null; this.logs = ""; this.onState();
    try {
      return await this.store.exclusive(async () => {
        const result = await action();
        await this.store.pruneBuilds();
        return result;
      });
    }
    catch (error) { this.error = error.message; throw error; }
    finally { this.phase = "idle"; this.onState(); }
  }

  /** Input: none. Output: status, official releases cached separately, and local draft identity. */
  async status() {
    const state = await this.store.read();
    return { ...state, phase: this.phase, error: this.error, logs: this.logs, source: state.prepared ? this.source : null,
      supported: this.packaged, currentVersion: this.app.getVersion(),
      releases: await readJson(join(this.store.root, "releases.json"), []),
      recoveryPath: state.baseline ? (await this.store.build(state.baseline)).executable : null };
  }

  /** Purpose: Import an explicitly opened development bundle as a selectable local version.
   * Input: none; invoked only by the import-bundle launcher. Output: retained program, preserving the old baseline and data.
   */
  async importBundle() {
    return this.operation("preparing", async () => {
      const state = await this.store.read();
      if (state.transaction) throw new Error("请先完成上一次应用或恢复。");
      if (!state.baseline) return this.ensureBaseline();
      const source = installationRoot(this.executable, this.target);
      const filesystem = process.versions.electron ? createRequire(import.meta.url)("original-fs").promises : { readFile };
      const digest = createHash("sha256").update(await filesystem.readFile(join(source, this.target.resources, "app.asar"))).digest("hex");
      const existing = state.builds.find((build) => build.importSource === this.executable && build.importHash === digest);
      if (existing) return existing;
      if (state.importedBundles?.[this.executable] === digest) return this.store.build(state.active);
      const id = `local-${randomUUID()}`;
      const directory = join(this.store.root, "builds", id, this.target.bundle);
      this.log("正在保留新版程序；原版本和用户数据继续保留。\n");
      await copyProgramBundle(source, directory);
      const record = { id, kind: "local", version: null, name: "本机开发版", savedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(), baseTag: `v${this.app.getVersion()}`,
        executable: `${this.target.bundle}/${this.target.executable}`, importSource: this.executable, importHash: digest };
      if (await exists(this.source)) await rename(this.source, join(this.store.root, `source-history-${randomUUID()}`));
      await this.store.update({ builds: [...state.builds, record], active: id, selectedBase: id,
        workspaceBase: id, latestSaved: id, pendingImport: { from: state.active, to: id }, importedBundles: { ...state.importedBundles, [this.executable]: digest },
        prepared: false, candidate: null, threadId: null, iteration: null, baseTag: record.baseTag });
      return record;
    });
  }

  /** Input: none. Output: a retained baseline executable before any mutable app is used. */
  async ensureBaseline() {
    const state = await this.store.read();
    if (state.baseline) return this.store.build(state.baseline);
    if (!this.packaged) throw new Error("请在打包后的 Cleo 中应用改动；开发模式可以查看进化界面。");
    const id = `baseline-${randomUUID()}`;
    const bundle = this.target.bundle;
    const directory = join(this.store.root, "builds", id, bundle);
    this.log("正在保存当前可用程序和独立恢复入口…\n");
    await mkdir(dirname(directory), { recursive: true });
    await copyProgramBundle(installationRoot(this.executable, this.target), directory);
    const record = { id, kind: "official", version: this.app.getVersion(), baseTag: `v${this.app.getVersion()}`,
      executable: `${bundle}/${this.target.executable}`, createdAt: new Date().toISOString(), baseline: true };
    await this.store.update({ active: id, baseline: id, builds: [...state.builds, record] });
    const baseline = await this.store.build(id);
    if (process.platform === "win32") {
      // A separate shortcut remains usable even when the current app's JavaScript cannot load.
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:CLEO_SHORTCUT); $s.TargetPath = $env:CLEO_RECOVERY_EXE; $s.Arguments = '--cleo-recovery'; $s.Save()"], {
        env: { ...process.env, CLEO_SHORTCUT: join(this.app.getPath("desktop"), "Cleo 恢复.lnk"), CLEO_RECOVERY_EXE: baseline.executable },
      });
    }
    return baseline;
  }

  /** Input: none. Output: only published, non-prerelease official versions; never merged commits. */
  async releases() {
    return this.operation("checking", async () => {
      const releases = await fetchRelease(`${API}/releases?per_page=100`);
      const available = releases.filter((item) => !item.draft && !item.prerelease
        && /^v?\d+\.\d+\.\d+$/.test(item.tag_name)
        && item.assets.some((asset) => asset.name === this.target.manifest))
        .map((item) => ({ tag: item.tag_name, title: item.name || item.tag_name, publishedAt: item.published_at,
          url: item.html_url, manifestUrl: item.assets.find((asset) => asset.name === this.target.manifest).browser_download_url }));
      await writeJson(join(this.store.root, "releases.json"), available);
      return available;
    });
  }

  /** Input: none. Output: isolated editable source based on the running official version. */
  async prepare() {
    return this.operation("preparing", async () => {
      await this.ensureBaseline();
      const state = await this.store.read();
      if (state.prepared && await exists(join(this.source, ".git"))) return this.source;
      const tools = await this.tools.prepare();
      const selected = await this.store.build(state.active);
      const baseTag = selected.baseTag || `v${selected.version || this.app.getVersion()}`;
      if (!/^v\d+\.\d+\.\d+$/.test(baseTag)) throw new Error("当前程序没有正式版本号，无法确定源码基准。");
      const temporary = join(this.store.root, `source-${randomUUID()}`);
      this.log(`正在获取 ${baseTag} 的源码…\n`);
      await run(tools.git, ["clone", "--branch", baseTag, "--single-branch", this.sourceRepository, temporary], { env: tools.env, log: (text) => this.log(text) });
      await run(tools.git, ["switch", "-c", `cleo/local-${randomUUID().slice(0, 8)}`], { cwd: temporary, env: tools.env });
      const bundled = join(selected.directory, this.target.bundle, this.target.resources, "evolution-source.tar.gz");
      if (await exists(bundled)) {
        await extract(bundled, temporary);
        const manifest = await readJson(join(temporary, "evolution-source.json"));
        for (const name of manifest.deleted || []) {
          if (name.startsWith(".git/") || name === ".git") throw new Error("Invalid bundled source path.");
          await rm(ownedPath(temporary, name), { force: true });
        }
        await rm(join(temporary, "evolution-source.json"));
      }
      await this.saveProtection(temporary);
      if (await exists(this.source)) {
        const retained = join(this.store.root, `source-recovery-${randomUUID()}`);
        await rename(this.source, retained);
        this.log(`先前未完成的工作区已保留：${retained}\n`);
      }
      await rename(temporary, this.source);
      await this.store.update({ baseTag, prepared: true, baseSourceHash: await this.sourceHash(tools) });
      return this.source;
    });
  }

  /** Input: none. Output: trusted recovery-source digests, separate from editable Git history. */
  async saveProtection(source = this.source) {
    const hashes = {};
    for (const name of PROTECTED) hashes[name] = await fileHash(join(source, "ui/electron", name));
    await writeJson(join(this.store.root, "protected.json"), hashes);
  }

  /** Input: none. Output: rejects changes to recovery/controller code or its entry point. */
  async checkProtection() {
    const hashes = await readJson(join(this.store.root, "protected.json"));
    if (!hashes) throw new Error("恢复模块校验信息缺失，请恢复正式版本。");
    for (const name of PROTECTED) {
      if (!await exists(join(this.source, "ui/electron", name))
          || await fileHash(join(this.source, "ui/electron", name)) !== hashes[name]) {
        throw new Error(`版本与恢复模块不可自我修改：${name}`);
      }
    }
    const metadata = await readJson(join(this.source, "ui/package.json"));
    if (metadata.main !== "electron/bootstrap.mjs") throw new Error("不能修改受保护的应用启动入口。");
  }

  /** Input: toolchain. Output: digest of tracked and nonignored untracked source, excluding build products. */
  async sourceHash(tools) {
    const files = await run(tools.git, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: this.source, env: tools.env });
    const hash = createHash("sha256");
    for (const name of [...new Set(files.split("\0").filter(Boolean))].sort()) {
      const path = resolve(this.source, name);
      if (!path.startsWith(`${resolve(this.source)}${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("源码包含非法路径。");
      hash.update(name); hash.update(await exists(path) ? await fileHash(path) : "deleted");
    }
    return hash.digest("hex");
  }

  /** Input: none. Output: a separately built candidate; current app and data remain active until Apply. */
  async build() {
    return this.operation("building", async () => {
      const state = await this.store.read();
      if (!state.prepared) throw new Error("请先准备本地工作区。");
      await this.store.beginIteration();
      const tools = await this.tools.prepare();
      await this.finishMerge(tools);
      await this.checkProtection();
      const digest = await this.sourceHash(tools);
      const saved = await this.store.read();
      const existing = saved.builds.find((item) => item.id === saved.candidate && item.sourceHash === digest);
      if (existing) {
        await this.store.update({ draftDirty: false });
        this.log("源码没有变化，上次检查完成的构建仍可应用。\n");
        return existing.id;
      }
      if (digest === saved.baseSourceHash && !saved.candidate) {
        await this.store.update({ draftDirty: false });
        this.log("尚无本地源码修改，可以继续向 Cleo 描述需求。\n");
        return null;
      }
      this.log("正在检查和构建；当前 Cleo 保持运行…\n");
      const args = process.platform === "win32"
        ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(this.source, "scripts/build-release.ps1"), "-LockedDependencies"]
        : ["run", "--no-project", "--python", "3.12", join(this.source, "scripts/build-release.py"), "--locked-dependencies"];
      await run(process.platform === "win32" ? "powershell.exe" : tools.uv, args,
        { cwd: this.source, env: tools.env, log: (text) => this.log(text), timeout: 3_600_000 });
      const tests = (await readdir(join(this.source, "ui/electron")))
        .filter((name) => name.endsWith(".test.mjs")).map((name) => join(this.source, "ui/electron", name));
      const extraTests = join(this.source, "ui/tests");
      if (await exists(extraTests)) tests.push(...(await readdir(extraTests))
        .filter((name) => name.startsWith("evolution-") && name.endsWith(".test.mjs"))
        .map((name) => join(extraTests, name)));
      if (tests.length) await run(tools.node, ["--test", ...tests],
        { cwd: join(this.source, "ui"), env: tools.env, log: (text) => this.log(text) });
      await this.checkProtection();
      if (digest !== await this.sourceHash(tools)) throw new Error("构建期间源码发生变化，请重新构建。");
      const id = `local-${randomUUID()}`;
      const built = join(this.source, "release", this.target.bundle);
      if (!await exists(join(built, this.target.executable))) throw new Error("构建未生成可运行程序。");
      const destination = join(this.store.root, "builds", id, this.target.bundle);
      await mkdir(dirname(destination), { recursive: true });
      // Move the completed package out of the build workspace so the next iteration starts cleanly.
      await rename(built, destination);
      const record = { id, kind: "local", version: null, baseTag: (await this.store.read()).baseTag, sourceHash: digest,
        executable: `${this.target.bundle}/${this.target.executable}`, createdAt: new Date().toISOString() };
      const current = await this.store.read();
      await this.store.update({ candidate: id, draftDirty: false, builds: [...current.builds, record] });
      this.log("构建完成。点击「应用到我的 Cleo」后重启并查看效果。\n");
      return id;
    });
  }

  /** Input: published tag. Output: downloaded official build, including older releases, without activation. */
  async downloadRelease(tag) {
    return this.operation("downloading", async () => {
      await this.ensureBaseline();
      const releases = await readJson(join(this.store.root, "releases.json"), []);
      const release = releases.find((item) => item.tag === tag);
      if (!release) throw new Error("请先检查正式版本，并选择已发布的版本。");
      const rawManifest = await fetchRelease(release.manifestUrl);
      if (rawManifest.evolution_protocol !== 2) throw new Error("该版本尚不支持保留当前用户数据的版本切换，无法通过进化入口应用。");
      const manifest = validateManifest(rawManifest, this.target);
      if (`v${manifest.version}` !== (tag.startsWith("v") ? tag : `v${tag}`)) throw new Error("版本清单与所选 release 不一致。");
      const archive = join(this.store.root, "downloads", `${tag}-${manifest.archive}`);
      await downloadVerified(`https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${manifest.archive}`, archive, manifest.sha256);
      const id = `official-${randomUUID()}`;
      const directory = join(this.store.root, "builds", id);
      await extract(archive, directory);
      const record = { id, kind: "official", version: manifest.version, baseTag: tag,
        executable: `${this.target.bundle}/${this.target.executable}`, createdAt: new Date().toISOString() };
      if (!await exists(join(directory, record.executable))) throw new Error("正式版本安装包的目录结构不正确。");
      const state = await this.store.read();
      await this.store.update({ candidate: id, builds: [...state.builds, record] });
      return id;
    });
  }

  /** Input: registered candidate; user data remains shared across versions. Output: durable transaction for the stable controller. */
  async stage(id) {
    return this.operation("applying", async () => {
      const build = await this.store.build(id);
      const state = await this.store.read();
      if (build.kind === "local" && id === state.candidate && id !== state.lastApplication?.from) {
        const tools = await this.tools.prepare();
        await this.checkProtection();
        if (build.sourceHash !== await this.sourceHash(tools)) throw new Error("构建后又有新修改，请重新构建再应用。");
      }
      return this.store.stage(id);
    });
  }

  /** Purpose: Save only the applied program whose source is still the current draft.
   * Input: optional name. Output: selectable local version, after source identity verification.
   */
  async saveVersion(name) {
    return this.operation("saving", async () => {
      const state = await this.store.read();
      const active = await this.store.build(state.active);
      const tools = await this.tools.prepare();
      if (!active.sourceHash || active.sourceHash !== await this.sourceHash(tools)) {
        throw new Error("还有未应用的源码修改，请先构建并应用，或放弃本轮修改。");
      }
      return this.store.saveVersion(name);
    });
  }

  /** Purpose: Archive editable source before selecting a different saved program.
   * Input: selectable build id and whether the current iteration is explicitly discarded.
   * Output: prepared state cleared; source and user data remain recoverable.
   */
  async selectVersion(id, discard = false) {
    return this.operation("selecting", async () => {
      const state = await this.store.read();
      const target = await this.store.build(id);
      if (!discard && state.iteration) throw new Error("请先保存或放弃本轮修改，再切换版本。");
      if (!discard && target.kind === "local" && !target.savedAt) throw new Error("该本地改动还没有保存。");
      if (await exists(this.source)) {
        await rename(this.source, join(this.store.root, `source-history-${randomUUID()}`));
      }
      await this.store.update({ selectedBase: id, workspaceBase: discard ? state.workspaceBase || id : id, prepared: false, iteration: null,
        candidate: null, draftDirty: false, threadId: null, baseTag: target.baseTag });
      return id;
    });
  }

  /** Purpose: Abandon this iteration and return to its original program, keeping shared user data.
   * Input: none. Output: target id for application by the stable controller.
   */
  async discardIteration() {
    const state = await this.store.read();
    if (!state.iteration) throw new Error("没有待放弃的修改。");
    return this.selectVersion(state.iteration.base, true);
  }

  /** Input: none. Output: web/device authorization owned by GitHub CLI; no tokens enter app state. */
  async login() {
    return this.operation("authenticating", async () => {
      const tools = await this.tools.prepare(true);
      await run(tools.gh, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"],
        { env: tools.env, log: (text) => this.log(text), timeout: 900000 });
    });
  }

  /** Input: toolchain. Output: local checkpoint with no public version number. */
  async commit(tools) {
    const options = { cwd: this.source, env: tools.env };
    await run(tools.git, ["add", "--all"], options);
    if (!await run(tools.git, ["diff", "--cached", "--name-only"], options)) return;
    await run(tools.git, ["-c", "user.name=Cleo Local", "-c", "user.email=cleo-local@users.noreply.github.com",
      "commit", "-m", "Apply local Cleo improvements"], options);
  }

  /** Input: explicit user-approved title/body. Output: user's fork PR; never a release or upstream push. */
  async submitPullRequest(title, body) {
    return this.operation("submitting", async () => {
      if (!title?.trim() || !body?.trim()) throw new Error("请填写 PR 标题和改动说明。");
      await this.checkProtection();
      const tools = await this.tools.prepare(true);
      await run(tools.gh, ["auth", "status"], { env: tools.env });
      const state = await this.store.read();
      const candidate = state.builds.find((item) => item.id === (state.candidate || state.active));
      if (!candidate?.sourceHash || candidate.sourceHash !== await this.sourceHash(tools)) {
        throw new Error("请先对当前修改完成检查和构建，再提交 PR。");
      }
      const user = JSON.parse(await run(tools.gh, ["api", "user"], { env: tools.env }));
      if (!/^[a-zA-Z0-9-]+$/.test(user.login)) throw new Error("GitHub 用户名无效。");
      await run(tools.gh, ["repo", "fork", REPOSITORY, "--clone=false", "--remote=false"], { cwd: this.source, env: tools.env });
      await this.commit(tools);
      if (state.pullRequest?.merged || state.pullRequest?.state === "CLOSED") {
        await run(tools.git, ["switch", "-c", `cleo/local-${randomUUID().slice(0, 8)}`],
          { cwd: this.source, env: tools.env });
      }
      const branch = await run(tools.git, ["branch", "--show-current"], { cwd: this.source, env: tools.env });
      if (!/^cleo\/[a-zA-Z0-9-]+$/.test(branch)) throw new Error("只能提交 Cleo 管理的本地分支。");
      // git invokes credential helpers through sh; quote the trusted executable as a shell literal.
      const helper = `!'${tools.gh.replaceAll("\\", "/").replaceAll("'", "'\\''")}' auth git-credential`;
      await run(tools.git, ["-c", "credential.helper=", "-c", `credential.helper=${helper}`, "push",
        `https://github.com/${user.login}/Cleo-AI-agent.git`, `HEAD:refs/heads/${branch}`], { cwd: this.source, env: tools.env });
      const bodyFile = join(this.store.root, "pr-body.md");
      await writeFile(bodyFile, body, "utf8");
      let url = state.pullRequest?.state === "OPEN" ? state.pullRequest.url : null;
      if (url) {
        await run(tools.gh, ["pr", "edit", url, "--repo", REPOSITORY,
          "--title", title.trim(), "--body-file", bodyFile], { cwd: this.source, env: tools.env });
      } else {
        url = await run(tools.gh, ["pr", "create", "--repo", REPOSITORY, "--head", `${user.login}:${branch}`,
          "--title", title.trim(), "--body-file", bodyFile], { cwd: this.source, env: tools.env });
      }
      await this.store.update({ pullRequest: { url, state: "OPEN", merged: false } });
      return url;
    });
  }

  /** Input: none. Output: PR acceptance status independent from release availability. */
  async refreshPullRequest() {
    return this.operation("checking", async () => {
      const state = await this.store.read();
      if (!state.pullRequest) return null;
      const tools = await this.tools.prepare(true);
      const pr = JSON.parse(await run(tools.gh, ["pr", "view", state.pullRequest.url, "--repo", REPOSITORY,
        "--json", "url,state,mergedAt"], { env: tools.env }));
      return this.store.update({ pullRequest: { url: pr.url, state: pr.state, merged: Boolean(pr.mergedAt) } });
    });
  }

  /** Input: toolchain. Output: completes a resolved upgrade while trusting recovery code only from its release tag. */
  async finishMerge(tools) {
    const state = await this.store.read();
    if (!state.pendingMerge) return;
    const options = { cwd: this.source, env: tools.env };
    const unresolved = await run(tools.git, ["diff", "--name-only", "--diff-filter=U"], options);
    if (unresolved) throw new Error(`请先让 Cleo 解决这些升级冲突，再构建：\n${unresolved}`);
    for (const name of PROTECTED) {
      const expected = await run(tools.git, ["show", `${state.pendingMerge}:ui/electron/${name}`], options);
      const current = await readFile(join(this.source, "ui/electron", name), "utf8");
      if (current.replaceAll("\r\n", "\n").trim() !== expected.replaceAll("\r\n", "\n").trim()) {
        throw new Error(`恢复模块必须保留正式 release 中的实现：${name}`);
      }
    }
    if (await exists(join(this.source, ".git/MERGE_HEAD"))) {
      await run(tools.git, ["-c", "user.name=Cleo Local", "-c", "user.email=cleo-local@users.noreply.github.com",
        "commit", "--no-edit"], options);
    }
    await this.saveProtection();
    await this.store.update({ baseTag: state.pendingMerge, pendingMerge: null, candidate: null });
  }

  /** Input: published tag. Output: merge attempt in editable source; active app is unchanged on conflicts. */
  async mergeRelease(tag) {
    return this.operation("merging", async () => {
      const releases = await readJson(join(this.store.root, "releases.json"), []);
      if (!releases.some((item) => item.tag === tag)) throw new Error("请选择已发布的正式版本。");
      await this.checkProtection();
      const tools = await this.tools.prepare();
      await this.commit(tools);
      await run(tools.git, ["fetch", "origin", `refs/tags/${tag}:refs/tags/${tag}`], { cwd: this.source, env: tools.env });
      await this.store.update({ pendingMerge: tag });
      await run(tools.git, ["-c", "user.name=Cleo Local", "-c", "user.email=cleo-local@users.noreply.github.com",
        "merge", "--no-edit", tag], { cwd: this.source, env: tools.env, log: (text) => this.log(text) });
      await this.store.update({ baseTag: tag, candidate: null, pendingMerge: null });
      await this.saveProtection();
      this.log("已保留本地修改并合入正式版本；请检查、构建后再应用。\n");
    });
  }
}
