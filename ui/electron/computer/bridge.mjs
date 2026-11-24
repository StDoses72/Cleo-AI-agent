import { t as tr } from "../i18n.mjs";
/** Local, authenticated channel between Cleo's tool processes and the computer broker.
 *
 * No TCP port is opened. Windows uses a randomly named pipe; other systems use a Unix socket in
 * a private directory. The pipe name and a random token are written to a descriptor file whose
 * directory is readable only by the current user (and SYSTEM on Windows), so sandboxed commands
 * running as another account or with a restricted token cannot read it. Each request uses one
 * connection; closing the connection cancels the request. The one exception is a ``link`` from
 * the browser extension's native host: it authenticates with its own token, published in a
 * separate ``link-*.json`` descriptor that tool processes are never pointed at, and its
 * connection stays open carrying newline-delimited messages both ways (see user-browser.mjs).
 */

import { createServer } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const MAX_REQUEST_BYTES = 1024 * 1024;

/** Purpose: Restrict a directory to the current user. Input: path. Output: throws on failure. */
export function protectDirectory(directory, { platform = process.platform, exec = execFileSync } = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (platform !== "win32") {
    chmodSync(directory, 0o700);
    return;
  }
  // Absolute paths: a "whoami" or "icacls" earlier on PATH (for example Git's usr/bin) must not be used.
  const system32 = join(process.env.SystemRoot || process.env.windir || "C:\Windows", "System32");
  const output = exec(join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
  const sid = /"(S-1-[0-9-]+)"\s*$/m.exec(String(output).trim())?.[1];
  if (!sid) throw new Error(tr("bridge.could_not_identify_the_current_windows_user_computer_control_is_disabled"));
  // Remove inherited grants (for example sandbox capability or group ACEs on parent folders).
  exec(join(system32, "icacls.exe"), [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"],
    { encoding: "utf8", windowsHide: true });
}

export class ComputerBridge {
  /** Purpose: Scope a channel to one desktop instance. Input: private directory/handler.
   * Output: An independent descriptor which other instances cannot replace or remove.
   */
  constructor({ directory, handler, onLink = null, platform = process.platform, protect = protectDirectory }) {
    Object.assign(this, { directory, handler, onLink, platform, protect });
    this.server = null;
    this.token = randomBytes(32).toString("hex");
    this.linkToken = randomBytes(32).toString("hex");
    const suffix = `${process.pid}-${randomBytes(8).toString("hex")}`;
    this.descriptorPath = join(directory, `bridge-${suffix}.json`);
    this.linkDescriptorPath = join(directory, `link-${suffix}.json`);
    this.address = null;
    this.sockets = new Set();
  }

  /** Purpose: Publish this instance's authenticated channel before its backend starts.
   * Input: Constructor configuration. Output: Private descriptor path for this backend only.
   */
  async start() {
    this.protect(this.directory, { platform: this.platform });
    this.address = this.platform === "win32"
      ? `\\\\.\\pipe\\cleo-computer-${randomBytes(16).toString("hex")}`
      : join(this.directory, `bridge-${randomBytes(4).toString("hex")}.sock`);
    this.server = createServer(socket => this.connection(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.address, () => { this.server.off("error", reject); resolve(); });
    });
    if (this.platform !== "win32") chmodSync(this.address, 0o600);
    this.publish(this.descriptorPath, this.token);
    if (this.onLink) this.publish(this.linkDescriptorPath, this.linkToken);
    return this.descriptorPath;
  }

  publish(path, token) {
    const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({
      version: 1, transport: this.platform === "win32" ? "pipe" : "unix", address: this.address, token, pid: process.pid,
    })}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  }

  connection(socket) {
    this.sockets.add(socket);
    const abort = new AbortController();
    let buffer = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("close", () => {
      this.sockets.delete(socket);
      if (!abort.signal.aborted) abort.abort(new Error(tr("bridge.tool_call_cancelled")));
    });
    socket.on("error", () => {});
    socket.on("data", chunk => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) { handled = true; socket.destroy(); return; }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      void this.respond(socket, buffer.slice(0, newline), abort.signal, buffer.slice(newline + 1));
    });
  }

  authorized(token, expected = this.token) {
    if (typeof token !== "string" || token.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  }

  async respond(socket, line, signal, rest = "") {
    let request;
    let reply;
    try {
      request = JSON.parse(line);
      const link = request?.op === "link";
      // Each kind of client holds only its own token: a tool process cannot open a link.
      if (!this.authorized(request?.token, link ? this.linkToken : this.token) || (link && !this.onLink)) {
        reply = { ok: false, error: tr("bridge.computer_control_channel_authentication_failed") };
      } else if (link) {
        // The socket now belongs to the link; it is not answered and closed like a tool call.
        socket.removeAllListeners("data");
        this.onLink(socket, request, rest);
        return;
      } else {
        const content = await this.handler(request, signal);
        reply = { id: request.id, ok: true, content };
      }
    } catch (error) {
      reply = { id: request?.id, ok: false, error: String(error?.message || error || tr("bridge.computer_operation_failed")).slice(0, 2000) };
    }
    if (!socket.destroyed) socket.end(`${JSON.stringify(reply)}\n`);
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise(resolve => (this.server ? this.server.close(() => resolve()) : resolve()));
    rmSync(this.descriptorPath, { force: true });
    rmSync(this.linkDescriptorPath, { force: true });
  }
}
