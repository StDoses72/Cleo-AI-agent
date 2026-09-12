import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { EvolutionManager } from "../electron/evolution.mjs";
import { run } from "../electron/evolution-tools.mjs";

for (const explicitBase of [false, true]) {
  test(`bundled source preserves committed, staged and unstaged deletions (${explicitBase ? "selected" : "version"} base)`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cleo-source-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, "source");
    await mkdir(join(source, "scripts"), { recursive: true });
    await cp(new URL("../../scripts/bundle-evolution-source.mjs", import.meta.url),
      join(source, "scripts/bundle-evolution-source.mjs"));
    await cp(new URL("../electron/", import.meta.url), join(source, "ui/electron"), { recursive: true });
    await writeFile(join(source, "ui/package.json"), JSON.stringify({ version: "0.3.9", main: "electron/bootstrap.mjs" }));
    const options = { cwd: source, env: process.env };
    const git = (...args) => run("git", args, options);
    const commit = () => git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture");
    await git("init");
    for (const name of ["committed.txt", "staged.txt", "unstaged.txt", "kept.txt"])
      await writeFile(join(source, name), "baseline");
    await git("add", ".");
    await commit();
    const baseTag = explicitBase ? "v0.3.8" : "v0.3.9";
    await git("tag", baseTag);
    await git("rm", "committed.txt");
    await commit();
    if (explicitBase) await git("tag", "v0.3.9");
    await git("rm", "staged.txt");
    await rm(join(source, "unstaged.txt"));
    await writeFile(join(source, "kept.txt"), "local edit");
    await writeFile(join(source, "new.txt"), "untracked addition");
    await writeFile(join(source, ".env"), "must not ship");

    const manager = new EvolutionManager({
      app: { isPackaged: false, getVersion: () => "0.3.9" },
      root: join(root, "controller"), dataHome: join(root, "home"), sourceRepository: source,
    });
    const executable = `${manager.target.bundle}/${manager.target.executable}`;
    const saved = join(manager.store.root, "builds/saved");
    await mkdir(dirname(join(saved, executable)), { recursive: true });
    await writeFile(join(saved, executable), "fixture");
    const resources = join(saved, manager.target.bundle, manager.target.resources);
    const env = { ...process.env };
    delete env.CLEO_EVOLUTION_BASE_TAG;
    if (explicitBase) env.CLEO_EVOLUTION_BASE_TAG = baseTag;
    await run(process.execPath, [join(source, "scripts/bundle-evolution-source.mjs"), resources], { env });
    await manager.store.update({ active: "saved", baseline: "saved", prepared: false,
      builds: [{ id: "saved", kind: "local", savedAt: "today", baseTag, executable }] });
    manager.tools.prepare = async () => ({ git: "git", env: process.env });
    await manager.prepare();
    for (const name of ["committed.txt", "staged.txt", "unstaged.txt", ".env"])
      await assert.rejects(readFile(join(manager.source, name)), { code: "ENOENT" });
    assert.equal(await readFile(join(manager.source, "kept.txt"), "utf8"), "local edit");
    assert.equal(await readFile(join(manager.source, "new.txt"), "utf8"), "untracked addition");
    assert.equal((await manager.store.read()).baseTag, baseTag);
  });
}
