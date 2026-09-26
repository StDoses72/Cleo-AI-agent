import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { EvolutionManager } from "../electron/evolution.mjs";
import { run } from "../electron/evolution-tools.mjs";

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "cleo-command-output-"));
  context.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.includes("cleo-command-output-"));
    await rm(root, { recursive: true, force: true });
  });
  const manager = new EvolutionManager({ app: { isPackaged: false },
    root: join(root, "control"), dataHome: join(root, "home") });
  await mkdir(manager.source, { recursive: true });
  return { root, manager };
}

for (const warningFirst of [true, false]) {
  test(`successful metadata separates diagnostics (${warningFirst ? "warning first" : "warning last"})`, async () => {
    const statements = ["process.stderr.write('warning: diagnostic only\\n')", "process.stdout.write('{\"ready\":true}\\n')"];
    if (!warningFirst) statements.reverse();
    const logs = [];
    const output = await run(process.execPath, ["-e", statements.join(";")], { log: (text) => logs.push(text) });
    assert.deepEqual(JSON.parse(output), { ready: true });
    assert.match(logs.join(""), /warning: diagnostic only/);
  });
}

test("strict metadata rejects incomplete enumeration diagnostics even with a successful exit", async () => {
  const command = "process.stderr.write('warning: cannot read source directory\\n'); process.stdout.write('feature.txt\\0');";
  await assert.rejects(run(process.execPath, ["-e", command], { rejectStderr: true }), /cannot read source directory/);
});

test("raw metadata preserves leading filename spaces and NUL delimiters", async () => {
  const output = await run(process.execPath, ["-e", "process.stdout.write(' feature.txt\\0');"], { trimOutput: false });
  assert.equal(output, " feature.txt\0");
});

test("the real source fingerprint preserves a filename beginning with a space", async (context) => {
  const { manager } = await fixture(context);
  await run("git", ["init", "--initial-branch", "test"], { cwd: manager.source });
  await writeFile(join(manager.source, " feature.txt"), "source bytes");
  const expected = createHash("sha256").update(" feature.txt")
    .update(createHash("sha256").update("source bytes").digest("hex")).digest("hex");
  assert.equal(await manager.sourceHash({ git: "git", env: process.env }), expected);
});

test("the real source fingerprint reports stderr instead of hashing warning text", async (context) => {
  const { root, manager } = await fixture(context);
  await writeFile(join(manager.source, "feature.txt"), "source bytes");
  const hook = join(root, "git-output.cjs");
  await writeFile(hook, "const fs = require('node:fs'); fs.writeSync(2, 'warning: source listing incomplete\\n'); fs.writeSync(1, 'feature.txt\\0'); process.exit(0);");
  await assert.rejects(manager.sourceHash({ git: process.execPath,
    env: { ...process.env, NODE_OPTIONS: `--require="${hook.replaceAll("\\", "/")}"` } }), /命令返回诊断[\s\S]*source listing incomplete/);
});

test("repository test caches stay out of source enumeration while real tests remain", async (context) => {
  const { manager } = await fixture(context);
  await run("git", ["init", "--initial-branch", "test"], { cwd: manager.source });
  await writeFile(join(manager.source, ".gitignore"), await readFile(new URL("../../.gitignore", import.meta.url)));
  for (const directory of ["tests/.tmp-noncodex-red", "tests/.diagnostic-deps"]) {
    await mkdir(join(manager.source, directory), { recursive: true });
    await writeFile(join(manager.source, directory, "generated.txt"), "temporary output");
  }
  await writeFile(join(manager.source, "tests/test_real.py"), "assert True\n");
  const files = await run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: manager.source });
  assert.deepEqual(files.split("\0").filter(Boolean), [".gitignore", "tests/test_real.py"]);
});
