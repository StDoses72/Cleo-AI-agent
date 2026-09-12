import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { extractFile, listPackage } from "@electron/asar";
import { EvolutionAcceptance } from "../electron/evolution-acceptance.mjs";
import { EvolutionRequests } from "../electron/evolution-requests.mjs";
import { writeJson, readJson } from "../electron/evolution-store.mjs";

// Read retained program packages, but run every reader/writer against temporary fixtures only.
const buildsRoot = resolve(process.argv[2] || "../../builds");
const results = [];
for (const build of await readdir(buildsRoot, { withFileTypes: true })) {
  if (!build.isDirectory()) continue;
  const archive = join(buildsRoot, build.name, "Cleo/resources/app.asar");
  const entries = listPackage(archive).map((name) => name.replaceAll("\\", "/"));
  if (!entries.includes("/electron/evolution-acceptance.mjs")) {
    results.push({ version: build.name, status: "unverified", reason: "This retained program predates the acceptance reader/writer." });
    continue;
  }
  const root = await mkdtemp(join(tmpdir(), "cleo-acceptance-compat-"));
  try {
    for (const name of ["evolution-acceptance.mjs", "evolution-store.mjs"])
      await writeFile(join(root, name), extractFile(archive, `electron/${name}`));
    const { EvolutionAcceptance: Previous } = await import(pathToFileURL(join(root, "evolution-acceptance.mjs")));
    const state = { active: "old", candidate: "new", builds: [
      { id: "old", kind: "local", sourceHash: "old" }, { id: "new", kind: "local", sourceHash: "new" },
    ] };
    const store = { root, read: async () => state, build: async (id) => state.builds.find((b) => b.id === id) };
    const old = new Previous(store);
    const fresh = new EvolutionAcceptance(store);
    const original = await old.create({ title: "existing nonempty case", expectation: "keep original meaning", evidence: "existing evidence" });
    const oldData = await readJson(old.path);
    oldData[0].unknown = { id: "stable", values: ["nonempty"] };
    delete oldData[0].sourceThread; // Older optional field absent.
    await writeJson(old.path, oldData);
    const userData = { chats: [{ id: "chat-id", text: "nonempty conversation", unknown: true }],
      memories: ["nonempty memory"], config: { model: "unchanged", unknown: { keep: 1 } } };
    await mkdir(join(root, "user-data"));
    await writeJson(join(root, "user-data", "fixture.json"), userData);
    const requests = new EvolutionRequests(fresh, async () => ({ intent: "change", cases: [{
      title: "new case", requirement: "show label", current: "unverified icon", trigger: "open sidebar",
      expectation: "label visible", evidence: "ui/src/Button.tsx:1: icon",
    }] }));
    const prepared = await requests.prepare({ id: "request", threadId: "thread", prompt: "show label" });
    const journal = await requests.read(); journal.unknown = { future: "preserve" };
    journal.requests[0].unknown = ["future request field"];
    await writeJson(requests.path, journal);
    const bytes = await readFile(requests.path);
    await old.create({ title: "old writer adds case", expectation: "old defaults still work" });
    await old.archive(original.id);
    await old.compare("new");
    await old.review(prepared.cases[0].item.id, "isolated manual observation");
    const readBack = await fresh.status(state);
    assert.equal(readBack.cases.length, 3);
    assert.equal(readBack.cases[0].expectation, original.expectation);
    assert.equal(readBack.cases[0].evidence, original.evidence);
    assert.deepEqual(readBack.cases[0].unknown, oldData[0].unknown);
    assert.equal(Object.hasOwn(readBack.cases[0], "sourceThread"), false);
    assert.equal(readBack.cases[1].expectation, "label visible");
    assert.deepEqual(readBack.cases[1], prepared.cases[0].item);
    assert.deepEqual(await readFile(requests.path), bytes);
    assert.deepEqual(await readJson(join(root, "user-data", "fixture.json")), userData);
    assert.equal((await requests.prepare({ id: "request", threadId: "thread", prompt: "show label" })).cases[0].item.id, prepared.cases[0].item.id);
    assert.equal(readBack.report.results.find((r) => r.id === prepared.cases[0].item.id).after.status, "passed");
    results.push({ version: build.name, status: "passed", roundTrip: "old -> new -> old -> new", stores: ["suite.json", "report.json", "requests-v1.json (separate)"] });
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
}
assert.ok(results.length, "No retained packages found; compatibility was not checked.");
console.log(JSON.stringify(results, null, 2));
