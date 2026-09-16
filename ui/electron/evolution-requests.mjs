import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJson, writeJson } from "./evolution-store.mjs";

const now = () => new Date().toISOString();
const text = (value, limit, name) => {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(`${name}无效。`);
  return value.trim();
};

/** Durable preparation journal. Existing suite/report schemas remain unchanged for older writers.
 * Call mutations inside the existing evolution operation lock; status is safe during preparation.
 */
export class EvolutionRequests {
  constructor(acceptance, analyze, onChange = () => {}) {
    this.acceptance = acceptance;
    this.store = acceptance.store;
    this.analyze = analyze;
    this.onChange = onChange;
    this.path = join(this.store.root, "acceptance", "requests-v1.json");
    this.running = new Set();
  }

  async read() {
    const data = await readJson(this.path, { schema: 1, requests: [] });
    if (data?.schema !== 1 || !Array.isArray(data.requests) || data.requests.some((r) =>
      !r || typeof r.id !== "string" || typeof r.prompt !== "string" || !Array.isArray(r.cases)
      || !["analyzing", "failed", "clarification", "answered", "freezing", "frozen"].includes(r.status)
      || (["freezing", "frozen"].includes(r.status) && !r.cases.length)
      || r.cases.some((c) => !c?.item || typeof c.item.id !== "string" || typeof c.item.expectation !== "string"
        || typeof c.item.evidence !== "string"))) {
      throw new Error("验收请求记录格式无法读取；已保留原文件，未覆盖。请使用兼容版本。");
    }
    return data;
  }

  async status() {
    return (await this.read()).requests.map((r) => ({ ...r,
      interrupted: ["analyzing", "freezing"].includes(r.status) && !this.running.has(r.id),
    }));
  }

  /** Capture case feedback before analysis; revised criteria get new IDs, never overwritten history. */
  async feedback({ id, caseId, body, threadId }) {
    text(id, 100, "反馈标识"); text(body, 5000, "反馈"); text(threadId, 150, "会话标识");
    const item = (await this.suite()).find((c) => c.id === caseId);
    const retry = (await this.read()).requests.find((r) => r.id === id);
    if (!item || (!item.enabled && !retry)) throw new Error("此验收项已结束，请使用最新的待验收项。");
    const pending = (await this.acceptance.interactions.read()).feedback.find((f) => f.caseId === caseId && f.id !== id);
    if (pending && item.kind === "manual") throw new Error("此项已有反馈，请先在对话中补充或继续，再对最新预期反馈。");
    const prompt = `继续修改此行为验收，结合原上下文和最新反馈重新准备待验收预期；未被反馈改变的要求继续保留。\n`
      + `验收项：${item.title}\n此前预期：${item.expectation}\n上下文：${item.evidence.slice(0, 18000)}\n最新用户反馈：${body}`;
    await this.acceptance.interactions.append("feedback", { id, caseId, body, threadId });
    // A feedback submission cannot leave a previous human pass usable while clarification waits.
    const status = await this.acceptance.status(await this.store.read());
    const result = status.report?.results.find((r) => r.id === caseId);
    if (result && item.kind === "manual") {
      result.after = { ...result.after, status: "manual", detail: "用户提交了进一步反馈，等待修改后重新验收。" };
      await writeJson(this.acceptance.reportPath, status.report);
    }
    return this.prepare({ id, threadId, prompt, ...(item.kind === "manual" ? { replaces: caseId } : {}) });
  }

  async save(data) {
    await writeJson(this.path, data);
    this.onChange();
  }

  /** Purpose: Retire an explicitly abandoned task without deleting its request or evidence.
   * Input: task identity. Output: durable abandonment and cancellation of its remaining manual cases.
   */
  async abandon({ threadId }) {
    text(threadId, 150, "会话标识");
    const data = await this.read();
    const requests = data.requests.filter((r) => r.threadId === threadId && !r.abandonedAt);
    if (requests.some((r) => this.running.has(r.id))) throw new Error("请先停止正在准备的需求。");
    const abandonedAt = now();
    for (const request of requests) request.abandonedAt = abandonedAt;
    // Journal first: even an interrupted cancellation must never restart an abandoned request.
    await this.save(data);
    const ids = new Set(data.requests.filter((r) => r.threadId === threadId).flatMap((r) => r.cases.map((c) => c.item.id)));
    for (const item of await this.suite()) {
      if (ids.has(item.id) && item.enabled && item.kind === "manual") await this.acceptance.cancel(item.id);
    }
    return { threadId, abandoned: requests.length };
  }

