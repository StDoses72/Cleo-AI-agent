import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readJson, writeJson } from "./evolution-store.mjs";

const terminal = new Set(["completed", "failed", "cancelled"]);
export const releaseRunning = job => Boolean(job && !terminal.has(job.phase));

/** Purpose: Keep publication alive outside renderer dialogs and independent of the editing lock.
 * Input: private journal, release driver and notification callback. Output: resumable, bounded release jobs.
 */
export class ReleaseJobs {
  constructor(root, driver, { onChange = () => {}, interval = 20000 } = {}) {
    this.path = join(root, "release-job-v1.json");
    this.driver = driver; this.onChange = onChange; this.interval = interval;
    this.pending = null; this.starting = false; this.closing = false;
  }

  async status() {
    const job = await readJson(this.path);
    if (job && (job.schema !== 1 || typeof job.id !== "string" || typeof job.phase !== "string"))
      throw new Error("发布任务记录无法读取，已保留原文件。");
    return job;
  }

  async save(job, values) {
    Object.assign(job, values, { updatedAt: new Date().toISOString() });
    await writeJson(this.path, job);
    this.onChange();
  }

  async start(params) {
    if (this.closing || this.starting) throw new Error("正在准备发布，请稍候。");
    this.starting = true;
    try {
      const existing = await this.status();
      if (existing?.phase === "failed") throw new Error("上一发布任务尚未完成，请先继续或停止该任务，再创建新的发布。");
      if (releaseRunning(existing)) {
        if (existing.tag !== String(params.tag).trim().replace(/^v?/, "v") || existing.url !== params.url) throw new Error("已有发布任务正在进行。");
        this.launch(existing); return existing;
      }
      const selection = await this.driver.authorize(params);
      const job = { schema: 1, id: randomUUID(), ...selection, phase: "preparing", attempt: 0,
        message: "正在准备发布源码", createdAt: new Date().toISOString() };
      await this.save(job, {});
      this.launch(job);
      return job;
    } finally { this.starting = false; }
  }

  /** Purpose: Resume only an already authorized job, retaining its refs and repair budget.
   * Input: explicit retry flag. Output: one background worker; duplicate launches coalesce.
   */
  async resume(retry = false) {
    const job = await this.status();
    if (!job || job.phase === "completed" || job.phase === "cancelled") return job;
    if (job.phase === "failed" && !retry) return job;
    if (retry && !this.pending) await this.save(job, { phase: job.resumePhase || "preparing", error: null });
    this.launch(job); return job;
  }

  launch(job) {
    if (this.pending || this.closing || !releaseRunning(job)) return;
    this.abort = new AbortController();
    this.pending = this.drive(job, this.abort.signal).catch(async error => {
      if (this.closing) {
        await this.save(job, { message: "发布已暂停，下次启动继续" });
      } else if (this.abort.signal.aborted) {
        await this.save(job, { phase: "cancelled", message: "发布已停止，已生成的产物保留" });
      } else {
        await this.save(job, { resumePhase: job.phase, phase: "failed", error: String(error.message).slice(-4000),
          message: "发布未完成，可查看原因后继续" });
      }
    }).finally(() => { this.pending = null; });
  }

  async drive(job, signal) {
    while (!terminal.has(job.phase)) {
      signal.throwIfAborted();
      const checkpoint = values => this.save(job, values);
      if (job.phase === "preparing") {
        await checkpoint(await this.driver.prepare(job, signal, checkpoint));
        await checkpoint({ phase: "building", message: "正在构建 Windows、macOS 和 Linux 安装包" });
      } else if (job.phase === "building" || job.phase === "publishing") {
        const publishing = job.phase === "publishing";
        const result = await this.driver.poll(job, publishing, signal, checkpoint);
        if (result.status === "running") {
          if (result.message) await checkpoint({ message: result.message });
          await delay(this.interval, undefined, { signal });
        } else if (result.status === "success") {
          if (publishing) {
            const verified = await this.driver.verify(job, signal);
            await checkpoint({ ...verified, phase: "completed", message: `${job.tag} 已发布，安装包已齐全` });
          } else {
            await checkpoint({ phase: "publishing", retryRun: null, message: "正在校验并发布安装包" });
          }
        } else {
          if (job.attempt >= 3) throw new Error("自动修复已尝试三次仍未通过。请查看构建日志；不会公开不完整的版本。");
          await checkpoint({ phase: "repairing", retryRun: null, repairPhase: publishing ? "publishing" : "building",
            diagnostics: result.diagnostics, attempt: job.attempt + 1,
            message: `正在调用 ${job.runtime?.provider || "harness"} 修复发布问题（${job.attempt + 1}/3）` });
        }
      } else if (job.phase === "repairing") {
        const repair = await this.driver.repair(job, signal, checkpoint);
        await checkpoint({ ...repair, repairResult: null, diagnostics: null, phase: repair.changed ? "building" : job.repairPhase,
          message: "修复检查已完成，正在重新验证" });
      } else throw new Error(`无法恢复发布阶段：${job.phase}`);
    }
  }

  async cancel() {
    const job = await this.status();
    if (!job || ["completed", "cancelled"].includes(job.phase)) return job;
    this.abort?.abort();
    await this.pending;
    const latest = await this.status();
    try { await this.driver.cancel?.(latest); }
    catch (error) {
      await this.save(latest, { phase: "failed", resumePhase: job.phase,
        message: "本机发布已停止，远端停止状态待核对", error: error.message });
      throw error;
    }
    if (latest.phase !== "completed") await this.save(latest, { phase: "cancelled", message: "发布已停止，已生成的产物保留" });
    return this.status();
  }

  async close() {
    this.closing = true;
    this.abort?.abort();
    await this.pending;
  }
}
