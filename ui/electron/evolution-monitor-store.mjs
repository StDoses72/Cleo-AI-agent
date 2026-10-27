import { t as tr } from "./i18n.mjs";
import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { exists, readJson, writeJson } from "./evolution-store.mjs";

const identifier = value => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);

/** Purpose: Keep restart-time messages independent of either application process.
 * Input: owned evolution root. Output: append-only messages and separate delivery receipts.
 * A started receipt is never automatically replayed after a crash: effects may already exist.
 */
export class EvolutionMonitorStore {
  constructor(root) { this.root = join(root, "monitor"); }
  async publish(value) { await writeJson(join(this.root, "runtime.json"), { ...value, updatedAt: Date.now(), pid: process.pid }); }
  async runtime() { return await readJson(join(this.root, "runtime.json"), {}); }
  async command(action, threadId, params = {}) {
    if (!["stop", "discard", "rollback", "answer", "resume", "build", "apply", "save"].includes(action)) throw new Error(tr("evolution_companion.unsupported_evolution_action"));
    const command = { id: randomUUID(), action, threadId, params, createdAt: Date.now() };
    await writeJson(join(this.root, "commands", `${command.id}.json`), command);
    return command;
  }
  async commands() {
    const directory = join(this.root, "commands");
    await mkdir(directory, { recursive: true });
    const result = [];
    for (const name of await readdir(directory)) {
      if (!identifier(name.replace(/\.json$/, ""))) continue;
      const command = await readJson(join(directory, name));
      if (command) result.push({ ...command, ...await readJson(join(this.root, "command-results", name), {}) });
    }
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }
  async commandResult(id, status, detail = "") {
    if (!identifier(id)) throw new Error(tr("evolution_monitor_store.invalid_operation_id"));
    await writeJson(join(this.root, "command-results", `${id}.json`), { status, detail });
  }
  async pause(value) { await writeJson(join(this.root, "preferences.json"), { paused: value }); }
  async paused() { return (await readJson(join(this.root, "preferences.json"), {})).paused === true; }
  async message(id) {
    if (!identifier(id)) return null;
    return readJson(join(this.root, "messages", `${id}.json`));
  }
  async enqueue(threadId, body) {
    if (typeof threadId !== "string" || !threadId || threadId.length > 300) throw new Error(tr("evolution_monitor_store.start_a_conversation_in_evolution_first"));
    if (typeof body !== "string" || !body.trim() || body.length > 30000) throw new Error(tr("evolution_monitor_store.additional_requirements_must_contain_1_30_000_characters"));
    const message = { id: randomUUID(), threadId, body: body.trim(), createdAt: Date.now() };
    await writeJson(join(this.root, "messages", `${message.id}.json`), message);
    return message;
  }
  async receipt(id, status, detail = "") {
    if (!identifier(id)) throw new Error(tr("evolution_monitor_store.invalid_message_id"));
    await writeJson(join(this.root, "receipts", `${id}.json`), { id, status, detail, updatedAt: Date.now() });
  }
  async claim(id) {
    if (!identifier(id) || !await this.message(id)) throw new Error(tr("evolution_monitor_store.additional_message_not_found"));
    const claims = join(this.root, "claims");
    await mkdir(claims, { recursive: true });
    try { await mkdir(join(claims, id)); }
    catch (error) { if (error.code === "EEXIST") throw new Error(tr("evolution_monitor_store.this_message_was_already_submitted_check_the_conversation_first_to_avoid_executing_it")); throw error; }
    await this.receipt(id, "started");
  }
  async messages() {
    const directory = join(this.root, "messages");
    await mkdir(directory, { recursive: true });
    const messages = [];
    for (const name of await readdir(directory)) {
      const id = name.replace(/\.json$/, "");
      if (!identifier(id)) continue;
      const message = await this.message(id);
      if (!message) continue;
      const receipt = await readJson(join(this.root, "receipts", `${id}.json`));
      const claimed = await exists(join(this.root, "claims", id));
      messages.push({ ...message, status: receipt?.status || (claimed ? "started" : "queued"), detail: receipt?.detail || "" });
    }
    return messages.sort((a, b) => a.createdAt - b.createdAt);
  }
  async pending(threadId) { return (await this.messages()).find(item => item.status === "queued" && item.threadId === threadId) || null; }
}