  /** Purpose: Resume implementation against the same frozen case, without another planning pass.
   * Input: case, task, optional feedback and stable retry ID. Output: one repair request and feedback receipt.
   */
  async continueCase({ id, caseId, threadId, body = "" }) {
    id = text(id, 100, "请求标识"); threadId = text(threadId, 150, "会话标识");
    if (typeof body !== "string" || body.length > 5000) throw new Error("反馈最多 5,000 字符。");
    const item = (await this.suite()).find((c) => c.id === caseId && c.enabled);
    if (!item) throw new Error("此验收项已结束，请使用最新的待验收项。");
    const data = await this.read();
    const parent = data.requests.find((r) => r.cases.some((c) => c.item.id === caseId));
    const prompt = `${(await this.acceptance.prompt(caseId)).slice(0, 24000)}\n\n用户选择沿用此案例继续修改，不重新生成案例，不改变原有验收预期。`
      + (body.trim() ? `\n最新反馈：${body.trim()}` : "");
    const request = await this.repair({ id, threadId, prompt, parent: parent?.id });
    await this.acceptance.interactions.append("feedback", { id, caseId, threadId,
      body: body.trim() || "沿用此案例继续修改", mode: "continue" });
    const status = await this.acceptance.status(await this.store.read());
    const result = status.report?.results.find((r) => r.id === caseId);
    if (result && item.kind === "manual" && !request.execution) {
      result.after = { ...result.after, status: "manual", detail: "沿用此案例继续修改，完成后重新验收。" };
      await writeJson(this.acceptance.reportPath, status.report);
    }
    return request;
  }

  async suite() {
    const cases = await readJson(this.acceptance.path, []);
    if (!Array.isArray(cases) || cases.some((c) => !c || typeof c.id !== "string"
      || typeof c.expectation !== "string" || typeof c.enabled !== "boolean")) {
      throw new Error("已有验收案例格式无法读取，未覆盖。");
    }
    return cases;
  }

