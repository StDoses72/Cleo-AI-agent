import { t as tr } from "./i18n.mjs";
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
      { id: "runtime", title: tr("setup_manager.cleo_base_runtime"), ready: runtime.ok, detail: runtime.ok ? tr("setup_manager.cleo_python_is_ready") : runtime.detail, action: tr("setup_manager.repair_runtime"), optional: false },
      { id: "harnesses", title: tr("setup_manager.codex_claude_coding_backends"), ready: harnesses.ok, detail: harnesses.ok ? tr("setup_manager.coding_backends_can_start_complete_account_sign_in_in_model_settings") : harnesses.detail, action: tr("setup_manager.repair_coding_backends"), optional: false },
      { id: "tools", title: tr("setup_manager.self_iteration_tools"), ready: toolResults.every(item => item.ok), detail: tr("setup_manager.git_node_js_and_uv_existing_tools_are_preferred_missing_ones_are_installed_in_cleo_s_"), action: tr("setup_manager.prepare_build_tools"), optional: true },
    ];
    const saved = await readJson(join(this.root, "setup-v1.json"), {});
    const pendingIds = (saved.pendingIds || []).filter(id => !this.items.find(item => item.id === id)?.ready);
    const allReady = this.items.every(item => item.ready);
    // A fresh successful scan supersedes old installation failures and pending steps.
    if (allReady) this.message = tr("setup_manager.environment_dependencies_checked_everything_is_ready");
    await this.persist({ items: this.items, pendingIds,
      ...(allReady ? { message: this.message, restartRequired: false } : {}),
      checkedVersions: [...new Set([...(saved.checkedVersions || []), this.version])].slice(-20) });
    return this.state();
  }
  install(ids, consent) {
    if (this.installing) return Promise.reject(new Error(tr("setup_manager.a_dependency_operation_is_in_progress")));
    this.installing = this.installSelected(ids, consent).finally(() => { this.installing = null; });
    return this.installing;
  }
  async installSelected(ids, consent) {
    if (this.closed) throw new Error(tr("setup_manager.cleo_is_shutting_down_reopen_it_and_check_dependencies_again"));
    if (consent !== true) throw new Error(tr("setup_manager.confirm_installation_of_the_selected_dependencies_first"));
    if (this.busy || this.checking) throw new Error(tr("setup_manager.a_dependency_operation_is_in_progress"));
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !this.items.some(item => item.id === id))) throw new Error(tr("setup_manager.choose_dependencies_from_the_checklist"));
    this.busy = true; this.logs = ""; this.cancel = new AbortController();
    const ordered = ITEM_IDS.filter(id => ids.includes(id));
    try {
      await this.persist({ pendingIds: ordered, restartRequired: false });
      for (const id of ordered) {
        this.cancel.signal.throwIfAborted();
        this.message = tr("setup_manager.preparing_value", { p0: this.items.find(item => item.id === id).title });
        await this.persist({ installing: id, message: this.message });
        if (id === "runtime" || id === "harnesses") {
          await this.repairRuntime();
          this.message = tr("setup_manager.runtime_prepared_close_and_reopen_cleo_then_check_again");
          await this.persist({ pendingIds: ordered.slice(ordered.indexOf(id) + 1), message: this.message });
          break;
        } else if (id === "tools") {
          const tools = await this.prepareTools(this.cancel.signal);
          await writeJson(join(this.root, "tools-v1.json"), { node: tools.node, git: tools.git, uv: tools.uv });
        }
        await this.persist({ pendingIds: ordered.slice(ordered.indexOf(id) + 1) });
        this.message = tr("setup_manager.selected_steps_completed_checking_availability_again");
      }
    } catch (error) {
      this.message = tr("setup_manager.preparation_incomplete_value", { p0: error.message });
      throw error;
    } finally {
      try { await this.persist({ installing: null, message: this.message }); }
      finally { this.busy = false; this.cancel = null; }
      if (!this.closed) await this.scan();
    }
    return this.state();
  }
  async dismiss() { if (this.busy) throw new Error(tr("setup_manager.wait_for_the_current_installation_to_finish")); const saved = await readJson(join(this.root, "setup-v1.json"), {}); await this.persist({ dismissed: true, checkedVersions: [...new Set([...(saved.checkedVersions || []), this.version])].slice(-20) }); return this.state(); }
  async close() { this.closed = true; this.cancel?.abort(new Error(tr("setup_manager.cleo_is_shutting_down_check_dependencies_again_after_reopening"))); await this.installing?.catch(() => {}); }
}
