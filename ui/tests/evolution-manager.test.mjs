import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeJson } from "../electron/evolution-store.mjs";
import { EvolutionManager } from "../electron/evolution.mjs";
import { downloadVerified, extract, run } from "../electron/evolution-tools.mjs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/** Purpose: Run the real compiler while replacing downloads and native packaging.
 * Input: test context and optional command failure. Output: editable controller and ordered build commands.
 */
async function validationFixture(t, fail = () => {}) {
  const { manager, root } = await fixture(t);
  const calls = [];
  const base = { id: "base", kind: "official", executable: `${manager.target.bundle}/${manager.target.executable}` };
  const executable = join(manager.store.root, "builds/base", base.executable);
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, "working program");
  await manager.store.update({ prepared: true, active: "base", baseline: "base", builds: [base] });
  await run("git", ["init"], { cwd: manager.source });
  await writeFile(join(manager.source, ".gitignore"), "release/\nui/*.tsbuildinfo\n");
  await writeFile(join(manager.source, "ui/electron/feature.test.mjs"), "// Fixture regression entry point.\n");
  await writeJson(join(manager.source, "ui/tsconfig.json"), {
    compilerOptions: { jsx: "preserve", noEmit: true, types: [], skipLibCheck: true }, include: ["*.tsx"],
  });
  const component = join(manager.source, "ui/Conversation.tsx");
  await writeFile(component, 'declare function Composer(props: {key: string}): null;\nconst view = <Composer key="thread" />;\n');
  manager.tools.prepare = async () => ({ git: "git", node: process.execPath, npm: "fixture-npm-cli.js", uv: "fixture-uv", env: process.env });
  manager.runCommand = async (command, args, options) => {
    const stage = args[0] === "fixture-npm-cli.js" ? "dependencies"
      : args[0]?.endsWith("typescript/bin/tsc") ? "typecheck"
      : args[0]?.endsWith("vite/bin/vite.js") ? "frontend"
      : args[0] === "--test" ? "tests" : args.includes("pytest") ? "python-tests"
      : command === "fixture-uv" ? "lint" : "package";
    calls.push(stage);
    fail(stage);
    if (stage === "typecheck") {
      return run(process.execPath, [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)), ...args.slice(1)], options);
    }
    if (stage === "package") {
      const output = join(manager.source, "release", base.executable);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, "new program");
    }
    return "";
  };
  return { manager, root, calls, component };
}

test("duplicate JSX attributes fail preflight before packaging and remain repairable after restart", async (t) => {
  const { manager, calls, component } = await validationFixture(t);
  await writeFile(component, 'declare function Composer(props: {key: string}): null;\nconst view = <Composer key="project" key="thread" />;\n');
  await assert.rejects(manager.build(), /前端类型检查未通过/);
  assert.deepEqual(calls, ["dependencies", "typecheck"]);
  const restarted = new EvolutionManager({ app: manager.app, root: manager.store.root, dataHome: manager.store.dataHome });
  const failed = await restarted.status();
  assert.equal(failed.validation.status, "failed");
  assert.equal(failed.validation.stage, "typecheck");
  assert.match(failed.validation.details, /TS17001/);
  assert.equal(failed.validation.repairable, true);
  assert.equal(failed.active, "base");
  assert.equal(failed.candidate, undefined);
  assert.match(await manager.repairPrompt(), /TS17001/);
  await writeFile(component, 'declare function Composer(props: {key: string}): null;\nconst view = <Composer key="thread" />;\n');
  const id = await manager.build();
  const passed = await manager.status();
  assert.equal(passed.validation.status, "passed");
  assert.equal(passed.validation.candidate, id);
  assert.equal(passed.draftDirty, false);
  assert.deepEqual(calls.slice(2), ["dependencies", "typecheck", "frontend", "lint", "tests", "python-tests", "package"]);
});

test("Python lint errors fail locally before packaging instead of first failing in PR CI", async (t) => {
  const { manager, calls } = await validationFixture(t, (stage) => {
    if (stage === "lint") throw new Error("E501 Line too long");
  });
  await assert.rejects(manager.build(), /Python 代码规范检查未通过/);
  assert.equal((await manager.status()).validation.stage, "lint");
  assert.ok(!calls.includes("package"));
});

test("missing dependencies are unverified, never a code repair or a passing check", async (t) => {
  const { manager, calls } = await validationFixture(t, (stage) => {
    if (stage === "dependencies") throw new Error("npm ERR! ECONNRESET");
  });
  await assert.rejects(manager.build(), /依赖准备未完成/);
  const state = await manager.status();
  assert.equal(state.validation.status, "failed");
  assert.equal(state.validation.repairable, false);
  assert.equal(state.draftDirty, true);
  await assert.rejects(manager.repairPrompt(), /没有可交给 Cleo/);
  assert.deepEqual(calls, ["dependencies"]);
});

