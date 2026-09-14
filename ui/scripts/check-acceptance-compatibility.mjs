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
const versions = await readdir(buildsRoot, { withFileTypes: true });
if (process.argv[3]) versions.push({ name: "iteration-base", isDirectory: () => true, source: resolve(process.argv[3]) });
for (const build of versions) {
  if (!build.isDirectory()) continue;
  const archive = join(buildsRoot, build.name, "Cleo/resources/app.asar");
  const entries = build.source ? (await readdir(build.source)).map((name) => `/electron/${name}`)
    : listPackage(archive).map((name) => name.replaceAll("\\", "/"));
  const sourceFile = (name) => build.source ? readFile(join(build.source, name)) : extractFile(archive, `electron/${name}`);
  if (!entries.includes("/electron/evolution-acceptance.mjs")) {
    results.push({ version: build.name, status: "unverified", reason: "This retained program predates the acceptance reader/writer." });
    continue;
  }
  const root = await mkdtemp(join(tmpdir(), "cleo-acceptance-compat-"));
  try {
    for (const name of ["evolution-acceptance.mjs", "evolution-store.mjs"])
      await writeFile(join(root, name), await sourceFile(name));
    if (entries.includes("/electron/evolution-interactions.mjs"))
      await writeFile(join(root, "evolution-interactions.mjs"), await sourceFile("evolution-interactions.mjs"));
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
    const feedback = await requests.feedback({ id: "feedback", caseId: prepared.cases[0].item.id,
      body: "keep label and add color", threadId: "thread" });
    const sidecar = await fresh.interactions.read(); sidecar.future = { values: ["unknown"] };
    sidecar.feedback[0].future = { stable: true };
    await writeJson(fresh.interactions.path, sidecar);
    const sidecarBytes = await readFile(fresh.interactions.path);
    await old.compare("new");
    await old.review(feedback.cases[0].item.id, "old version observes new criterion");
    let requestWriter = "unavailable; unchanged format";
    if (entries.includes("/electron/evolution-requests.mjs")) {
      await writeFile(join(root, "evolution-requests.mjs"), await sourceFile("evolution-requests.mjs"));
      const { EvolutionRequests: OldRequests } = await import(pathToFileURL(join(root, "evolution-requests.mjs")));
      const previousRequests = new OldRequests(old, () => { throw new Error("must not reanalyze"); });
      await previousRequests.finish("feedback", "completed");
      assert.deepEqual((await requests.read()).unknown, journal.unknown);
      assert.deepEqual((await requests.read()).requests[0].unknown, journal.requests[0].unknown);
      requestWriter = "old reader/writer round trip passed";
    }
    assert.deepEqual(await readFile(fresh.interactions.path), sidecarBytes);
    state.active = "new";
    await fresh.compare("new");
    await fresh.complete(feedback.cases[0].item.id);
    assert.equal((await fresh.interactions.read()).completions[0].note, "");
    assert.equal((await old.status(state)).report.results.find((r) => r.id === feedback.cases[0].item.id).after.detail, "");
    const completedBytes = await readFile(fresh.interactions.path);
    await old.create({ title: "later old write", expectation: "retain existing and future data" });
    if (old.interactions) {
      const oldJournal = await old.interactions.read();
      assert.equal(oldJournal.completions[0].note, "");
      // Exercise the old sidecar writer too, without changing the new completion.
      await old.interactions.append("confirmations", { id: "old-confirmation", skipped: true });
      assert.deepEqual((await fresh.interactions.read()).completions, oldJournal.completions);
    }
    await old.compare("new");
    if (!old.interactions) assert.deepEqual(await readFile(fresh.interactions.path), completedBytes);
    assert.deepEqual((await fresh.interactions.read()).future, sidecar.future);
    assert.deepEqual((await fresh.interactions.read()).feedback[0].future, sidecar.feedback[0].future);
    assert.equal((await fresh.status(state)).cases.find((c) => c.id === feedback.cases[0].item.id).enabled, false);
    assert.equal((await fresh.interactions.read()).completions.length, 1);
    assert.deepEqual(await readJson(join(root, "user-data", "fixture.json")), userData);
    results.push({ version: build.name, status: "passed", roundTrip: "old -> new -> old -> new", requestWriter,
      stores: ["suite.json", "report.json", "requests-v1.json", "interactions-v1.json (empty notes preserved by available old writers)"] });
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
}
assert.ok(results.length, "No retained packages found; compatibility was not checked.");
console.log(JSON.stringify(results, null, 2));
