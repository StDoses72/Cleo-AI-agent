import { getLanguage, translator, t as tr } from "./i18n.mjs";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { readJson, writeJson } from "./evolution-store.mjs";
import { EvolutionInteractions } from "./evolution-interactions.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();

/** Purpose: Keep frozen behavior cases and build-bound results outside editable source.
 * Input: version store and optional replay implementation. Output: persistent acceptance workflow.
 */
export class EvolutionAcceptance {
  constructor(store, replay = replayDream) {
    this.store = store;
    this.replay = replay;
    this.path = join(store.root, "acceptance", "suite.json");
    this.reportPath = join(store.root, "acceptance", "report.json");
    this.interactions = new EvolutionInteractions(store);
  }

  async status(state) {
    const cases = await readJson(this.path, []);
    const report = await readJson(this.reportPath);
    const build = state.builds.find((item) => item.id === (state.candidate || state.active));
    const fresh = Boolean(report && report.suiteHash === digest(cases) && report.candidate === build?.id
      && report.sourceHash === build?.sourceHash && !state.draftDirty);
    return { cases, report, fresh, interactions: await this.interactions.read() };
  }

  /** Purpose: Freeze evidence before editing. Input: human expectation and captured trace. Output: immutable case. */
  async create(input) {
    const state = await this.store.read();
    if (!state.active) throw new Error(tr("evolution_acceptance.prepare_the_current_version_first"));
    const title = String(input.title || "").trim();
    const expectation = String(input.expectation || "").trim();
    const evidence = String(input.evidence || "");
    const kind = input.kind || "manual";
    if (!title || title.length > 120 || !expectation || expectation.length > 4000 || evidence.length > 100000)
      throw new Error(tr("evolution_acceptance.enter_a_case_name_and_expected_behavior_evidence_is_limited_to_100_000_characters"));
    if (!["manual", "dream-format"].includes(kind)) throw new Error(tr("evolution_acceptance.unsupported_acceptance_type"));
    if (kind === "dream-format" && (![input.fixture?.invalid, input.fixture?.corrected, input.fixture?.prompt].every((value) => typeof value === "string" && value.length)
        || JSON.stringify(input.fixture).length > 120000)) throw new Error(tr("evolution_acceptance.dream_replay_requires_the_original_input_failed_output_and_a_valid_corrected_output"));
    const item = { id: randomUUID(), title, expectation, evidence, kind, enabled: true,
      sourceThread: String(input.sourceThread || "").slice(0, 150), baseline: state.active, createdAt: now(),
      ...(kind === "dream-format" ? { fixture: input.fixture } : {}) };
    const cases = await readJson(this.path, []);
    await writeJson(this.path, [...cases, item]);
    return item;
  }

  async archive(id) {
    const cases = await readJson(this.path, []);
    if (!cases.some((item) => item.id === id)) throw new Error(tr("evolution_acceptance.acceptance_case_not_found"));
    await writeJson(this.path, cases.map((item) => item.id === id ? { ...item, enabled: false } : item));
  }

  /** Purpose: Withdraw optional human acceptance without claiming it passed.
   * Input: manual case ID. Output: archived evidence; other fresh results remain usable.
   */
  async cancel(id) {
    const status = await this.status(await this.store.read());
    const item = status.cases.find((entry) => entry.id === id);
    if (!item || item.kind !== "manual") throw new Error(tr("evolution_acceptance.only_manual_acceptance_cases_can_be_cancelled"));
    if (item.cancelledAt) return item;
    if (!item.enabled) throw new Error(tr("evolution_acceptance.this_acceptance_item_has_ended"));
    const cancelled = { ...item, enabled: false, cancelledAt: now() };
    const cases = status.cases.map((entry) => entry.id === id ? cancelled : entry);
    await writeJson(this.path, cases);
    if (status.fresh) {
      status.report.suiteHash = digest(cases);
      await writeJson(this.reportPath, status.report);
    }
    return cancelled;
  }

