import { spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { delimiter, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export class BackendBridge {
  constructor({ app, here }) {
    this.app = app;
    this.here = here;
    this.process = null;
    this.pending = new Map();
    this.stderr = "";
    this.closing = false;
  }

  request(method, params = {}, onEvent = null) {
    this.start();
    const id = randomUUID();
    this.debug(`request ${method} ${id}`);
    return new Promise((resolveRequest, rejectRequest) => {
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, onEvent });
      this.process.stdin.write(`${JSON.stringify({ id, method, params })}\n`, "utf8", (error) => {
        if (!error) return;
        this.pending.delete(id);
        rejectRequest(error);
      });
    });
  }

  start() {
    if (this.process && !this.process.killed) return;
    const paths = this.runtimePaths();
    this.prepareHome(paths);
    const python = process.env.CLEO_PYTHON || paths.python || "python";
    const pythonPath = this.app.isPackaged
      ? ""
      : [paths.backendRoot, process.env.PYTHONPATH].filter(Boolean).join(delimiter);
    const runtimePath = [
      paths.python ? join(dirname(paths.python), "Scripts") : null,
      paths.browserRoot,
      paths.browserRoot ? join(paths.browserRoot, "node_modules", ".bin") : null,
      process.env.PATH,
    ].filter(Boolean).join(delimiter);
    this.stderr = "";
    const child = spawn(python, ["-m", "cleo.desktop.server"], {
      cwd: paths.backendRoot,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        PYTHONPATH: pythonPath,
        PATH: runtimePath,
        CLEO_HOME: process.env.CLEO_HOME || paths.cleoHome,
        CLEO_CONFIG_PATH: process.env.CLEO_CONFIG_PATH || paths.configPath,
        CLEO_HARNESSES_CONFIG_PATH: process.env.CLEO_HARNESSES_CONFIG_PATH || paths.harnessesPath,
        HF_HOME: process.env.HF_HOME || paths.modelsRoot,
      },
    });
    this.process = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8000);
      this.debug(`stderr ${chunk}`);
    });
    child.on("exit", (code) => {
      this.debug(`exit ${code}`);
      if (this.process !== child) return;
      const detail = this.stderr.trim();
      const message = detail || `Cleo backend exited with code ${code ?? "unknown"}.`;
      for (const pending of this.pending.values()) pending.reject(new Error(message));
      this.pending.clear();
      if (this.process === child) this.process = null;
    });
    child.on("error", (error) => {
      if (this.process !== child) return;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  handleLine(line) {
    this.debug(`stdout ${line.slice(0, 240)}`);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === "event") {
      pending.onEvent?.(message.event);
      return;
    }
    this.pending.delete(message.id);
    if (message.type === "error") {
      pending.reject(new Error(message.error?.message || "Cleo backend request failed."));
    } else {
      pending.resolve(message.result);
    }
  }

  runtimePaths() {
    if (!this.app.isPackaged) {
      const sourceRoot = resolve(this.here, "../..");
      return { backendRoot: sourceRoot, cleoHome: sourceRoot };
    }
    const cleoHome = process.env.CLEO_HOME || this.app.getPath("userData");
    return {
      backendRoot: process.resourcesPath,
      cleoHome,
      python: join(process.resourcesPath, "python", "python.exe"),
      defaultsRoot: join(process.resourcesPath, "defaults"),
      browserRoot: join(process.resourcesPath, "browser"),
      configPath: join(cleoHome, "config", "cleo.json"),
      harnessesPath: join(cleoHome, "config", "harnesses.json"),
      modelsRoot: join(cleoHome, "models"),
    };
  }

  prepareHome(paths) {
    if (!paths.defaultsRoot) return;
    for (const directory of ["assets", "config", "data", "memory", "skills", "workspace", "models"]) {
      mkdirSync(join(paths.cleoHome, directory), { recursive: true });
    }
    const defaults = [
      ["config/cleo.json", "config/cleo.json"],
      ["config/harnesses.json", "config/harnesses.json"],
      ["memory/MEMORY_POLICY.md", "memory/MEMORY_POLICY.md"],
      ["assets/startup.png", "assets/startup.png"],
      ["PERSONA.md", "PERSONA.md"],
    ];
    for (const [source, destination] of defaults) {
      const target = join(paths.cleoHome, destination);
      if (!existsSync(target)) copyFileSync(join(paths.defaultsRoot, source), target);
    }
    const defaultSkills = join(paths.defaultsRoot, "skills");
    if (existsSync(defaultSkills)) {
      cpSync(defaultSkills, join(paths.cleoHome, "skills"), {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
    }
  }

  debug(message) {
    if (process.env.CLEO_DESKTOP_DEBUG === "1") {
      console.error(`[cleo-backend] ${message}`);
    }
  }

  async close() {
    if (this.closing || !this.process) return;
    this.closing = true;
    const active = this.process;
    try {
      await Promise.race([
        this.request("shutdown"),
        new Promise((resolveClose) => setTimeout(resolveClose, 1800)),
      ]);
    } catch {
      // The process may exit before the final protocol response is read.
    }
    if (active && !active.killed) active.kill();
  }

  async restart() {
    await this.close();
    this.process = null;
    this.closing = false;
  }
}
