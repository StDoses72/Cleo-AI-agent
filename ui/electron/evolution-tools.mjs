import { spawn } from "node:child_process";
import { mkdir, rename, readdir, rm, open, access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter, dirname, win32, posix } from "node:path";
import { exists, fileHash, readJson, writeJson } from "./evolution-store.mjs";

const GITHUB = "https://api.github.com";

/** Follow gh's configuration precedence without reading or copying credentials. */
export function githubConfigDirectory(env, platform = process.platform, userHome = homedir()) {
  const paths = platform === "win32" ? win32 : posix;
  return env.GH_CONFIG_DIR || (env.XDG_CONFIG_HOME ? paths.join(env.XDG_CONFIG_HOME, "gh")
    : platform === "win32" && (env.AppData || env.APPDATA)
      ? paths.join(env.AppData || env.APPDATA, "GitHub CLI") : paths.join(userHome, ".config", "gh"));
}

async function writableGithubPath(path) {
  try { await access(path, constants.W_OK); return true; }
  catch (error) {
    if (error.code === "ENOENT" && dirname(path) !== path) return writableGithubPath(dirname(path));
    if (["EACCES", "EPERM", "EROFS", "ENOTDIR"].includes(error.code)) return false;
    throw error;
  }
}

/** Use existing writable configuration; otherwise select durable private storage.
 * The marker stores only the storage choice, never tokens or device codes.
 */
export async function githubEnvironment(root, { env = process.env, userHome = homedir() } = {}) {
  const selected = await readJson(join(root, "github-storage.json"));
  const directory = githubConfigDirectory(env, process.platform, userHome);
  if (selected?.private !== true && await writableGithubPath(directory)
    && await writableGithubPath(join(directory, "hosts.yml"))
    && await writableGithubPath(join(directory, "config.yml"))) return { ...env };
  const privateDirectory = join(root, "github-config");
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  if (!await writableGithubPath(privateDirectory)) throw new Error("Cleo GitHub 登录配置目录不可写。");
  await writeJson(join(root, "github-storage.json"), { private: true });
  return { ...env, GH_CONFIG_DIR: privateDirectory };
}