  /** Purpose: Compare identical fixtures in independent temporary homes, retaining baseline evidence.
   * Input: fully built candidate. Output: durable report; failure never becomes a passed check.
   */
  async compare(candidateId) {
    const state = await this.store.read();
    if (!candidateId || (state.candidate || state.active) !== candidateId || state.draftDirty)
      throw new Error(tr("evolution_acceptance.complete_build_checks_for_the_current_changes_before_comparing_behavior"));
    const build = await this.store.build(candidateId);
    const cases = await readJson(this.path, []);
    const report = { candidate: candidateId, sourceHash: build.sourceHash, suiteHash: digest(cases),
      createdAt: now(), results: [] };
    for (const item of cases.filter((entry) => entry.enabled)) {
      if (item.kind === "manual") {
        report.results.push({ id: item.id, before: { status: "manual", detail: tr("evolution_acceptance.not_verified_original_evidence_has_been_preserved_it_does_not_establish_that_the_prev") },
          after: { status: "manual", detail: tr("evolution_acceptance.try_the_applied_changes_and_accept_them_if_they_meet_expectations_otherwise_provide_f") } });
        continue;
      }
      const baselinePath = join(this.store.root, "acceptance", `baseline-${item.id}.json`);
      const cached = await readJson(baselinePath);
      let before = cached?.caseHash === digest(item) ? cached.result : null;
      if (!before || before.status === "error") {
        try { before = await this.replay(await this.store.build(item.baseline), item.fixture); }
        catch (error) { before = { status: "error", detail: error.message }; }
        await writeJson(baselinePath, { caseHash: digest(item), result: before });
      }
      let after;
      try { after = await this.replay(build, item.fixture); }
      catch (error) { after = { status: "error", detail: error.message }; }
      report.results.push({ id: item.id, before, after });
    }
    await writeJson(this.reportPath, report);
    return report;
  }

  /** Purpose: Record explicit confirmation for this candidate, retaining optional legacy notes.
   * Input: case ID and optional note. Output: dated receipt; no observation text is invented.
   */
  async review(id, note) {
    const status = await this.status(await this.store.read());
    const item = status.cases.find((entry) => entry.id === id && entry.enabled && entry.kind === "manual");
    if (!status.fresh || !item) throw new Error(tr("evolution_acceptance.the_case_or_version_changed_compare_behavior_again"));
    const observation = String(note || "").trim();
    if (observation.length > 4000) throw new Error(tr("evolution_acceptance.acceptance_notes_are_limited_to_4_000_characters"));
    const result = status.report.results.find((entry) => entry.id === id);
    if (!result) throw new Error(tr("evolution_acceptance.this_iteration_has_no_result_for_the_case_compare_again"));
    const detail = note == null && result.after.status === "passed" && result.after.manual
      ? result.after.detail : observation;
    result.after = { ...result.after, status: "passed", detail, reviewedAt: now(), manual: true };
    await writeJson(this.reportPath, status.report);
  }

  /** Complete a manual case on explicit confirmation of the applied build; notes remain optional. */
  async complete(id, note) {
    const state = await this.store.read();
    const status = await this.status(state);
    const receipt = status.interactions.completions.find((item) => item.id === id);
    const item = status.cases.find((entry) => entry.id === id);
    if (item?.cancelledAt) throw new Error(tr("evolution_acceptance.acceptance_was_cancelled_for_this_item_it_was_not_recorded_as_passed"));
    if (receipt && item && !item.enabled) return receipt;
    const feedback = status.interactions.feedback.filter((f) => f.caseId === id).at(-1);
    if (feedback && feedback.mode !== "continue")
      throw new Error(tr("evolution_acceptance.further_feedback_was_submitted_for_this_item_complete_the_changes_before_accepting_th"));
    if (!status.fresh || status.report?.candidate !== state.active)
      throw new Error(tr("evolution_acceptance.apply_the_current_build_and_try_it_before_confirming_acceptance"));
    await this.review(id, note);
    const reviewed = await readJson(this.reportPath);
    const completion = await this.interactions.append("completions", {
      id, note: reviewed.results.find((result) => result.id === id).after.detail,
      candidate: state.active, sourceHash: reviewed.sourceHash,
    });
    await this.archive(id);
    // Disabling this explicitly reviewed item does not change any other result's evidence.
    reviewed.suiteHash = digest(await readJson(this.path, []));
    await writeJson(this.reportPath, reviewed);
    return completion;
  }

