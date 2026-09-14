import { spawnSync } from "node:child_process";
import { cp, mkdir, writeFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = process.argv[2];
if (!destination) throw new Error("Usage: node bundle-evolution-source.mjs <resources>");
const scratch = await mkdtemp(join(tmpdir(), "cleo-source-"));

/** Purpose: Capture build source without credentials or runtime data. Input: Git arguments. Output: source paths. */
function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || "Cannot read build source.");
  return result.stdout;
}

try {
  const files = [...new Set(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))];
  const copied = [];
  const deleted = [];
  for (const name of files) {
    if (/^(data\/|release\/|\.local-preview-|\.env|config\/(cleo|harnesses)\.json$|memory\/(non_productivity|productivity|sessions\.sqlite|persona\.sqlite))/.test(name)) continue;
    if (/[\r\n]/.test(name) || name.split("/").includes("..")) throw new Error("Invalid source path.");
    const source = resolve(root, name);
    if (relative(root, source).startsWith("..")) throw new Error("Source escapes repository.");
    let info;
    try { info = await lstat(source); } catch (error) { if (error.code === "ENOENT") { deleted.push(name); continue; } throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Evolution source must contain regular files: " + name);
    const target = join(scratch, name);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
    copied.push(name);
  }
  await writeFile(join(scratch, "evolution-source.json"), JSON.stringify({
    schema: 1, commit: git(["rev-parse", "HEAD"]).trim(), files: copied, deleted,
  }));
  await mkdir(destination, { recursive: true });
  const result = spawnSync("tar", ["-c", "-z", "-f", join(resolve(destination), "evolution-source.tar.gz"), "-C", scratch, "."],
    { stdio: "inherit", windowsHide: true });
  if (result.status !== 0) throw new Error("Cannot bundle evolution source.");
} finally {
  const parent = resolve(tmpdir());
  if (dirname(resolve(scratch)) !== parent || !scratch.includes("cleo-source-")) throw new Error("Invalid temporary source directory.");
  await rm(scratch, { recursive: true, force: true });
}
