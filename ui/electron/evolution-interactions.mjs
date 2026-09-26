import { join } from "node:path";
import { readJson, writeJson } from "./evolution-store.mjs";

/** Separate additive journal: older suite/report writers never own these records. */
export class EvolutionInteractions {
  constructor(store) { this.path = join(store.root, "acceptance", "interactions-v1.json"); }

  /** Read without treating unknown/newer or corrupt data as an empty journal. */
  async read() {
    const data = await readJson(this.path, { schema: 1, feedback: [], confirmations: [], completions: [] });
    if (data?.schema !== 1 || ![data.feedback, data.confirmations, data.completions].every(Array.isArray)
      || data.feedback.some((f) => !f || typeof f.id !== "string" || typeof f.caseId !== "string" || typeof f.body !== "string")
      || data.confirmations.some((c) => !c || typeof c.id !== "string" || typeof c.skipped !== "boolean")
      || data.completions.some((c) => !c || typeof c.id !== "string" || typeof c.note !== "string" || typeof c.candidate !== "string"))
      throw new Error("验收交互记录格式无法读取；保留原文件，未覆盖。");
    return data;
  }

  /** Append idempotently, preserving unknown fields at every existing level. */
  async append(collection, record) {
    const data = await this.read();
    const previous = data[collection].find((item) => item.id === record.id);
    if (previous) {
      for (const [key, value] of Object.entries(record)) {
        if (key !== "at" && JSON.stringify(previous[key]) !== JSON.stringify(value))
          throw new Error("交互标识已用于不同内容。");
      }
      return previous;
    }
    data[collection].push({ ...record, at: new Date().toISOString() });
    await writeJson(this.path, data);
    return record;
  }
}