  /** Purpose: Persist intent before analysis, allowing explicit reconsideration of a blocked request.
   * Input: Original identity, optional clarification or reanalyze flag. Output: durable preparation; frozen goals stay immutable.
   */
  async prepare({ id, threadId, prompt, clarification, reanalyze = false, skipClarification = false, replaces }) {
    text(id, 100, "请求标识"); text(threadId, 150, "会话标识"); text(prompt, 30000, "需求");
    const data = await this.read();
    let request = data.requests.find((r) => r.id === id);
    if (request?.abandonedAt) throw new Error("此需求已废弃，请提出新的修改需求。");
    if (request && (request.prompt !== prompt || request.threadId !== threadId)) throw new Error("请求标识已用于另一条需求。");
    if (!request) {
      request = { id, threadId, prompt, status: "analyzing", createdAt: now(), cases: [], clarifications: [],
        ...(replaces ? { replaces } : {}) };
      data.requests.push(request);
      await this.save(data);
    }
    if (request.status === "freezing") return this.freeze(data, request);
    if (["frozen", "answered"].includes(request.status)) return request;
    request.clarifications ||= [];
    if (request.status === "clarification" && !clarification && !reanalyze && !skipClarification) return request;
    if (skipClarification) {
      const recorded = (await this.acceptance.interactions.read()).confirmations.find((c) => c.id === id && c.skipped);
      if (!recorded) {
        if (request.status !== "clarification") throw new Error("当前需求不在等待确认。");
        await this.acceptance.interactions.append("confirmations", { id, skipped: true, question: request.answer });
      }
    }
    if (clarification) {
      const answer = text(clarification, 5000, "补充说明");
      if (request.status === "clarification") request.clarifications.push({ question: request.answer, answer, at: now() });
      else if (request.clarifications.at(-1)?.answer !== answer)
        throw new Error("当前需求不在等待澄清。请使用修正案例保留变更原因。");
    }
    this.running.add(id);
    try {
      request.status = "analyzing"; delete request.error; delete request.answer;
      await this.save(data);
      const skipped = (await this.acceptance.interactions.read()).confirmations.some((c) => c.id === id && c.skipped);
      const confirmed = skipped || request.clarifications.length > 0;
      const continuation = confirmed ? "\n已完成一次集中确认，不再追问。" + (skipped
        ? "用户选择跳过确认，未提供具体答案。" : "结合用户补充继续。")
        + "请采用合理且可逆的假设，返回 change 或 investigate 及具体验收；answer 简短说明采用的假设。" : "";
      let analysis = await this.analyze(threadId, prompt + request.clarifications.map((c) =>
        `\n澄清问题：${c.question}\n用户补充：${c.answer}`).join("") + continuation);
      if (confirmed && analysis?.intent === "clarification") {
        // One bounded model correction, not another user question or fabricated acceptance.
        analysis = await this.analyze(threadId, prompt + request.clarifications.map((c) => `\n用户补充：${c.answer}`).join("")
          + continuation + "\n上一分析仍返回了澄清，未遵守已确认的继续方式。请直接准备可执行的调查或修改验收。");
        if (analysis?.intent === "clarification") throw new Error("分析器未能按合理假设生成验收；原需求和确认已保留，可重试准备。");
      }
      if (["question", "clarification"].includes(analysis?.intent)) {
        request.answer = text(analysis.answer, 10000, "分析答复");
        request.status = analysis.intent === "question" ? "answered" : "clarification";
        await this.save(data);
        return request;
      }
      if (analysis?.intent !== "change" || !Array.isArray(analysis.cases) || !analysis.cases.length || analysis.cases.length > 12)
        throw new Error("未生成有效案例；没有开始修改代码。");
      const state = await this.store.read();
      if (!state.active) throw new Error("请先准备当前版本。");
      if (confirmed) request.answer = typeof analysis.answer === "string" && analysis.answer.trim()
        ? analysis.answer.slice(0, 10000) : "采用假设：保留现有上下文和未要求改变的行为，以最小可逆修改实现目标；执行时自行调查源码与日志。";
      request.cases = analysis.cases.map((c) => {
        const detail = { requirement: text(c.requirement, 4000, "对应要求"),
          current: text(c.current, 3000, "当前行为"), trigger: text(c.trigger, 2000, "操作条件"),
          sourceEvidence: text(c.evidence, 20000, "源码证据") };
        // A model cannot invent an executable checker or claim an observed baseline failure.
        detail.current = detail.current.startsWith("尚未验证") ? detail.current : `尚未验证（仅静态分析）：${detail.current}`;
        const item = { id: randomUUID(), title: text(c.title, 120, "标题"),
          expectation: text(c.expectation, 4000, "预期"),
          evidence: `对应要求：${detail.requirement}\n当前行为：${detail.current}\n操作：${detail.trigger}\n静态证据：\n${detail.sourceEvidence}`,
          kind: "manual", enabled: true, sourceThread: threadId, baseline: state.active, createdAt: now() };
        return { ...detail, item };
      });
      request.status = "freezing";
      await this.save(data); // Journal IDs before the suite write, for crash-safe replay.
      return await this.freeze(data, request);
    } catch (error) {
      // Once IDs have been journaled, even a failed final journal write must resume
      // that freeze, not ask the model for different expectations on retry.
      request.status = request.cases.length ? "freezing" : "failed";
      request.error = error.message;
      await this.save(data);
      throw error;
    } finally { this.running.delete(id); }
  }

  async freeze(data, request) {
    const cases = await this.suite();
    for (const { item } of request.cases) {
      const existing = cases.find((c) => c.id === item.id);
      if (existing && (existing.expectation !== item.expectation || existing.evidence !== item.evidence))
        throw new Error("冻结案例与已保存内容不一致，未覆盖。");
      if (!existing) cases.push(item);
    }
    // Revisions retain the entire old case and only archive it, using the old writer's semantics.
    await writeJson(this.acceptance.path, cases.map((c) => request.replaces === c.id ? { ...c, enabled: false } : c));
    request.status = "frozen"; request.frozenAt ||= now(); delete request.error;
    await this.save(data);
    return request;
  }