/** Purpose: Run an argument array without a shell. Input: executable, args, process options. Output: stdout or a bounded diagnostic tail. */
export async function run(command, args, { cwd, env = process.env, log = () => {}, timeout = 1_800_000, successCodes = [0], signal, outputMode = "capture", stdin = "ignore", trimOutput = true, rejectStderr = false } = {}) {
  signal?.throwIfAborted();
  if (!["capture", "tail"].includes(outputMode)) throw new Error(`Unknown command output mode: ${outputMode}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", windowsHide: true, stdio: [stdin, "pipe", "pipe"] });
    let output = "";
    let tail = "";
    let stderrTail = "";
    let timedOut = false;
    let oversized = false;
    const collect = (chunk, isStdout) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-64 * 1024);
      if (!isStdout) stderrTail = (stderrTail + text).slice(-64 * 1024);
      // Metadata must be complete; installation diagnostics only need a bounded tail.
      if (isStdout && outputMode === "capture" && !oversized) {
        if (output.length + text.length > 16 * 1024 * 1024) { oversized = true; output = ""; }
        else output += text;
      }
      log(text);
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => collect(chunk, true));
    child.stderr.setEncoding("utf8").on("data", (chunk) => collect(chunk, false));
    // Both cancellation and timeout stop descendants before releasing the operation.
    const stop = () => {
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill(); }
      }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    signal?.addEventListener("abort", stop, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (code) => {
      cleanup();
      if (signal?.aborted) { reject(signal.reason); return; }
      if (timedOut) { reject(new Error("操作超时，已停止进程。请检查日志后重试。")); return; }
      if (!successCodes.includes(code)) { reject(new Error(`${command.split(/[\\/]/).at(-1)} 执行失败 (${code})\n${tail.slice(-3000)}`)); return; }
      if (oversized) { reject(new Error("操作输出超过限制，已停止使用不完整的结果。")); return; }
      if (rejectStderr && stderrTail) { reject(new Error(`命令返回诊断，无法确认输出完整。请检查源码读取权限或排除临时文件后重试。\n${stderrTail.slice(-3000)}`)); return; }
      const result = outputMode === "tail" ? tail : output;
      resolve(trimOutput ? result.trim() : result);
    });
  });
}

/** Purpose: Fetch metadata from public release services. Input: HTTPS URL. Output: JSON or text. */
export async function fetchRelease(url, json = true, { signal } = {}) {
  const timeout = AbortSignal.timeout(120000);
  const response = await fetch(url, { headers: { "User-Agent": "Cleo-Evolution" }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`下载失败 (${response.status})，请检查网络后重试。`);
  return json ? response.json() : response.text();
}

/** Purpose: Download only checksum-verified executable archives. Input: trusted URL, file, digest. Output: verified file. */
export async function downloadVerified(url, path, digest, { signal } = {}) {
  signal?.throwIfAborted();
  if (!/^[a-f0-9]{64}$/i.test(digest || "")) throw new Error("下载缺少 SHA-256 校验值，已停止。");
  if (await exists(path) && await fileHash(path) === digest.toLowerCase()) return;
  const timeout = AbortSignal.timeout(900000);
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`下载失败 (${response.status})。`);
  await mkdir(join(path, ".."), { recursive: true });
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  const { createWriteStream } = await import("node:fs");
  const temporary = `${path}.partial`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o600 }), { signal });
    signal?.throwIfAborted();
    if (await fileHash(temporary) !== digest.toLowerCase()) throw new Error("下载校验失败，请重新下载。");
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** Purpose: Unpack a verified release archive. Input: archive and new destination. Output: extracted tree. */
export async function extract(archive, destination, { signal, log = () => {} } = {}) {
  signal?.throwIfAborted();
  await mkdir(destination, { recursive: true });
  const options = { outputMode: "tail", log, signal };
  if (process.platform === "win32" && archive.endsWith(".zip")) {
    // Keep long-path support without passing Unicode paths through tar's ANSI argv.
    // Node opens the archive and sets the working directory using Windows Unicode APIs.
    const tar = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    const input = await open(archive, "r");
    try { await run(tar, ["-xf", "-"], { ...options, cwd: destination, stdin: input.fd }); }
    finally { await input.close(); }
  } else if (process.platform === "darwin" && archive.endsWith(".zip")) await run("ditto", ["-x", "-k", archive, destination], options);
  else if (archive.endsWith(".zip")) await run("unzip", ["-q", archive, "-d", destination], options);
  else await run("tar", ["-xf", archive, "-C", destination], options);
}

/** Purpose: Find an executable inside an extracted trusted tool. Input: root/name. Output: path or null. */
async function findTool(root, name) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) { const found = await findTool(path, name); if (found) return found; }
  }
  return null;
}

/** Purpose: Provision private build tools without changing global installations. */
export class EvolutionTools {
  constructor(root, log = () => {}) { this.root = root; this.log = log; }

  /** GitHub login is independent of build prerequisites and never needs a terminal. */
  async prepareGithub({ signal, managed = false } = {}) {
    signal?.throwIfAborted();
    await mkdir(this.root, { recursive: true });
    let gh = "gh";
    try {
      if (managed) throw new Error("Use managed CLI");
      await run(gh, ["--version"], { signal, timeout: 10000 });
    } catch {
      signal?.throwIfAborted();
      const target = process.platform === "win32" ? "windows_amd64.zip"
        : `${process.platform === "darwin" ? "macOS" : "linux"}_${process.arch === "arm64" ? "arm64" : "amd64"}.${process.platform === "darwin" ? "zip" : "tar.gz"}`;
      gh = await this.githubTool("cli/cli", new RegExp(`_${target.replaceAll(".", "\\.")}$`), process.platform === "win32" ? "gh.exe" : "gh", { signal });
    }
    const env = await githubEnvironment(this.root);
    return { gh, env: { ...env, PATH: [dirname(gh), env.PATH].filter(Boolean).join(delimiter), GH_PROMPT_DISABLED: "1" } };
  }

  /** Input: upstream release repo, asset pattern, executable. Output: verified managed tool path. */
  async githubTool(repository, pattern, executable, { signal } = {}) {
    const key = repository.replaceAll("/", "-");
    const marker = join(this.root, `${key}.json`);
    const saved = await readJson(marker);
    if (saved && await exists(saved.path)) return saved.path;
    this.log(`正在准备 ${repository}…\n`);
    const release = await fetchRelease(`${GITHUB}/repos/${repository}/releases/latest`, true, { signal });
    const asset = release.assets.find((item) => pattern.test(item.name));
    if (!asset) throw new Error(`找不到适用于本机的 ${repository} 安装包。`);
    const directory = join(this.root, key, release.tag_name.replace(/[^a-zA-Z0-9.-]/g, "_"));
    const archive = join(directory, asset.name);
    await downloadVerified(asset.browser_download_url, archive, asset.digest?.replace(/^sha256:/, ""), { signal });
    await extract(archive, join(directory, "tool"), { signal });
    const path = await findTool(join(directory, "tool"), executable);
    if (!path) throw new Error(`安装包缺少 ${executable}。`);
    await writeJson(marker, { path });
    return path;
  }

  /** Input: none. Output: Node and npm from a pinned managed LTS distribution. */
  async node({ signal } = {}) {
    const marker = join(this.root, "node.json");
    const saved = await readJson(marker);
    if (saved && await exists(saved.node) && await exists(saved.npm)) return saved;
    const platform = process.platform === "win32" ? "win" : process.platform;
    const archiveType = platform === "win" ? "zip" : "tar.gz";
    const releaseFile = platform === "darwin" ? `osx-${process.arch}-tar`
      : `${platform}-${process.arch}${platform === "win" ? "-zip" : ""}`;
    const releases = await fetchRelease("https://nodejs.org/dist/index.json", true, { signal });
    const version = releases.find((item) => item.lts && item.files.includes(releaseFile))?.version;
    if (!version) throw new Error("找不到本机适用的 Node.js LTS。");
    this.log(`正在准备 Node.js ${version}…\n`);
    const name = `node-${version}-${platform}-${process.arch}`;
    const directory = join(this.root, name);
    const archive = join(this.root, `${name}.${archiveType}`);
    const sums = await fetchRelease(`https://nodejs.org/dist/${version}/SHASUMS256.txt`, false, { signal });
    const digest = sums.split("\n").find((line) => line.trim().endsWith(` ${name}.${archiveType}`))?.split(/\s+/)[0];
    await downloadVerified(`https://nodejs.org/dist/${version}/${name}.${archiveType}`, archive, digest, { signal });
    await extract(archive, this.root, { signal });
    const node = join(directory, platform === "win" ? "node.exe" : "bin/node");
    const npm = join(directory, platform === "win" ? "node_modules/npm/bin/npm-cli.js" : "lib/node_modules/npm/bin/npm-cli.js");
    await writeJson(marker, { node, npm });
    return { node, npm };
  }

  /** Input: GitHub CLI requirement. Output: command paths and process-local PATH. */
  async prepare(withGithub = false, { signal } = {}) {
    signal?.throwIfAborted();
    await mkdir(this.root, { recursive: true });
    const { node, npm } = await this.node({ signal });
    let git = "git";
    try { await run(git, ["--version"], { signal }); }
    catch {
      signal?.throwIfAborted();
      if (process.platform !== "win32") throw new Error("本机缺少 Git；请安装系统 Git 后重试。");
      git = await this.githubTool("git-for-windows/git", /^MinGit-.*-64-bit\.zip$/, "git.exe", { signal });
    }
    let uv = "uv";
    try { await run(uv, ["--version"], { signal }); }
    catch {
      signal?.throwIfAborted();
      const target = process.platform === "win32" ? "x86_64-pc-windows-msvc.zip"
        : `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu"}.tar.gz`;
      uv = await this.githubTool("astral-sh/uv", new RegExp(`^uv-${target.replaceAll(".", "\\.")}$`), process.platform === "win32" ? "uv.exe" : "uv", { signal });
    }
    const github = withGithub ? await this.prepareGithub({ signal }) : { gh: "gh", env: process.env };
    const gh = github.gh;
    const env = { ...github.env, PATH: [dirname(node), dirname(git), dirname(uv), dirname(gh), github.env.PATH].join(delimiter),
      GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GH_PROMPT_DISABLED: "1" };
    return { node, npm, git, uv, gh, env };
  }
}