  /** Purpose: Fail closed at Apply and Save without affecting rollback to previously saved programs. */
  async requirePassed(id) {
    const state = await this.store.read();
    const build = state.builds.find((item) => item.id === id);
    if (!build || build.kind !== "local" || (id !== state.candidate && build.savedAt)) return;
    const status = await this.status(state);
    const cases = status.cases.filter((item) => item.enabled);
    if (!cases.length) return;
    if (!status.fresh || status.report.candidate !== id || cases.some((item) => {
      const result = status.report.results.find((entry) => entry.id === item.id);
      return result?.after.status !== "passed" || result?.before.status === "error";
    })) throw new Error(tr("evolution_acceptance.behavior_acceptance_has_not_passed_compare_the_current_version_and_complete_the_cases"));
  }

  async prompt(id, language = getLanguage()) {
    const requestText = translator(language);
    const item = (await readJson(this.path, [])).find((entry) => entry.id === id && entry.enabled);
    if (!item) throw new Error(tr("evolution_acceptance.acceptance_case_not_found"));
    return requestText("evolution_acceptance.improve_cleo_s_implementation_according_to_the_frozen_case_below_keep_the_case_and_ex", { p0: item.title, p1: item.expectation, p2: item.sourceThread || requestText("evolution_acceptance.submitted_by_user"), p3: item.evidence });
  }
}

/** Purpose: Run the installed Python implementation with a deterministic transport and no live user data.
 * Input: registered package and frozen fixture. Output: bounded structured result from that package.
 */
export async function replayDream(build, fixture) {
  const resources = process.platform === "darwin" ? join(dirname(build.executable), "../Resources")
    : join(dirname(build.executable), "resources");
  const python = process.platform === "win32" ? join(resources, "python/python.exe") : join(resources, "python/bin/python3");
  const runner = await readFile(new URL("./acceptance-dream.py", import.meta.url), "utf8");
  const home = await mkdtemp(join(tmpdir(), "cleo-acceptance-"));
  try {
    await mkdir(join(home, "config"));
    for (const name of ["cleo.json", "harnesses.json"])
      await copyFile(join(resources, "defaults/config", name), join(home, "config", name));
    return await new Promise((resolve, reject) => {
      const env = { ...process.env, CLEO_HOME: home, CLEO_CONFIG_PATH: join(home, "config/cleo.json"),
        CLEO_HARNESSES_CONFIG_PATH: join(home, "config/harnesses.json"),
        PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
      delete env.PYTHONPATH;
      const child = spawn(python, ["-I", "-c", runner], { cwd: home, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let output = "", errors = "", settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => { child.kill(); finish(new Error(tr("evolution_acceptance.behavior_replay_exceeded_60_seconds_and_did_not_pass"))); }, 60000);
      child.on("error", (error) => finish(error));
      child.stdout.on("data", (data) => {
        output += data.toString();
        if (output.length > 20000) { child.kill(); finish(new Error(tr("evolution_acceptance.behavior_replay_output_exceeded_the_limit"))); }
      });
      child.stderr.on("data", (data) => { errors = (errors + data.toString()).slice(-2000); });
      child.on("close", (code) => {
        try {
          if (code !== 0) throw new Error(tr("evolution_acceptance.replay_process_failed_value_value", { p0: code, p1: errors }));
          const result = JSON.parse(output.trim().split("\n").at(-1));
          if (!["passed", "failed"].includes(result.status) || typeof result.detail !== "string") throw new Error(tr("evolution_acceptance.invalid_replay_result_format"));
          finish(null, result);
        } catch (error) { finish(error); }
      });
      child.stdin.on("error", (error) => finish(error));
      child.stdin.end(JSON.stringify(fixture));
    });
  } finally { await rm(home, { recursive: true, force: true }); }
}
