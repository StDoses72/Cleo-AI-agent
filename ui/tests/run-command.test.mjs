import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { run } from "../electron/run-command.mjs";

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

test("metadata command output is not silently truncated at 32 KB", async () => {
  const output = await run(process.execPath, ["-e", "process.stdout.write('x'.repeat(64000))"]);
  assert.equal(output.length, 64000);
});

test("timed out child commands cannot report success", async () => {
  await assert.rejects(run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 100 }), /超时/);
});

test("an aborted command stops its process and reports the caller's reason", async () => {
  const controller = new AbortController();
  let started;
  const ready = new Promise(done => { started = done; });
  const running = run(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
    { signal: controller.signal, log: () => started() });
  const rejected = assert.rejects(running, /stopped by the test/);
  await ready;
  controller.abort(new Error("stopped by the test"));
  await rejected;
});

test("repository test caches stay out of source enumeration while real tests remain", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cleo-command-output-"));
  context.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  await run("git", ["init", "--initial-branch", "test"], { cwd: root });
  await writeFile(join(root, ".gitignore"), await readFile(new URL("../../.gitignore", import.meta.url)));
  for (const directory of ["tests/.tmp-noncodex-red", "tests/.diagnostic-deps"]) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, "generated.txt"), "temporary output");
  }
  await writeFile(join(root, "tests/test_real.py"), "assert True\n");
  const files = await run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root });
  assert.deepEqual(files.split("\0").filter(Boolean), [".gitignore", "tests/test_real.py"]);
});
