import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { desktopPlatform } from "./platform.mjs";
import { ReleaseDownloads } from "./release-downloads.mjs";
import { run as execute } from "./evolution-tools.mjs";

const digest = data => createHash("sha256").update(data).digest("hex");

export function readRuntimePlan(resources) {
  const path = join(resources, "runtime-plan.json");
  if (!existsSync(path)) return null;
  const data = readFileSync(path);
  const plan = JSON.parse(data);
  if (plan.schema !== 1 || plan.platform !== desktopPlatform().id
      || !/^[\w.-]+\.whl$/.test(plan.wheel?.archive || ""))
    throw new Error("The online runtime plan does not match this platform.");
  for (const name of ["requirements.txt", "package.json", "package-lock.json", plan.wheel.archive]) {
    if (!/^[a-f0-9]{64}$/.test(plan.files?.[name] || "")) throw new Error(`Missing installation checksum: ${name}`);
  }
  for (const artifact of [plan.python, plan.node]) {
    if (new URL(artifact.url).protocol !== "https:") throw new Error("Runtime downloads require HTTPS.");
  }
  return { ...plan, key: digest(data) };
}

export function defaultRuntimeRoot(system = false) {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA, "Cleo", "runtimes", "online");
  if (system) return process.platform === "darwin"
    ? "/Library/Application Support/Cleo/runtimes/online" : "/var/lib/cleo/runtimes/online";
  return join(process.platform === "darwin" ? join(homedir(), "Library/Application Support")
    : process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "Cleo", "runtimes", "online");
}

function ready(directory, key) {
  try {
    return JSON.parse(readFileSync(join(directory, "ready.json"))).key === key
      && existsSync(join(directory, "python", process.platform === "win32" ? "python.exe" : "bin/python3"))
      && existsSync(join(directory, "browser", process.platform === "win32" ? "node.exe" : "node"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}

export function findInstalledRuntime(resources, dataHome) {
  const plan = readRuntimePlan(resources);
  if (!plan) return resources;
  const roots = [...new Set([join(dataHome, "runtimes/online"), defaultRuntimeRoot(), defaultRuntimeRoot(true)])];
  for (const root of roots) {
    const directory = join(root, plan.key);
    if (ready(directory, plan.key)) return directory;
  }
  throw new Error("Cleo 的运行环境尚未安装。请重新运行对应系统的安装器，完成依赖下载后再打开应用。");
}

/** Install immutable runtimes outside the application bundle, then atomically mark them ready. */
export async function installRuntime({ resources, root = defaultRuntimeRoot(), signal, log = () => {} }) {
  const plan = readRuntimePlan(resources);
  if (!plan) return resources;
  root = resolve(root);
  const destination = join(root, plan.key);
  if (ready(destination, plan.key)) return destination;
  for (const [name, hash] of Object.entries(plan.files)) {
    if (!/^[\w.-]+$/.test(name) || digest(await readFile(join(resources, "runtime", name))) !== hash)
      throw new Error(`Invalid installation file: ${name}`);
  }
  await mkdir(root, { recursive: true });
  const scratch = await mkdtemp(join(root, ".install-"));
  const candidate = join(scratch, "runtime");
  const downloads = new ReleaseDownloads({ root: join(root, "downloads") });
  const cancel = () => { void downloads.close(); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    await mkdir(candidate);
    const tar = process.platform === "win32" ? join(process.env.SystemRoot, "System32/tar.exe") : "/usr/bin/tar";
    const env = { ...process.env, HOME: scratch, USERPROFILE: scratch, APPDATA: scratch,
      LOCALAPPDATA: scratch, XDG_CONFIG_HOME: scratch,
      PIP_CONFIG_FILE: process.platform === "win32" ? "NUL" : "/dev/null",
      PIP_CACHE_DIR: join(root, "pip-cache"), npm_config_cache: join(root, "npm-cache"),
      PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" };
    delete env.PYTHONHOME; delete env.PYTHONPATH; delete env.ELECTRON_RUN_AS_NODE;
    const run = (command, args, cwd = scratch) => execute(command, args,
      { cwd, env, signal, log, timeout: 900000, outputMode: "tail" });
    for (const name of ["python", "node"]) {
      log(`Downloading ${name} ${plan[name].version}…\n`);
      const artifact = { ...plan[name], platform: plan.platform };
      const archive = await downloads.get(artifact, { url: artifact.url });
      const extracted = join(scratch, name);
      await mkdir(extracted);
      await run(tar, ["-xf", archive, "-C", extracted]);
      if (name === "python") await rename(join(extracted, "python"), join(candidate, "python"));
      else {
        const [folder] = await readdir(extracted);
        const distribution = join(extracted, folder);
        await mkdir(join(candidate, "browser"));
        await cp(join(distribution, process.platform === "win32" ? "node.exe" : "bin/node"),
          join(candidate, "browser", process.platform === "win32" ? "node.exe" : "node"));
        await rename(distribution, join(scratch, "node-tools"));
      }
    }
    const python = join(candidate, "python", process.platform === "win32" ? "python.exe" : "bin/python3");
    const browser = join(candidate, "browser");
    const node = join(browser, process.platform === "win32" ? "node.exe" : "node");
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    env.PATH = [dirname(python), browser, process.env.PATH].join(process.platform === "win32" ? ";" : ":");
    log("Installing locked Python dependencies…\n");
    await run(python, ["-I", "-m", "ensurepip"]);
    await run(python, ["-I", "-m", "pip", "install", "--break-system-packages", "--disable-pip-version-check", "--require-hashes",
      "--only-binary=:all:", "--index-url", "https://pypi.org/simple", "-r", join(resources, "runtime/requirements.txt")]);
    await run(python, ["-I", "-m", "pip", "install", "--break-system-packages", "--disable-pip-version-check", "--no-deps",
      join(resources, "runtime", plan.wheel.archive)]);
    for (const name of ["package.json", "package-lock.json"])
      await cp(join(resources, "runtime", name), join(browser, name));
    const npm = join(scratch, "node-tools", process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "lib/node_modules/npm/bin/npm-cli.js");
    log("Installing locked Node dependencies…\n");
    await run(node, [npm, "ci", "--no-audit", "--no-fund", "--omit=dev"], browser);
    await cp(join(resources, "defaults"), join(candidate, "defaults"), { recursive: true });
    await cp(join(resources, "installer-check.py"), join(candidate, "installer-check.py"));
    log("Verifying the installed backend…\n");
    await run(python, ["-I", "-B", join(candidate, "installer-check.py")]);
    await writeFile(join(candidate, "ready.json"), JSON.stringify({ key: plan.key, version: plan.version }));
    signal?.throwIfAborted();
    for (let attempt = 0; ; attempt++) {
      try { await rename(candidate, destination); break; }
      catch (error) {
        if (["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code) && ready(destination, plan.key)) break;
        // Windows may briefly retain handles after runtime probes and antivirus scans.
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 40) throw error;
        await delay(250, undefined, { signal });
      }
    }
    log("Cleo runtime installation complete.\n");
    return destination;
  } finally {
    signal?.removeEventListener("abort", cancel);
    await downloads.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Installation cancelled."));
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  installRuntime({ resources: dirname(fileURLToPath(import.meta.url)),
    root: defaultRuntimeRoot(process.argv.includes("--system")), signal: controller.signal,
    log: text => process.stdout.write(text) }).catch(error => {
    console.error(`Cleo installation failed: ${error.message}`); process.exitCode = 1;
  });
}
