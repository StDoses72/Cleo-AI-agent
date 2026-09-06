import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { bundledPython } from "./platform.mjs";

const execute = promisify(execFile);

export function readDependencyState(root) {
  try {
    const value = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

export function findCodexBinary(browserRoot) {
  const root = join(browserRoot, "node_modules", "@openai");
  if (!existsSync(root)) return undefined;
  const name = process.platform === "win32" ? "codex.exe" : "codex";
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name === name) return path;
      if (entry.isDirectory()) {
        const found = visit(path);
        if (found) return found;
      }
    }
    return undefined;
  };
  return visit(root);
}

export function selectRuntime(root, resourcesPath) {
  const state = readDependencyState(root);
  const candidate = typeof state.active === "string" && /^[a-f0-9]{32}$/.test(state.active)
    ? join(root, state.active) : null;
  const valid = candidate && existsSync(candidate)
    && dirname(realpathSync(candidate)) === realpathSync(root)
    && existsSync(managedPython(candidate))
    && existsSync(join(candidate, "browser", "package.json"));
  const resources = valid ? candidate : resourcesPath;
  const browserRoot = join(resources, "browser");
  return {
    python: valid ? managedPython(resources) : bundledPython(resources), browserRoot,
    codexBin: findCodexBinary(browserRoot), current: valid ? state.active : null,
  };
}

export function managedPython(snapshot) {
  return join(snapshot, "python", process.platform === "win32" ? "Scripts/python.exe" : "bin/python3");
}

export class DependencyUpdater {
  constructor({ app, resourcesPath, cleoHome, onState = () => {} }) {
    this.app = app;
    this.resourcesPath = resourcesPath;
    const key = createHash("sha256").update(resolve(resourcesPath || ".")).digest("hex").slice(0, 24);
    const version = createHash("sha256").update(app.getVersion()).digest("hex").slice(0, 24);
    this.installationRoot = join(cleoHome, "runtimes", key);
    this.root = join(this.installationRoot, version);
    this.onState = onState;
    this.child = null;
    this.runtime = null;
    this.checking = null;
    this.closed = false;
  }

  async prepare() {
    if (!this.app.isPackaged || process.env.CLEO_PYTHON || process.env.CLEO_DESKTOP_MOCK === "1") return null;
    this.runtime = selectRuntime(this.root, this.resourcesPath);
    if (this.runtime.current) {
      try {
        await execute(this.runtime.python, ["-I", "-c", "from cleo.desktop.server import main"], {
          timeout: 60_000, windowsHide: true,
        });
      } catch (error) {
        const state = { ...readDependencyState(this.root), active: null, phase: "error", error: `依赖启动检查失败，已恢复随应用安装的版本：${error.message}` };
        await writeFile(join(this.root, "state.json"), JSON.stringify(state));
        this.runtime = selectRuntime(this.root, this.resourcesPath);
      }
    }
    this.publish();
    return this.runtime;
  }

  publish() {
    try {
      const state = readDependencyState(this.root);
      this.onState({
        phase: state.phase === "ready" && state.active === this.runtime?.current ? "up-to-date" : state.phase || "idle",
        error: state.error || null,
      });
    } catch (error) {
      this.onState({ phase: "error", error: error.message });
    }
  }

  check() {
    if (!this.runtime || this.closed) return Promise.resolve();
    if (!this.checking) {
      this.checking = this.checkInternal()
        .catch((error) => this.onState({ phase: "error", error: error.message }))
        .finally(() => { this.checking = null; });
    }
    return this.checking;
  }

  async checkInternal() {
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.installationRoot, { withFileTypes: true })) {
      const path = join(this.installationRoot, entry.name);
      if (path !== this.root && entry.isDirectory() && /^[a-f0-9]{24}$/.test(entry.name)
          && dirname(realpathSync(path)) === realpathSync(this.installationRoot)) {
        await rm(path, { recursive: true });
      }
    }
    if (this.closed) return;
    const args = ["-I", "-m", "cleo.desktop.dependencies", "--root", this.root,
      "--python-root", join(this.resourcesPath, "python"),
      "--browser-root", join(this.resourcesPath, "browser")];
    if (this.runtime.current) args.push("--current", this.runtime.current);
    this.onState({ phase: "checking", error: null });
    await new Promise((done) => {
      const child = spawn(bundledPython(this.resourcesPath), args, {
        windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"],
      });
      this.child = child;
      let detail = "";
      child.stderr.on("data", (chunk) => { detail = `${detail}${chunk}`.slice(-3000); });
      const timer = setInterval(() => this.publish(), 1000);
      child.once("error", (error) => { detail = error.message; });
      child.once("close", (code) => {
        clearInterval(timer);
        this.child = null;
        this.publish();
        if (code !== 0) this.onState({ phase: "error", error: detail || "依赖更新中断；当前运行版本不受影响。" });
        done();
      });
    });
  }

  async close() {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    if (process.platform === "win32") {
      try {
        await execute("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } catch (error) {
        if (this.child === child) throw error;
      }
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
}
