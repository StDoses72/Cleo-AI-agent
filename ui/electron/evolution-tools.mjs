import { spawn } from "node:child_process";
import { mkdir, rename, readdir } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { exists, fileHash, readJson, writeJson } from "./evolution-store.mjs";

const GITHUB = "https://api.github.com";

/** Purpose: Run an argument array without a shell. Input: executable, args, process options. Output: bounded output. */
export async function run(command, args, { cwd, env = process.env, log = () => {}, timeout = 1_800_000, successCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    let oversized = false;
    const collect = (chunk) => {
      const text = chunk.toString();
      if (output.length + text.length > 16 * 1024 * 1024) oversized = true;
      else output += text;
      log(text);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill(); }
      }
    }, timeout);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) { reject(new Error("操作超时，已停止进程。请检查日志后重试。")); return; }
      if (oversized) { reject(new Error("操作输出超过限制，已停止使用不完整的结果。")); return; }
      if (!successCodes.includes(code)) reject(new Error(`${command.split(/[\\/]/).at(-1)} 执行失败 (${code})\n${output.slice(-3000)}`));
      else resolve(output.trim());
    });
  });
}

/** Purpose: Fetch metadata from public release services. Input: HTTPS URL. Output: JSON or text. */
export async function fetchRelease(url, json = true) {
  const response = await fetch(url, { headers: { "User-Agent": "Cleo-Evolution" }, signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`下载失败 (${response.status})，请检查网络后重试。`);
  return json ? response.json() : response.text();
}

/** Purpose: Download only checksum-verified executable archives. Input: trusted URL, file, digest. Output: verified file. */
export async function downloadVerified(url, path, digest) {
  if (!/^[a-f0-9]{64}$/i.test(digest || "")) throw new Error("下载缺少 SHA-256 校验值，已停止。");
  if (await exists(path) && await fileHash(path) === digest.toLowerCase()) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(900000) });
  if (!response.ok) throw new Error(`下载失败 (${response.status})。`);
  await mkdir(join(path, ".."), { recursive: true });
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  const { createWriteStream } = await import("node:fs");
  const temporary = `${path}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o600 }));
  if (await fileHash(temporary) !== digest.toLowerCase()) throw new Error("下载校验失败，请重新下载。");
  await rename(temporary, path);
}

/** Purpose: Unpack a verified release archive. Input: archive and new destination. Output: extracted tree. */
export async function extract(archive, destination) {
  await mkdir(destination, { recursive: true });
  if (process.platform === "win32" && archive.endsWith(".zip")) {
    // Environment values avoid interpreting paths as PowerShell source code.
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Expand-Archive -LiteralPath $env:CLEO_ARCHIVE -DestinationPath $env:CLEO_EXTRACT -Force"], {
      env: { ...process.env, CLEO_ARCHIVE: archive, CLEO_EXTRACT: destination },
    });
  } else if (process.platform === "darwin" && archive.endsWith(".zip")) await run("ditto", ["-x", "-k", archive, destination]);
  else if (archive.endsWith(".zip")) await run("unzip", ["-q", archive, "-d", destination]);
  else await run("tar", ["-xf", archive, "-C", destination]);
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

  /** Input: upstream release repo, asset pattern, executable. Output: verified managed tool path. */
  async githubTool(repository, pattern, executable) {
    const key = repository.replaceAll("/", "-");
    const marker = join(this.root, `${key}.json`);
    const saved = await readJson(marker);
    if (saved && await exists(saved.path)) return saved.path;
    this.log(`正在准备 ${repository}…\n`);
    const release = await fetchRelease(`${GITHUB}/repos/${repository}/releases/latest`);
    const asset = release.assets.find((item) => pattern.test(item.name));
    if (!asset) throw new Error(`找不到适用于本机的 ${repository} 安装包。`);
    const directory = join(this.root, key, release.tag_name.replace(/[^a-zA-Z0-9.-]/g, "_"));
    const archive = join(directory, asset.name);
    await downloadVerified(asset.browser_download_url, archive, asset.digest?.replace(/^sha256:/, ""));
    await extract(archive, join(directory, "tool"));
    const path = await findTool(join(directory, "tool"), executable);
    if (!path) throw new Error(`安装包缺少 ${executable}。`);
    await writeJson(marker, { path });
    return path;
  }

  /** Input: none. Output: Node and npm from a pinned managed LTS distribution. */
  async node() {
    const marker = join(this.root, "node.json");
    const saved = await readJson(marker);
    if (saved && await exists(saved.node) && await exists(saved.npm)) return saved;
    const platform = process.platform === "win32" ? "win" : process.platform;
    const archiveType = platform === "win" ? "zip" : "tar.gz";
    const releases = await fetchRelease("https://nodejs.org/dist/index.json");
    const version = releases.find((item) => item.lts && item.files.includes(`${platform}-${process.arch}${platform === "win" ? "-zip" : ""}`))?.version;
    if (!version) throw new Error("找不到本机适用的 Node.js LTS。");
    this.log(`正在准备 Node.js ${version}…\n`);
    const name = `node-${version}-${platform}-${process.arch}`;
    const directory = join(this.root, name);
    const archive = join(this.root, `${name}.${archiveType}`);
    const sums = await fetchRelease(`https://nodejs.org/dist/${version}/SHASUMS256.txt`, false);
    const digest = sums.split("\n").find((line) => line.trim().endsWith(` ${name}.${archiveType}`))?.split(/\s+/)[0];
    await downloadVerified(`https://nodejs.org/dist/${version}/${name}.${archiveType}`, archive, digest);
    await extract(archive, this.root);
    const node = join(directory, platform === "win" ? "node.exe" : "bin/node");
    const npm = join(directory, platform === "win" ? "node_modules/npm/bin/npm-cli.js" : "lib/node_modules/npm/bin/npm-cli.js");
    await writeJson(marker, { node, npm });
    return { node, npm };
  }

  /** Input: GitHub CLI requirement. Output: command paths and process-local PATH. */
  async prepare(withGithub = false) {
    await mkdir(this.root, { recursive: true });
    const { node, npm } = await this.node();
    let git = "git";
    try { await run(git, ["--version"]); }
    catch {
      if (process.platform !== "win32") throw new Error("本机缺少 Git；请安装系统 Git 后重试。");
      git = await this.githubTool("git-for-windows/git", /^MinGit-.*-64-bit\.zip$/, "git.exe");
    }
    let uv = "uv";
    try { await run(uv, ["--version"]); }
    catch {
      const target = process.platform === "win32" ? "x86_64-pc-windows-msvc.zip"
        : `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu"}.tar.gz`;
      uv = await this.githubTool("astral-sh/uv", new RegExp(`^uv-${target.replaceAll(".", "\\.")}$`), process.platform === "win32" ? "uv.exe" : "uv");
    }
    let gh = "gh";
    if (withGithub) {
      try { await run(gh, ["--version"]); }
      catch {
        const target = process.platform === "win32" ? "windows_amd64.zip"
          : `${process.platform === "darwin" ? "macOS" : "linux"}_${process.arch === "arm64" ? "arm64" : "amd64"}.${process.platform === "darwin" ? "zip" : "tar.gz"}`;
        gh = await this.githubTool("cli/cli", new RegExp(`_${target.replaceAll(".", "\\.")}$`), process.platform === "win32" ? "gh.exe" : "gh");
      }
    }
    const { dirname } = await import("node:path");
    const env = { ...process.env, PATH: [dirname(node), dirname(git), dirname(uv), dirname(gh), process.env.PATH].join(delimiter),
      GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GH_PROMPT_DISABLED: "1" };
    return { node, npm, git, uv, gh, env };
  }
}
