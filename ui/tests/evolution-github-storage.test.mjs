import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, chmod, readFile, rm, writeFile, copyFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tools from "../electron/evolution-tools.mjs";
import { spawnSync } from "node:child_process";

test("Windows login and build tools retain a mixed-case Path when spawning real executables", {
  skip: process.platform !== "win32",
}, async t => {
  const { root } = await fixture(t);
  const bin = join(root, "bin");
  await mkdir(bin);
  await copyFile(process.execPath, join(bin, "gh.exe"));
  for (const name of ["git.exe", "uv.exe"]) await link(join(bin, "gh.exe"), join(bin, name));
  const env = { ...process.env, GH_CONFIG_DIR: join(root, "config") };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.Path = bin;
  const moduleUrl = new URL("../electron/evolution-tools.mjs", import.meta.url).href;
  const probe = `
    import assert from 'node:assert/strict';
    import { EvolutionTools, run } from ${JSON.stringify(moduleUrl)};
    const tools = new EvolutionTools(${JSON.stringify(join(root, "tools"))});
    tools.node = async () => ({ node: process.execPath, npm: 'unused' });
    tools.githubTool = async () => { throw new Error('Unexpected download'); };
    for (const prepared of [await tools.prepareGithub(), await tools.prepare(true), await tools.prepare(false)]) {
      assert.equal(await run(prepared.gh, ['--version'], { env: prepared.env }), process.version);
      assert.equal(Object.keys(prepared.env).filter(key => key.toLowerCase() === 'path').length, 1);
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cleo-gh-storage-"));
  const home = join(root, "home");
  await mkdir(join(home, ".config"), { recursive: true });
  t.after(async () => {
    await chmod(join(home, ".config"), 0o700);
    await rm(root, { recursive: true, force: true });
  });
  return { root, home };
}

test("an unwritable default config parent uses a durable Cleo-owned directory", async t => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("POSIX permission fixture");
  const { root, home } = await fixture(t);
  await chmod(join(home, ".config"), 0o500);
  const env = await tools.githubEnvironment(join(root, "tools"), { env: {}, userHome: home });
  assert.equal(env.GH_CONFIG_DIR, join(root, "tools", "github-config"));
  await writeFile(join(env.GH_CONFIG_DIR, "hosts.yml"), "test-only config", { mode: 0o600 });
  // A later directory permission repair must not silently switch accounts/storage.
  await chmod(join(home, ".config"), 0o700);
  const next = await tools.githubEnvironment(join(root, "tools"), { env: {}, userHome: home });
  assert.equal(next.GH_CONFIG_DIR, env.GH_CONFIG_DIR);
  assert.equal(await readFile(join(next.GH_CONFIG_DIR, "hosts.yml"), "utf8"), "test-only config");
});

test("a writable existing GitHub configuration and token environment remain unchanged", async t => {
  const { root, home } = await fixture(t);
  const config = join(home, ".config", "gh");
  await mkdir(config);
  await writeFile(join(config, "config.yml"), "browser: test-browser\n");
  const original = { GH_CONFIG_DIR: config, GH_TOKEN: "test-only-token", OTHER: "unchanged" };
  const env = await tools.githubEnvironment(join(root, "tools"), { env: original, userHome: home });
  assert.equal(env.GH_CONFIG_DIR, config);
  assert.equal(env.GH_TOKEN, "test-only-token");
  assert.equal(original.OTHER, "unchanged");
  assert.equal(await readFile(join(config, "config.yml"), "utf8"), "browser: test-browser\n");
});

test("Windows and XDG path selection follows GitHub CLI precedence", () => {
  assert.equal(tools.githubConfigDirectory({ AppData: "C:\\Users\\Tester\\AppData\\Roaming" }, "win32", "C:\\Users\\Tester"),
    "C:\\Users\\Tester\\AppData\\Roaming\\GitHub CLI");
  assert.equal(tools.githubConfigDirectory({ XDG_CONFIG_HOME: "/xdg" }, "darwin", "/home/test"), "/xdg/gh");
  assert.equal(tools.githubConfigDirectory({ GH_CONFIG_DIR: "/explicit", XDG_CONFIG_HOME: "/xdg" }, "darwin", "/home/test"), "/explicit");
});

test("login tooling does not require Node, Python, or Git", async t => {
  const { root } = await fixture(t);
  const manager = new tools.EvolutionTools(join(root, "tools"));
  manager.node = async () => { throw new Error("Node must not be prepared for login"); };
  manager.githubTool = async () => process.execPath;
  const prepared = await manager.prepareGithub();
  assert.ok(prepared.gh);
  assert.equal(prepared.env.GH_PROMPT_DISABLED, "1");
});

test("real gh cannot save to a read-only parent, then succeeds with Cleo storage", async t => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("POSIX permission fixture");
  const gh = process.env.CLEO_TEST_GH || "gh";
  if (spawnSync(gh, ["--version"]).status !== 0) return t.skip("Optional real GitHub CLI fixture");
  const { root, home } = await fixture(t);
  await chmod(join(home, ".config"), 0o500);
  const original = { ...process.env, GH_CONFIG_DIR: join(home, ".config", "gh") };
  const run = env => spawnSync(gh, ["config", "set", "git_protocol", "https"], { env, encoding: "utf8", timeout: 10000 });
  const before = run(original);
  assert.notEqual(before.status, 0);
  assert.match(before.stderr, /permission denied/i);
  const env = await tools.githubEnvironment(join(root, "tools"), { env: original, userHome: home });
  const after = run(env);
  assert.equal(after.status, 0);
  assert.match(await readFile(join(env.GH_CONFIG_DIR, "config.yml"), "utf8"), /git_protocol: https/);
});
