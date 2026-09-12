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

  async save(data) {
    await writeJson(this.path, data);
    this.onChange();
  }

  async suite() {
    const cases = await readJson(this.acceptance.path, []);
    if (!Array.isArray(cases) || cases.some((c) => !c || typeof c.id !== "string"
      || typeof c.expectation !== "string" || typeof c.enabled !== "boolean")) {
      throw new Error("已有验收案例格式无法读取，未覆盖。");
    }
    return cases;
  }

  /** Persist original input before calling any model. A frozen request is never regenerated. */
  async prepare({ id, threadId, prompt, clarification }) {
    text(id, 100, "请求标识"); text(threadId, 150, "会话标识"); text(prompt, 30000, "需求");
    const data = await this.read();
    let request = data.requests.find((r) => r.id === id);
    if (request && (request.prompt !== prompt || request.threadId !== threadId)) throw new Error("请求标识已用于另一条需求。");
    if (!request) {
      request = { id, threadId, prompt, status: "analyzing", createdAt: now(), cases: [], clarifications: [] };
      data.requests.push(request);
      await this.save(data);
    }
    if (request.status === "freezing") return this.freeze(data, request);
    if (["frozen", "answered"].includes(request.status)) return request;
    if (request.status === "clarification" && !clarification) return request;
    if (clarification) {
      if (request.status !== "clarification") throw new Error("当前需求不在等待澄清。请使用修正案例保留变更原因。");
      request.clarifications.push({ question: request.answer, answer: text(clarification, 5000, "补充说明"), at: now() });
    }
    this.running.add(id);
    try {
      request.status = "analyzing"; delete request.error;
      await this.save(data);
      const analysis = await this.analyze(threadId, prompt + request.clarifications.map((c) =>
        `\n澄清问题：${c.question}\n用户补充：${c.answer}`).join(""));
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
    if (!request || request.status !== "frozen") throw new Error("请先完成本轮验收准备。");
    const cases = await this.suite();
    for (const { item } of request.cases) {
      const saved = cases.find((c) => c.id === item.id && c.enabled);
      if (!saved || saved.expectation !== item.expectation || saved.evidence !== item.evidence)
        throw new Error("本轮案例已修正或归档，请使用更新后的案例。");
    }
    const enabled = cases.filter((c) => c.enabled);
    return `[[CLEO_ACCEPTANCE_REQUEST:${request.id}]]\n${request.prompt}\n`
      + (request.reason ? `用户调整原因：${request.reason}\n` : "")
      + (request.clarifications || []).map((c) => `补充：${c.answer}\n`).join("")
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