  async revise({ id, caseId, expectation, trigger, reason }) {
    text(id, 100, "修正标识");
    const data = await this.read();
    const retry = data.requests.find((r) => r.id === id);
    if (retry) {
      if (retry.replaces !== caseId || retry.reason !== reason || retry.cases[0]?.item.expectation !== expectation.trim()
        || retry.cases[0]?.trigger !== trigger.trim())
        throw new Error("修正标识已用于不同内容。");
      return retry.status === "freezing" ? this.freeze(data, retry) : retry;
    }
    const source = data.requests.find((r) => r.cases.some((c) => c.item.id === caseId));
    const previous = source?.cases.find((c) => c.item.id === caseId);
    const saved = (await this.suite()).find((c) => c.id === caseId && c.enabled);
    if (!previous || !saved) throw new Error("找不到可修正的自动准备案例。");
    const revised = { ...previous, trigger: text(trigger, 2000, "操作条件"), item: { ...saved,
      id: randomUUID(), expectation: text(expectation, 4000, "预期"), createdAt: now(), enabled: true,
      evidence: `${saved.evidence}\n用户调整操作：${trigger}\n变更原因：${text(reason, 4000, "变更原因")}` } };
    const request = { id, threadId: source.threadId, prompt: source.prompt, status: "freezing", createdAt: now(),
      cases: [revised], replaces: caseId, parent: source.id, reason, clarifications: [] };
    data.requests.push(request);
    await this.save(data);
    return this.freeze(data, request);
  }

  async editingPrompt(id) {
    const request = (await this.read()).requests.find((r) => r.id === id);
    if (request?.abandonedAt) throw new Error("此需求已废弃，请提出新的修改需求。");
    if (!request || request.status !== "frozen") throw new Error("请先完成本轮验收准备。");
    const cases = await this.suite();
    for (const { item } of request.cases) {
      const saved = cases.find((c) => c.id === item.id);
      if (saved?.cancelledAt) continue;
      if (!saved?.enabled || saved.expectation !== item.expectation || saved.evidence !== item.evidence)
        throw new Error("本轮案例已修正或归档，请使用更新后的案例。");
    }
    if (!request.cases.some(({ item }) => cases.some((c) => c.id === item.id && c.enabled)))
      throw new Error("本轮验收项已全部取消或结束，请提出新的修改需求。");
    const enabled = cases.filter((c) => c.enabled);
    return `[[CLEO_ACCEPTANCE_REQUEST:${request.id}]]\n${request.prompt}\n`
      + (request.reason ? `用户调整原因：${request.reason}\n` : "")
      + (request.clarifications || []).map((c) => `补充：${c.answer}\n`).join("")
      + (request.answer ? `继续方式与假设：${request.answer}\n` : "")
      + "\n以下案例已经由桌面保存并冻结。实现需求，保留已有回归；不得改写预期或声称人工案例已经通过。\n"
      + enabled.map((c) => `${c.id} ${c.title}\n操作与证据：${c.evidence}\n预期：${c.expectation}\n验证方式：${c.kind}`).join("\n\n");
  }

  /** Claim once before handing control to an editing agent. No renderer completion can pass a case. */
  async claim(threadId, prompt) {
    const id = /^\[\[CLEO_ACCEPTANCE_REQUEST:([^\]]+)\]\]/.exec(prompt)?.[1];
    if (!id || prompt !== await this.editingPrompt(id)) throw new Error("编辑前必须准备并冻结验收案例。");
    const data = await this.read();
    const request = data.requests.find((r) => r.id === id);
    if (request.threadId !== threadId || request.execution) throw new Error("此需求已提交或会话不匹配；不会重复启动修改。");
    request.execution = { status: "submitted", at: now() };
    await this.save(data);
    return id;
  }

  async finish(id, status) {
    const data = await this.read();
    const request = data.requests.find((r) => r.id === id);
    if (request) { request.execution = { ...request.execution, status, finishedAt: now() }; await this.save(data); }
  }

  /** Diagnostics reuse all frozen expectations, including legacy manually prepared cases. */
  async repair({ id, threadId, prompt, parent }) {
    const data = await this.read();
    const existing = data.requests.find((r) => r.id === id);
    if (existing) {
      if (existing.abandonedAt) throw new Error("此需求已废弃，请提出新的修改需求。");
      if (existing.threadId !== threadId || existing.prompt !== prompt) throw new Error("请求标识已用于另一条需求。");
      return existing;
    }
    const cases = (await this.suite()).filter((c) => c.enabled);
    if (!cases.length) return this.prepare({ id, threadId, prompt });
    const request = { id: text(id, 100, "请求标识"), threadId: text(threadId, 150, "会话标识"),
      prompt: text(prompt, 30000, "诊断"), status: "frozen", createdAt: now(), frozenAt: now(), repair: true,
      ...(parent ? { parent } : {}),
      cases: cases.map((item) => ({ item, requirement: item.title, current: "尚未验证", trigger: item.evidence })), clarifications: [] };
    data.requests.push(request); await this.save(data); return request;
  }
}