test("a failed recheck cannot reuse an older candidate or stage it", async (t) => {
  let broken = false;
  const { manager, calls } = await validationFixture(t, (stage) => {
    if (broken && stage === "frontend") throw new Error("frontend build failed");
  });
  const id = await manager.build();
  await manager.begin();
  broken = true;
  await assert.rejects(manager.build(), /前端构建未通过/);
  await assert.rejects(manager.stage(id), /检查/);
  await manager.store.update({ active: id });
  await assert.rejects(manager.saveVersion(), /检查/);
  assert.equal((await manager.status()).validation.status, "failed");
  assert.equal(calls.filter((stage) => stage === "package").length, 1);
});

test("source edits during packaging invalidate all preceding checks", async (t) => {
  const { manager, component } = await validationFixture(t);
  const execute = manager.runCommand;
  manager.runCommand = async (command, args, options) => {
    const result = await execute(command, args, options);
    if (args.includes("-LockedDependencies") || args.includes("--locked-dependencies")) {
      await writeFile(component, "const editedDuringBuild = true;\n");
    }
    return result;
  };
  await assert.rejects(manager.build(), /构建一致性检查未通过/);
  const state = await manager.status();
  assert.equal(state.validation.stage, "verify");
  assert.equal(state.candidate, undefined);
  assert.equal(state.draftDirty, true);
});

test("interrupted and legacy checks require a fresh build", async (t) => {
  const { manager } = await validationFixture(t);
  const id = await manager.build();
  await writeJson(join(manager.store.root, "validation.json"), { status: "running", stage: "package" });
  assert.equal((await manager.status()).validation.status, "interrupted");
  await assert.rejects(manager.stage(id), /检查/);
  await rm(join(manager.store.root, "validation.json"));
  await assert.rejects(manager.stage(id), /检查/);
});

test("editing after a passed check disables apply until revalidation", async (t) => {
  const { manager, component } = await validationFixture(t);
  const id = await manager.build();
  await writeFile(component, "const laterEdit = true;\n");
  await assert.rejects(manager.stage(id), /又有新修改/);
  const state = await manager.status();
  assert.equal(state.draftDirty, true);
  assert.equal(state.validation.status, "pending");
  assert.equal(state.transaction, null);
});

test("failed regression tests never reach packaging", async (t) => {
  const { manager, calls } = await validationFixture(t, (stage) => {
    if (stage === "tests") throw new Error("AssertionError: behavior regressed");
  });
  await assert.rejects(manager.build(), /回归测试未通过/);
  assert.equal((await manager.status()).validation.repairable, true);
  assert.ok(!calls.includes("package"));
});

test("validated drafts can be applied and saved; saved versions remain recoverable without receipts", async (t) => {
  const { manager } = await validationFixture(t);
  const id = await manager.build();
  assert.equal((await manager.stage(id)).to, id);
  // Simulate a successful restart at the controller boundary without launching a real installation.
  await manager.store.update({ active: id, transaction: null });
  const saved = await manager.saveVersion("checked version");
  assert.equal(saved.id, id);
  assert.ok(saved.savedAt);
  await rm(join(manager.store.root, "validation.json"));
  await manager.store.update({ active: "base" });
  assert.equal((await manager.stage(id)).to, id);
});

