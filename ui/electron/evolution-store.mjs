import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as nativeFs from "node:fs/promises";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, rename, lstat, readdir, open, rm } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";

const mutationQueues = new Map();

export const DATA_ENTRIES = ["config", "data", "memory", "skills", "PERSONA.md", "AGENTS.md"];

/** Purpose: Read optional JSON state. Input: file and fallback. Output: parsed state; corruption is not hidden. */
export async function readJson(path, fallback = null) {
  try { return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

/** Purpose: Persist a complete record atomically. Input: path and JSON value. Output: durable replaced file. */
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}

/** Purpose: Reject unsafe managed paths. Input: root and relative segments. Output: absolute child path. */
export function ownedPath(root, ...segments) {
  const path = resolve(root, ...segments);
  const child = relative(resolve(root), path);
  if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("Invalid managed path.");
  return path;
}

/** Purpose: Check existence without masking permission errors. Input: path. Output: boolean. */
export async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

/** Purpose: Keep backups within owned data. Input: tree. Output: rejects links before copying. */
export async function rejectLinks(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`无法备份链接，请先移除或迁移：${path}`);
  if (info.isDirectory()) for (const entry of await readdir(path)) await rejectLinks(join(path, entry));
}

/** Purpose: Identify build inputs and downloads. Input: file. Output: SHA-256 hex digest. */
export async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Purpose: Persist local builds and recoverable activation transactions outside editable source. */
export class EvolutionStore {
  constructor(root, dataHome) {
    this.root = resolve(root);
    this.dataHome = resolve(dataHome);
    this.statePath = join(this.root, "state.json");
  }

  /** Purpose: Serialize startup cleanup with UI operations sharing this registry.
   * Input: asynchronous mutation. Output: its result; failures do not block later operations.
   */
  async exclusive(action) {
    const previous = mutationQueues.get(this.root) || Promise.resolve();
    const pending = previous.catch(() => {}).then(action);
    mutationQueues.set(this.root, pending);
    try { return await pending; }
    finally { if (mutationQueues.get(this.root) === pending) mutationQueues.delete(this.root); }
  }

  /** Input: none. Output: saved registry or an empty initial registry. */
  async read() {
    return await readJson(this.statePath, {
      schema: 1, active: null, baseline: null, builds: [], transaction: null,
      baseTag: null, threadId: null, pullRequest: null, prepared: false,
    });
  }

  /** Input: state patch. Output: updated registry; callers serialize mutations. */
  async update(patch) {
    const state = { ...await this.read(), ...patch };
    await writeJson(this.statePath, state);
    return state;
  }

