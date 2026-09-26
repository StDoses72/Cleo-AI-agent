import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJson, writeJson } from "./evolution-store.mjs";
import { run, EvolutionTools } from "./evolution-tools.mjs";

/** Purpose: Discover both supported Docker installation locations without modifying PATH.
 * Input: environment. Output: executable path or normal command lookup.
 */
export async function dockerExecutable(env = process.env) {
  for (const path of [join(env.LOCALAPPDATA || "", "Programs/DockerDesktop/resources/bin/docker.exe"),
    join(env.ProgramFiles || "C:/Program Files", "Docker/Docker/resources/bin/docker.exe")]) {
    try { await access(path); return path; } catch { /* Try the other installation mode. */ }
  }
  return "docker";
}

/** Purpose: Detect and provision optional capabilities only after an explicit selection.
 * Input: owned state directory, packaged runtimes and execution adapters.
 * Output: durable setup progress; no installation happens during scan or startup.
 */
export class SetupManager {
  constructor({ root, toolsRoot, python, resourcesPath, desktop, repairRuntime,
    execute = run, platform = process.platform, env = process.env, prepareTools, version = "development" }) {
    Object.assign(this, { root, toolsRoot, python, resourcesPath, desktop, repairRuntime, execute, platform, env });
    this.prepareTools = prepareTools || (signal => new EvolutionTools(toolsRoot, text => { this.logs = (this.logs + text).slice(-8000); }).prepare(false, { signal }));
    this.items = []; this.busy = false; this.checking = null; this.logs = ""; this.message = "";
    this.cancel = null; this.closed = false;
    this.version = version;
  }
  async state() {
    const saved = await readJson(join(this.root, "setup-v1.json"), {});
    return { items: this.items.length ? this.items : saved.items || [], busy: this.busy, checking: Boolean(this.checking), logs: this.logs,
      message: this.message || saved.message || "", dismissed: saved.dismissed === true,
      restartRequired: saved.restartRequired === true, pendingIds: saved.pendingIds || [], platform: this.platform };
  }
  async persist(changes) {
    const path = join(this.root, "setup-v1.json");
    await writeJson(path, { ...await readJson(path, {}), ...changes });
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
  async engine() {
    const probe = await this.probe(await dockerExecutable(this.env), ["info", "--format", "{{.ServerVersion}}"]);
    // Some Windows Docker clients print connection errors but exit zero with empty stdout.
    if (!probe.ok || !/^\d+\.\d+/.test(probe.detail)) return { ok: false, detail: "Docker 引擎尚未运行。请启动 Docker Desktop 后重试。" };
    const backend = await this.desktop("check");
    return { ok: backend.ready === true, detail: backend.ready ? backend.version : backend.detail };
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
    const [runtime, harnesses, docker, wsl] = await Promise.all([
      this.probe(this.python, ["-I", "-X", "utf8", "-c", "from cleo.desktop.server import main; print('ready')"]),
      this.probe(this.python, ["-I", "-X", "utf8", "-c", "from cleo.desktop.dependencies import validate_codex_runtime, validate_claude_runtime; validate_codex_runtime(); validate_claude_runtime(); print('ready')"]),
      this.engine().catch(error => ({ ok: false, detail: error.message })),
      this.platform === "win32" ? this.probe("wsl.exe", ["--version"]) : Promise.resolve({ ok: true, detail: "此系统不需要 WSL" }),
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
    const dockerCLI = docker.ok ? docker : await this.probe(await dockerExecutable(this.env), ["--version"]);
    this.items = [
      { id: "runtime", title: "Cleo 基础运行环境", ready: runtime.ok, detail: runtime.ok ? "Cleo Python 已就绪" : runtime.detail, action: "修复运行环境", optional: false },
      { id: "harnesses", title: "Codex / Claude 编码后端", ready: harnesses.ok, detail: harnesses.ok ? "编码后端可启动；账号登录请在模型设置中完成。" : harnesses.detail, action: "修复编码后端", optional: false },
      { id: "tools", title: "自我迭代工具", ready: toolResults.every(item => item.ok), detail: "Git、Node.js、uv；优先使用已有工具，缺少时安装到 Cleo 管理目录。", action: "准备构建工具", optional: true },
      ...(this.platform === "win32" ? [{ id: "wsl", title: "WSL · 独立桌面的系统依赖", ready: wsl.ok, detail: wsl.ok ? "WSL 已安装；独立桌面可用性还需验证 Docker 引擎。" : "需要系统授权，安装后可能需要重启电脑；硬件虚拟化须已开启。", action: "安装或更新 WSL", optional: true }] : []),
      { id: "docker", title: "Docker Desktop", ready: docker.ok, detail: docker.ok ? `引擎已就绪 · ${docker.detail}` : dockerCLI.ok ? "已经安装，但引擎尚未就绪。将尝试启动，请完成 Docker 首次设置。" : "独立桌面需要 Docker；普通聊天和开发任务可以跳过。", action: dockerCLI.ok ? "启动 Docker" : "安装 Docker", optional: true },
      { id: "desktop", title: "Computer use 独立桌面", ready: false, detail: "在 Docker 就绪后准备桌面镜像，并实际验证桌面连接。", action: "准备独立桌面", optional: true },
    ];
    if (docker.ok) {
      try { const state = await this.desktop("status"); this.items.at(-1).ready = state.phase === "ready" || state.ready === true; }
      catch { /* Status failure remains actionable, never equivalent to readiness. */ }
    }
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
    const options = { env: this.env, signal: this.cancel.signal, timeout: 1800000,
      log: text => { this.logs = (this.logs + text).slice(-8000); } };
    const ordered = ["runtime", "harnesses", "tools", "wsl", "docker", "desktop"].filter(id => ids.includes(id));
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
        } else if (id === "wsl") {
          if (this.platform !== "win32") throw new Error("此系统不需要 WSL。");
          const ready = await this.probe("wsl.exe", ["--version"]);
          const args = ready.ok ? "'--update'" : "'--install','--no-distribution'";
          await this.execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
            `$p = Start-Process -FilePath wsl.exe -ArgumentList ${args} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`],
          { ...options, successCodes: [0, 3010] });
          this.message = "WSL 安装请求已完成。如系统要求重启，请重启后打开 Cleo 继续检查。";
          await this.persist({ restartRequired: true, pendingIds: ordered.slice(ordered.indexOf(id) + 1), message: this.message });
          break;
        } else if (id === "docker") {
          if (this.platform !== "win32") throw new Error("请安装系统支持的 Docker Desktop，然后重新检查。");
          if (!(await this.probe(await dockerExecutable(this.env), ["--version"])).ok) {
            await this.execute("winget.exe", ["install", "--id", "Docker.DockerDesktop", "--exact", "--source", "winget",
              "--accept-source-agreements", "--accept-package-agreements", "--disable-interactivity"], options);
          }
          const locations = [join(this.env.LOCALAPPDATA || "", "Programs/DockerDesktop/Docker Desktop.exe"), join(this.env.ProgramFiles || "C:/Program Files", "Docker/Docker/Docker Desktop.exe")];
          const exe = (await Promise.all(locations.map(async path => { try { await access(path); return path; } catch { return null; } }))).find(Boolean);
          if (exe) await this.execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
            `Start-Process -FilePath '${exe.replaceAll("'", "''")}' -WindowStyle Hidden`], options);
          if (!(await this.engine()).ok) {
            this.message = "Docker 已安装或正在启动。请完成其首次设置，然后点击重新检查。";
            break;
          }
        } else if (id === "desktop") {
          if (!(await this.engine()).ok) throw new Error("Docker 引擎尚未就绪。请先选择“启动 Docker”，完成其首次设置后重新检查。");
          const state = await this.desktop("start");
          if (state.phase !== "ready" && state.ready !== true) throw new Error(state.error || "独立桌面尚未就绪，请查看电脑面板后重试。");
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