/** Purpose: Exercise controller boundaries with no network or installed-app mutations.
 * Input: test context. Output: disposable controller and editable source.
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cleo-evolution-manager-"));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.includes("cleo-evolution-manager-"));
    await rm(root, { recursive: true, force: true });
  });
  const manager = new EvolutionManager({ app: { isPackaged: false, getVersion: () => "0.3.9" },
    root: join(root, "controller"), dataHome: join(root, "home") });
  await mkdir(join(manager.source, "ui/electron"), { recursive: true });
  for (const name of ["bootstrap.mjs", "evolution.mjs", "evolution-store.mjs", "evolution-tools.mjs", "evolution-recovery.mjs", "evolution-launch.mjs", "evolution-progress.mjs", "evolution-handoff.mjs"]) {
    await cp(new URL("../electron/" + name, import.meta.url), join(manager.source, "ui/electron", name));
  }
  await writeFile(join(manager.source, "ui/package.json"), '{"main":"electron/bootstrap.mjs"}');
  await manager.saveProtection();
  await mkdir(join(manager.source, "cleo/config/templates"), { recursive: true });
  for (const name of ["cleo", "harnesses"]) {
    await cp(new URL(`../../cleo/config/templates/${name}.example.json`, import.meta.url),
      join(manager.source, `cleo/config/templates/${name}.example.json`));
  }
  return { root, manager };
}

test("Python test failures block packaging and use an isolated data home", async (t) => {
  const { manager, calls } = await validationFixture(t);
  const execute = manager.runCommand;
  let testHome;
  manager.runCommand = async (command, args, options) => {
    if (args.includes("pytest")) {
      assert.equal(options.cwd, manager.source);
      testHome = options.env.CLEO_HOME;
      assert.notEqual(testHome, manager.store.dataHome);
      assert.notEqual(testHome, process.env.CLEO_HOME);
      assert.equal(JSON.parse(await readFile(options.env.CLEO_CONFIG_PATH, "utf8")).active_profiles.dream_agent, null);
      assert.ok(await readFile(options.env.CLEO_HARNESSES_CONFIG_PATH));
      throw new Error("AssertionError: Python behavior regressed");
    }
    return execute(command, args, options);
  };
  await assert.rejects(manager.build(), /回归测试未通过/);
  const state = await manager.status();
  assert.equal(state.validation.repairable, true);
  assert.equal(state.validation.status, "failed");
  assert.equal(state.candidate, undefined);
  assert.ok(!calls.includes("package"));
  assert.ok(testHome);
  await assert.rejects(readFile(join(testHome, "cleo.json")), { code: "ENOENT" });
});

test("changing recovery code or replacing its entry point blocks application", async (t) => {
  const { manager } = await fixture(t);
  await manager.checkProtection();
  await writeFile(join(manager.source, "ui/package.json"), '{"main":"electron/unsafe.mjs"}');
  await assert.rejects(manager.checkProtection(), /启动入口/);
  await writeFile(join(manager.source, "ui/package.json"), '{"main":"electron/bootstrap.mjs"}');
  await writeFile(join(manager.source, "ui/electron/bootstrap.mjs"), "broken");
  await assert.rejects(manager.checkProtection(), /不可自我修改/);
});

test("failed operations retain existing registry and clear busy state for retry", async (t) => {
  const { manager } = await fixture(t);
  await manager.store.update({ active: "working", candidate: "previous" });
  await assert.rejects(manager.operation("building", async () => { throw new Error("compiler failed"); }), /compiler failed/);
  assert.equal(manager.phase, "idle");
  assert.equal(manager.error, "compiler failed");
  assert.equal((await manager.store.read()).active, "working");
  assert.equal((await manager.store.read()).candidate, "previous");
  await manager.operation("checking", async () => {});
  assert.equal(manager.error, null);
});

test("controller rejects concurrent operations", async (t) => {
  const { manager } = await fixture(t);
  let finish;
  const first = manager.operation("building", () => new Promise((done) => { finish = done; }));
  await assert.rejects(manager.operation("submitting", async () => {}), /另一项/);
  finish();
  await first;
});

test("releases with the former data-rollback protocol are rejected before downloading", async (t) => {
  const { manager } = await fixture(t);
  manager.ensureBaseline = async () => {};
  await writeJson(join(manager.store.root, "releases.json"), [
    { tag: "v0.3.9", manifestUrl: "https://example.test/release.json" },
  ]);
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async () => new Response(JSON.stringify({ evolution_protocol: 1 }));
  await assert.rejects(manager.downloadRelease("v0.3.9"), /保留当前用户数据/);
  assert.equal((await manager.store.read()).builds.length, 0);
});

test("downloads reject missing and incorrect checksums", async (t) => {
  const { root } = await fixture(t);
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async () => new Response("verified executable");
  const destination = join(root, "download/archive.zip");
  await assert.rejects(downloadVerified("https://example.test/file", destination, null), /SHA-256/);
  await assert.rejects(downloadVerified("https://example.test/file", destination, "a".repeat(64)), /校验失败/);
  const digest = createHash("sha256").update("verified executable").digest("hex");
  await downloadVerified("https://example.test/file", destination, digest);
  assert.equal(await readFile(destination, "utf8"), "verified executable");
});

test("metadata command output is not silently truncated at 32 KB", async () => {
  const output = await run(process.execPath, ["-e", "process.stdout.write('x'.repeat(64000))"]);
  assert.equal(output.length, 64000);
});

test("timed out child commands cannot report success", async () => {
  await assert.rejects(run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 100 }), /超时/);
});

test("discard returns to the original base and archives source without touching user data", async (t) => {
  const { manager, root } = await fixture(t);
  const builds = ["base", "draft"].map((id) => ({ id, executable: "Cleo/Cleo.exe", kind: id === "base" ? "official" : "local" }));
  for (const build of builds) {
    const executable = join(manager.store.root, "builds", build.id, build.executable);
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, "fixture");
  }
  await mkdir(join(root, "home"), { recursive: true });
  await writeFile(join(root, "home/data.txt"), "latest data");
  await manager.store.update({ builds, baseline: "base", active: "draft", iteration: { base: "base" }, prepared: true });
  await assert.rejects(manager.selectVersion("base"), /保存或放弃/);
  assert.equal(await manager.discardIteration(), "base");
  const state = await manager.store.read();
  assert.equal(state.active, "draft", "Only the external application controller may switch the running program.");
  assert.equal(state.prepared, false);
  assert.equal(state.iteration, null);
  assert.equal(state.selectedBase, "base");
  assert.equal(await readFile(join(root, "home/data.txt"), "utf8"), "latest data");
  await assert.rejects(readFile(join(manager.source, "ui/package.json")), { code: "ENOENT" });
});

test("explicit bundle import preserves the baseline and does not override later selections on repeat", async (t) => {
  const { manager, root } = await fixture(t);
  const incoming = join(root, "incoming");
  await mkdir(join(incoming, "resources"), { recursive: true });
  await writeFile(join(incoming, "Cleo.exe"), "fixture");
  await writeFile(join(incoming, "resources/app.asar"), "current package");
  manager.executable = join(incoming, "Cleo.exe");
  const oldExe = join(manager.store.root, "builds/old/Cleo/Cleo.exe");
  await mkdir(dirname(oldExe), { recursive: true });
  await writeFile(oldExe, "old");
  await manager.store.update({ baseline: "old", active: "old", builds: [{ id: "old", executable: "Cleo/Cleo.exe" }] });
  const imported = await manager.importBundle();
  assert.ok(imported.savedAt);
  assert.equal((await manager.store.read()).baseline, "old");
  assert.equal((await manager.store.read()).active, imported.id);
  await manager.store.update({ active: "old" });
  assert.equal((await manager.importBundle()).id, imported.id);
  assert.equal((await manager.store.read()).active, "old");
  // Retiring the imported build must not make its shortcut re-import it on every launch.
  const retained = (await manager.store.read()).builds.filter((build) => build.id === "old");
  await manager.store.update({ builds: retained, workspaceBase: "old", selectedBase: "old", latestSaved: null, pendingImport: null });
  assert.equal((await manager.importBundle()).id, "old");
  assert.deepEqual((await manager.store.read()).builds.map((build) => build.id), ["old"]);
});

test("preparation restores the selected local version's embedded source", async (t) => {
  const { manager, root } = await fixture(t);
  const options = { cwd: manager.source, env: process.env };
  await run("git", ["init"], options);
  await writeFile(join(manager.source, "feature.txt"), "official source");
  await run("git", ["add", "."], options);
  await run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"], options);
  await run("git", ["tag", "v0.3.9"], options);
  const repository = join(root, "origin");
  await cp(manager.source, repository, { recursive: true });
  manager.sourceRepository = repository;
  const resources = join(manager.store.root, "builds/saved/Cleo/resources");
  await mkdir(resources, { recursive: true });
  await writeFile(join(resources, "../Cleo.exe"), "fixture");
  const embedded = join(root, "embedded");
  await mkdir(embedded);
  await writeFile(join(embedded, "feature.txt"), "saved local version source");
  await writeJson(join(embedded, "evolution-source.json"), { deleted: [] });
  await run("tar", ["-czf", join(resources, "evolution-source.tar.gz"), "-C", embedded, "."]);
  await manager.store.update({ active: "saved", baseline: "saved", prepared: false,
    builds: [{ id: "saved", kind: "local", savedAt: "today", baseTag: "v0.3.9", executable: "Cleo/Cleo.exe" }] });
  manager.tools.prepare = async () => ({ git: "git", env: process.env });
  await manager.prepare();
  assert.equal(await readFile(join(manager.source, "feature.txt"), "utf8"), "saved local version source");
  assert.equal((await manager.store.read()).baseTag, "v0.3.9");
});

test("source tar archives extract on Windows as well as POSIX", async (t) => {
  const { root } = await fixture(t);
  const source = join(root, "tar-source");
  await mkdir(source);
  await writeFile(join(source, "hello.txt"), "source");
  const archive = join(root, "source.tar.gz");
  await run("tar", ["-czf", archive, "-C", source, "."]);
  await extract(archive, join(root, "extracted"));
  assert.equal(await readFile(join(root, "extracted/hello.txt"), "utf8"), "source");
});