  /** Input: registered build id. Output: validated record and owned executable. */
  async build(id) {
    const state = await this.read();
    const build = state.builds.find((item) => item.id === id);
    if (!build || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("找不到所选构建。");
    const directory = ownedPath(this.root, "builds", id);
    const executable = ownedPath(directory, build.executable);
    if (!await exists(executable)) throw new Error("所选构建文件缺失，请使用保底版本恢复。");
    return { ...build, directory, executable };
  }

  /** Input: backup id. Output: complete consistent data copy, after all writers have stopped. */
  async backup(id) {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid backup id.");
    const destination = ownedPath(this.root, "backups", id);
    if (await exists(destination)) throw new Error("恢复点已存在，拒绝覆盖。");
    await mkdir(destination, { recursive: true });
    const entries = [];
    for (const name of DATA_ENTRIES) {
      const source = join(this.dataHome, name);
      if (!await exists(source)) continue;
      await rejectLinks(source);
      await cp(source, join(destination, name), { recursive: true, errorOnExist: true, force: false });
      entries.push(name);
    }
    await writeJson(join(destination, "snapshot.json"), { entries, createdAt: new Date().toISOString() });
    return id;
  }

  /** Purpose: Mark the start of editable work without losing the selected starting version.
   * Input: none. Output: persisted iteration base, retained across repeated apply/restart cycles.
   */
  async beginIteration() {
    const state = await this.read();
    if (state.iteration) {
      await this.update({ draftDirty: true });
      return state.iteration;
    }
    await this.build(state.active);
    const iteration = { base: state.active, startedAt: new Date().toISOString() };
    await this.update({ iteration, draftDirty: true, workspaceBase: state.workspaceBase || state.selectedBase || state.active });
    return iteration;
  }

  /** Purpose: Keep the currently applied program as a selectable local version.
   * Input: optional display name. Output: saved build; no release is created and no data is rewritten.
   */
  async saveVersion(name = "") {
    const state = await this.read();
    if (state.transaction) throw new Error("请等待应用启动完成后再保存。");
    const build = await this.build(state.active);
    if (!state.iteration || build.kind !== "local" || build.id === state.iteration.base) {
      throw new Error("请先应用本轮改动，再保存为本地版本。");
    }
    const saveSequence = (state.saveSequence || state.builds.filter((item) => item.savedAt).length) + 1;
    const saved = { ...state.builds.find((item) => item.id === build.id),
      name: String(name).trim().slice(0, 80) || undefined,
      savedAt: new Date().toISOString() };
    await this.update({ builds: state.builds.map((item) => item.id === saved.id ? saved : item),
      iteration: null, candidate: null, draftDirty: false, selectedBase: saved.id, latestSaved: saved.id, saveSequence,
      workspaceBase: state.workspaceBase || state.iteration.base, baseSourceHash: saved.sourceHash });
    await this.pruneBuilds();
    return saved;
  }

  /** Purpose: Bound retained programs to the base, latest saved version, and current work.
   * Input: none; call after serialized mutations or a successful startup.
   * Output: obsolete owned bundles removed; locked files are queued for a later retry. User data is never touched.
   */
  async pruneBuilds() {
    const state = await this.read();
    // Never collect while a new executable is still unproven.
    if (state.transaction || !state.baseline || !state.active) return [];
    const workspaceBase = state.workspaceBase || state.iteration?.base || state.selectedBase || state.active;
    const saved = state.builds.filter((build) => build.savedAt)
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    const latestSaved = saved.find((build) => build.id === state.latestSaved)?.id || saved[0]?.id || null;
    const keep = new Set([state.baseline, workspaceBase, latestSaved, state.active,
      state.selectedBase, state.iteration?.base, state.candidate, state.pendingImport?.from].filter(Boolean));
    const executingPath = relative(ownedPath(this.root, "builds"), resolve(process.execPath));
    if (!executingPath.startsWith("..") && !isAbsolute(executingPath)) keep.add(executingPath.split(/[\\\\/]/)[0]);
    // Missing recovery dependencies must not turn a damaged registry into destructive cleanup.
    try { for (const id of keep) await this.build(id); }
    catch { return []; }

    const retired = state.builds.filter((build) => !keep.has(build.id)).map((build) => build.id);
    const filesystem = process.versions.electron
      ? createRequire(import.meta.url)("original-fs").promises : nativeFs;
    const folders = await filesystem.readdir(ownedPath(this.root, "builds"));
    const abandoned = folders.filter((id) => /^(baseline|local|official)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) && !keep.has(id));
    const pending = [...new Set([...(state.cleanupPending || []), ...retired, ...abandoned])]
      .filter((id) => /^[a-zA-Z0-9-]+$/.test(id) && !keep.has(id));
    const builds = state.builds.filter((build) => keep.has(build.id));
    const lastApplication = state.lastApplication && {
      ...state.lastApplication,
      from: keep.has(state.lastApplication.from) ? state.lastApplication.from : null,
    };
    // Record deletion intent first so crashes and Windows file locks can be retried.
    await this.update({ builds, workspaceBase, latestSaved, cleanupPending: pending, lastApplication });
    const removed = [];
    const failures = [];
    for (const id of pending) {
      try {
        const parent = ownedPath(this.root, "builds");
        const directory = ownedPath(parent, id);
        const dataRelation = relative(directory, this.dataHome);
        const directoryRelation = relative(this.dataHome, directory);
        if ((!dataRelation.startsWith("..") && !isAbsolute(dataRelation)) ||
            (!directoryRelation.startsWith("..") && !isAbsolute(directoryRelation))) {
          throw new Error("Refusing to clean a user-data path.");
        }
        // Do not traverse a relocated builds directory or an externally linked bundle.
        const rootPath = await filesystem.realpath(this.root);
        if (await filesystem.realpath(parent) !== join(rootPath, "builds")) throw new Error("Linked builds directory.");
        try {
          if ((await filesystem.lstat(directory)).isSymbolicLink()) throw new Error("Linked build directory.");
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        await filesystem.rm(directory, { recursive: true, force: true });
        removed.push(id);
      } catch { failures.push(id); }
    }
    await this.update({ cleanupPending: failures });
    return removed;
  }

  /** Input: target build id. Output: program-only switch; shared user data and active selection are unchanged. */
  async stage(target) {
    await this.build(target);
    const state = await this.read();
    if (state.transaction) throw new Error("上一次应用尚未完成，请打开恢复入口。");
    const transaction = {
      id: randomUUID(), from: state.active, to: target,
      phase: "staged", backup: null, createdAt: new Date().toISOString(),
    };
    await this.update({ transaction });
    return transaction;
  }

  /** Input: none. Output: switches only after a complete backup; restart can resume safely. */
  async activate() {
    const state = await this.read();
    const tx = state.transaction;
    if (!tx) throw new Error("没有待应用的改动。");
    await this.build(tx.to);
    if (!tx.backup) {
      const backup = `apply-${tx.id}`;
      // A crash during backup leaves an incomplete, unreferenced copy. Never treat it as usable.
      const complete = await readJson(join(this.root, "backups", backup, "snapshot.json"));
      if (!complete && await exists(join(this.root, "backups", backup))) {
        await rm(ownedPath(this.root, "backups", backup), { recursive: true, force: true });
      }
      if (!complete) await this.backup(backup);
      tx.backup = backup;
      await this.update({ transaction: tx });
    }
    // Ignore legacy restore requests: switching programs must never replace current user data.
    delete tx.restore;
    await this.update({ active: tx.to, transaction: { ...tx, phase: "starting" } });
    return this.build(tx.to);
  }

  /** Purpose: Select a retained program after a failed launch without touching shared user data.
   * Input: registered build id, with application writers stopped. Output: selected build and cleared transaction.
   */
  async recover(target) {
    const build = await this.build(target);
    await this.update({ active: target, transaction: null });
    return build;
  }

  /** Purpose: Acknowledge a proven startup before reclaiming superseded programs.
   * Input: activation id, or none for an ordinary/imported startup. Output: cleared transaction and bounded retained builds.
   */
  async healthy(transactionId) {
    const state = await this.read();
    if (transactionId) {
      if (!state.transaction || state.transaction.id !== transactionId || state.transaction.phase !== "starting") return;
      await this.update({ lastApplication: state.transaction, transaction: null });
    } else if (state.transaction) return;
    if (state.pendingImport?.to === state.active) await this.update({ pendingImport: null });
    await this.pruneBuilds();
  }
}
