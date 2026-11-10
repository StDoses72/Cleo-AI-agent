import { t as tr } from "./i18n.mjs";
import { mkdir, rename, readdir, rm, access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter, dirname, win32, posix } from "node:path";
import { exists, fileHash, readJson, writeJson } from "./program-store.mjs";
import { run } from "./run-command.mjs";
import { fetchRelease, extract } from "./program-bundles.mjs";

const GITHUB = "https://api.github.com";

/** Purpose: Extend tool lookup without losing Windows' case-insensitive Path variable.
 * Input: inherited environment and tool directories. Output: a copy with one PATH key.
 */
function prependToolPaths(env, directories) {
  const result = { ...env };
  // Match Node's first-key precedence when Windows environments contain duplicate spellings.
  const keys = process.platform === "win32"
    ? Object.keys(env).filter(key => key.toLowerCase() === "path").sort() : ["PATH"];
  const inherited = env[keys[0]] || "";
  for (const key of keys) delete result[key];
  result.PATH = [...directories, inherited].filter(Boolean).join(delimiter);
  return result;
}

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
  if (!await writableGithubPath(privateDirectory)) throw new Error(tr("evolution_tools.cleo_s_github_sign_in_configuration_directory_is_not_writable"));
  await writeJson(join(root, "github-storage.json"), { private: true });
  return { ...env, GH_CONFIG_DIR: privateDirectory };
}

/** Purpose: Download only checksum-verified executable archives. Input: trusted URL, file, digest. Output: verified file. */
export async function downloadVerified(url, path, digest, { signal } = {}) {
  signal?.throwIfAborted();
  if (!/^[a-f0-9]{64}$/i.test(digest || "")) throw new Error(tr("evolution_tools.the_download_has_no_sha_256_checksum_it_was_stopped"));
  if (await exists(path) && await fileHash(path) === digest.toLowerCase()) return;
  const timeout = AbortSignal.timeout(900000);
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(tr("evolution_tools.download_failed_value", { p0: response.status }));
  await mkdir(join(path, ".."), { recursive: true });
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  const { createWriteStream } = await import("node:fs");
  const temporary = `${path}.partial`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o600 }), { signal });
    signal?.throwIfAborted();
    if (await fileHash(temporary) !== digest.toLowerCase()) throw new Error(tr("evolution_tools.download_verification_failed_download_again"));
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
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
export class ManagedTools {
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
    return { gh, env: { ...prependToolPaths(env, [dirname(gh)]), GH_PROMPT_DISABLED: "1" } };
  }

  /** Input: upstream release repo, asset pattern, executable. Output: verified managed tool path. */
  async githubTool(repository, pattern, executable, { signal } = {}) {
    const key = repository.replaceAll("/", "-");
    const marker = join(this.root, `${key}.json`);
    const saved = await readJson(marker);
    if (saved && await exists(saved.path)) return saved.path;
    this.log(tr("evolution_tools.preparing_value", { p0: repository }));
    const release = await fetchRelease(`${GITHUB}/repos/${repository}/releases/latest`, true, { signal });
    const asset = release.assets.find((item) => pattern.test(item.name));
    if (!asset) throw new Error(tr("evolution_tools.no_value_package_is_available_for_this_computer", { p0: repository }));
    const directory = join(this.root, key, release.tag_name.replace(/[^a-zA-Z0-9.-]/g, "_"));
    const archive = join(directory, asset.name);
    await downloadVerified(asset.browser_download_url, archive, asset.digest?.replace(/^sha256:/, ""), { signal });
    await extract(archive, join(directory, "tool"), { signal });
    const path = await findTool(join(directory, "tool"), executable);
    if (!path) throw new Error(tr("evolution_tools.the_installation_package_is_missing_value", { p0: executable }));
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
    if (!version) throw new Error(tr("evolution_tools.no_suitable_node_js_lts_version_was_found_for_this_computer"));
    this.log(tr("evolution_tools.preparing_node_js_value", { p0: version }));
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
      if (process.platform !== "win32") throw new Error(tr("evolution_tools.git_is_not_installed_install_system_git_and_retry"));
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
    const env = { ...prependToolPaths(github.env, [dirname(node), dirname(git), dirname(uv), dirname(gh)]),
      GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GH_PROMPT_DISABLED: "1" };
    return { node, npm, git, uv, gh, env };
  }
}
