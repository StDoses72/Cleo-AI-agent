import { createHash } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { desktopPlatform } from "./platform.mjs";

const run = promisify(execFile);

export function validateInstallRequest(value, platform = process.platform, arch = process.arch) {
  if (!["darwin", "linux"].includes(platform)) throw new Error("POSIX installer requires macOS or Linux.");
  const target = desktopPlatform(platform, arch);
  if (value.platform !== target.id || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value.version)
      || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes <= 0
      || !Number.isInteger(value.parentPid) || value.parentPid <= 0) {
    throw new Error("Invalid update request.");
  }
  for (const key of ["archive", "installRoot", "resultPath"]) {
    if (typeof value[key] !== "string" || !isAbsolute(value[key])) throw new Error(`Invalid ${key}.`);
  }
  const root = resolve(value.installRoot);
  if (root === dirname(root) || root === homedir()
      || (platform === "darwin" && !root.endsWith(".app"))) throw new Error("Unsafe installation root.");
  return target;
}

function metadataPath(root, target) {
  return target.platform === "darwin" ? join(root, target.resources, "release.json") : join(root, "release.json");
}

async function validateLinks(root, directory = root) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const link = await readlink(path);
      const rel = relative(root, resolve(directory, link));
      if (isAbsolute(link) || rel === ".." || rel.startsWith("../")) throw new Error("Package symlink escapes the application.");
    } else if (entry.isDirectory()) await validateLinks(root, path);
  }
}

async function parentExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

export async function installUpdate(request, {
  platform = process.platform, arch = process.arch,
  ready = async () => {}, waitForParent = async (pid) => {
    const deadline = Date.now() + 120_000;
    while (await parentExists(pid)) {
      if (Date.now() >= deadline) throw new Error("Cleo did not exit; the update was not installed.");
      await new Promise((done) => setTimeout(done, 100));
    }
  }, launch = (executable, cwd) => new Promise((done, reject) => {
    const child = spawn(executable, [], { cwd, detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); done(); });
  }),
} = {}) {
  const target = validateInstallRequest(request, platform, arch);
  const parent = dirname(request.installRoot);
  let staging;
  let backup;
  let promoted = false;
  const result = async (status, error = null) => {
    await mkdir(dirname(request.resultPath), { recursive: true });
    const temporary = `${request.resultPath}.tmp`;
    await writeFile(temporary, JSON.stringify({ status, version: request.version, error }));
    await rename(temporary, request.resultPath);
  };
  try {
    await access(parent, constants.W_OK);
    const current = JSON.parse(await readFile(metadataPath(request.installRoot, target), "utf8"));
    if (current.app !== "Cleo" || current.platform !== target.id) throw new Error("Not a matching Cleo installation.");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(request.archive)) { hash.update(chunk); bytes += chunk.length; }
    if (bytes !== request.bytes || hash.digest("hex") !== request.sha256) throw new Error("Update checksum or size mismatch.");
    staging = await mkdtemp(join(parent, ".cleo-update-"));
    const extract = join(staging, "extract");
    await mkdir(extract);
    const listing = await run("tar", ["-tf", request.archive], { maxBuffer: 16 * 1024 * 1024 });
    if (listing.stdout.split("\n").some((name) => name.startsWith("/") || name.split("/").includes(".."))) {
      throw new Error("Unsafe archive entry.");
    }
    if (platform === "darwin") await run("ditto", ["-x", "-k", request.archive, extract]);
    else await run("tar", ["-xzf", request.archive, "-C", extract, "--no-same-owner"]);
    const replacement = join(extract, target.bundle);
    if (!(await lstat(replacement)).isDirectory()) throw new Error("Missing application directory.");
    await validateLinks(replacement);
    const metadata = JSON.parse(await readFile(metadataPath(replacement, target), "utf8"));
    if (metadata.app !== "Cleo" || metadata.platform !== target.id || metadata.version !== request.version) {
      throw new Error("The package version or platform does not match the update.");
    }
    await access(join(replacement, target.executable), constants.X_OK);
    if (platform === "darwin") await run("codesign", ["--verify", "--deep", "--strict", replacement]);
    await ready();
    await waitForParent(request.parentPid);
    backup = join(staging, "previous");
    await rename(request.installRoot, backup);
    try {
      await rename(replacement, request.installRoot);
      promoted = true;
    } catch (error) {
      await rename(backup, request.installRoot);
      backup = null;
      throw error;
    }
    await result("installed");
    await launch(join(request.installRoot, target.executable), request.installRoot);
  } catch (error) {
    await result("failed", `${promoted ? "New version installed, but launch failed: " : ""}${error.message}`);
    throw error;
  } finally {
    // Only remove our staging area when no previous installation needs recovery.
    if (staging && (!backup || promoted)) await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let announced = false;
  try {
    const request = JSON.parse(await readFile(process.argv[2], "utf8"));
    await installUpdate(request, { ready: () => new Promise((done, reject) => {
      process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`, (error) => {
        if (error) reject(error); else { announced = true; done(); }
      });
    }) });
  } catch (error) {
    if (!announced) process.stdout.write(`${JSON.stringify({ type: "error", error: error.message })}\n`);
    console.error(error.message);
    process.exitCode = 1;
  }
}
