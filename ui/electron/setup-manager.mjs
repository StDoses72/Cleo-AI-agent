import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJson, writeJson } from "./evolution-store.mjs";
import { run, EvolutionTools } from "./evolution-tools.mjs";

// Computer use no longer needs Docker, WSL or a Linux desktop image; saved results for those
// retired items are ignored rather than deleted.
const ITEM_IDS = ["runtime", "harnesses", "tools"];

/** Purpose: Detect and provision optional capabilities only after an explicit selection.
 * Input: owned state directory, packaged runtimes and execution adapters.
 * Output: durable setup progress; no installation happens during scan or startup.
 */
export class SetupManager {
  constructor({ root, toolsRoot, python, resourcesPath, repairRuntime,
    execute = run, platform = process.platform, env = process.env, prepareTools, version = "development" }) {
    Object.assign(this, { root, toolsRoot, python, resourcesPath, repairRuntime, execute, platform, env });
    this.prepareTools = prepareTools || (signal => new EvolutionTools(toolsRoot, text => { this.logs = (this.logs + text).slice(-8000); }).prepare(false, { signal }));
    this.items = []; this.busy = false; this.checking = null; this.logs = ""; this.message = "";
    this.cancel = null; this.closed = false;
    this.version = version;
  }
  async state() {
    const saved = await readJson(join(this.root, "setup-v1.json"), {});
    const items = this.items.length ? this.items : (saved.items || []).filter(item => ITEM_IDS.includes(item?.id));
    return { items, busy: this.busy, checking: Boolean(this.checking), logs: this.logs,
      message: this.message || saved.message || "", dismissed: saved.dismissed === true,
      restartRequired: saved.restartRequired === true, pendingIds: (saved.pendingIds || []).filter(id => ITEM_IDS.includes(id)), platform: this.platform };
  }
  async persist(changes) {
    const path = join(this.root, "setup-v1.json");
    const saved = await readJson(path, {});
    const next = { ...saved, ...changes };
    // Update supported records in place; retired records and unknown per-item fields still
    // belong to older versions, which may be used again after a rollback.
    if (Array.isArray(changes.items)) {
      const updates = new Map(changes.items.map(item => [item.id, item]));
      next.items = (saved.items || []).map(item => {
        const update = updates.get(item?.id);
        if (!update) return item;
        updates.delete(item.id);
        return { ...item, ...update };
      });
      next.items.push(...updates.values());
    }
    if (Array.isArray(changes.pendingIds)) {
      next.pendingIds = [...new Set([...(saved.pendingIds || []).filter(id => !ITEM_IDS.includes(id)), ...changes.pendingIds])];
    }
    await writeJson(path, next);
  }
  /** Purpose: Check once per app version; manual settings checks remain available.
   * Input: packaged version. Output: cached result or one first-launch scan.
   */
  async startup() {
    if (this.startupResult) return this.startupResult;
    this.startupResult = (async () => {
      const saved = await readJson(join(this.root, "setup-v1.json"), {});
      if (saved.checkedVersions?.includes(this.version)) return { ...await this.state(), showOnStartup: false };
      return { ...await this.scan(), showOnStartup: true };
    })();
    try { return await this.startupResult; } catch (error) { this.startupResult = null; throw error; }
  }
  async probe(command, args) {
    try { return { ok: true, detail: (await this.execute(command, args, { timeout: 30000, env: this.env })).replaceAll("\0", "").trim().slice(0, 400) }; }
    catch (error) { return { ok: false, detail: String(error.message).slice(-500) }; }
  }
  async scan() {
    if (this.closed) return this.state();
    if (this.busy) return this.state();
    if (this.checking) return this.checking;
    this.checking = this.inspect();
    try { return await this.checking; } finally { this.checking = null; }
  }
  async inspect() {
    const [runtime, harnesses] = await Promise.all([
      this.probe(this.python, ["-I", "-X", "utf8", "-c", "from cleo.desktop.server import main; print('ready')"]),
      this.probe(this.python, ["-I", "-X", "utf8", "-c", "from cleo.desktop.dependencies import validate_codex_runtime, validate_claude_runtime; validate_codex_runtime(); validate_claude_runtime(); print('ready')"]),
    ]);
    let tools = await readJson(join(this.root, "tools-v1.json"));
    if (!tools) {
      // Discover tools prepared by older Cleo versions without downloading anything.
      const nodes = await readdir(this.toolsRoot).catch(() => []);
      const nodeFolder = nodes.filter(name => /^node-v.*-win-x64$/.test(name)).sort().at(-1);
      const uv = await readJson(join(this.toolsRoot, "astral-sh-uv.json"));
      const git = await readJson(join(this.toolsRoot, "git-for-windows-git.json"));
      tools = { node: nodeFolder ? join(this.toolsRoot, nodeFolder, "node.exe") : "node", git: git?.path || "git", uv: uv?.path || "uv" };
    }
    const toolResults = await Promise.all(["node", "git", "uv"].map(name => this.probe(tools[name], ["--version"])));
    this.items = [
      { id: "runtime", title: "Cleo 基础运行环境", ready: runtime.ok, detail: runtime.ok ? "Cleo Python 已就绪" : runtime.detail, action: "修复运行环境", optional: false },
      { id: "harnesses", title: "Codex / Claude 编码后端", ready: harnesses.ok, detail: harnesses.ok ? "编码后端可启动；账号登录请在模型设置中完成。" : harnesses.detail, action: "修复编码后端", optional: false },
      { id: "tools", title: "自我迭代工具", ready: toolResults.every(item => item.ok), detail: "Git、Node.js、uv；优先使用已有工具，缺少时安装到 Cleo 管理目录。", action: "准备构建工具", optional: true },
    ];
    const saved = await readJson(join(this.root, "setup-v1.json"), {});
    const pendingIds = (saved.pendingIds || []).filter(id => !this.items.find(item => item.id === id)?.ready);
    const allReady = this.items.every(item => item.ready);
    // A fresh successful scan supersedes old installation failures and pending steps.
    if (allReady) this.message = "环境依赖已检查，全部就绪。";
    await this.persist({ items: this.items, pendingIds,
      ...(allReady ? { message: this.message, restartRequired: false } : {}),
      checkedVersions: [...new Set([...(saved.checkedVersions || []), this.version])].slice(-20) });
    return this.state();
  }
  install(ids, consent) {
    if (this.installing) return Promise.reject(new Error("依赖操作正在进行。"));
    this.installing = this.installSelected(ids, consent).finally(() => { this.installing = null; });
    return this.installing;
  }
  async installSelected(ids, consent) {
    if (this.closed) throw new Error("Cleo 正在退出，请重新打开后复查依赖。");
    if (consent !== true) throw new Error("请先确认安装所选依赖。");
    if (this.busy || this.checking) throw new Error("依赖操作正在进行。");
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !this.items.some(item => item.id === id))) throw new Error("请选择检查列表中的依赖。");
    this.busy = true; this.logs = ""; this.cancel = new AbortController();
    const ordered = ITEM_IDS.filter(id => ids.includes(id));
    try {
      await this.persist({ pendingIds: ordered, restartRequired: false });
      for (const id of ordered) {
        this.cancel.signal.throwIfAborted();
        this.message = `正在准备：${this.items.find(item => item.id === id).title}`;
        await this.persist({ installing: id, message: this.message });
        if (id === "runtime" || id === "harnesses") {
          await this.repairRuntime();
          this.message = "运行环境已准备，请关闭并重新打开 Cleo 后复查。";
          await this.persist({ pendingIds: ordered.slice(ordered.indexOf(id) + 1), message: this.message });
          break;
        } else if (id === "tools") {
          const tools = await this.prepareTools(this.cancel.signal);
          await writeJson(join(this.root, "tools-v1.json"), { node: tools.node, git: tools.git, uv: tools.uv });
        }
        await this.persist({ pendingIds: ordered.slice(ordered.indexOf(id) + 1) });
        this.message = "所选步骤已完成，正在复查可用性。";
      }
    } catch (error) {
      this.message = `准备未完成：${error.message}`;
      throw error;
    } finally {
      try { await this.persist({ installing: null, message: this.message }); }
      finally { this.busy = false; this.cancel = null; }
      if (!this.closed) await this.scan();
    }
    return this.state();
  }
  async dismiss() { if (this.busy) throw new Error("请等待当前安装完成。"); const saved = await readJson(join(this.root, "setup-v1.json"), {}); await this.persist({ dismissed: true, checkedVersions: [...new Set([...(saved.checkedVersions || []), this.version])].slice(-20) }); return this.state(); }
  async close() { this.closed = true; this.cancel?.abort(new Error("Cleo 正在退出，重新打开后请复查依赖。")); await this.installing?.catch(() => {}); }
}
