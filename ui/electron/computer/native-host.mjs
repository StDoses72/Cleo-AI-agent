/** Native messaging host for the Cleo browser extension.
 *
 * Chrome or Edge starts this process when the extension connects (stdin/stdout carry messages
 * framed by a 4-byte little-endian length). It relays every message to the running Cleo desktop
 * app over Cleo's private computer channel (a named pipe or Unix socket plus a token, found in
 * the descriptor directory named by host-config.json) and relays Cleo's requests back. While
 * Cleo is not running it waits and retries; it exits when the browser closes the connection.
 * Nothing but framed messages may be written to stdout.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RETRY_MS = 2000;
// A link that Cleo closes at once (another browser is connected, or the user disconnected this
// one) is retried with growing pauses instead of every two seconds.
const MAX_RETRY_MS = 60_000;
const SHORT_LINK_MS = 3000;
const MAX_MESSAGE = 64 * 1024 * 1024;

/** Purpose: Split native-messaging frames. Input: buffered bytes. Output: messages and rest. */
export function readFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const size = buffer.readUInt32LE(offset);
    if (size > MAX_MESSAGE) throw new Error("native message too large");
    if (buffer.length - offset - 4 < size) break;
    messages.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + size).toString("utf8")));
    offset += 4 + size;
  }
  return { messages, rest: buffer.subarray(offset) };
}

export function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

/** Purpose: The newest running Cleo instance's channel. Input: descriptor directory. */
export function findCleo(directory, { isAlive = alive } = {}) {
  let names;
  try { names = readdirSync(directory); } catch { return null; }
  const candidates = [];
  for (const name of names) {
    if (!/^link-\d+-[a-f0-9]+\.json$/.test(name)) continue;
    const path = join(directory, name);
    try {
      const descriptor = JSON.parse(readFileSync(path, "utf8"));
      if (descriptor?.version !== 1 || !descriptor.address || !descriptor.token || !isAlive(descriptor.pid)) continue;
      candidates.push({ descriptor, mtime: statSync(path).mtimeMs });
    } catch { /* Being written or removed. */ }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.descriptor ?? null;
}

export function runHost({ stdin = process.stdin, stdout = process.stdout, directory, connect = createConnection, exit = code => process.exit(code) }) {
  let hello = null;
  let socket = null;
  let inbound = Buffer.alloc(0);
  let timer = null;
  let closed = false;
  let retry = RETRY_MS;
  const toBrowser = message => { if (!closed) stdout.write(frame(message)); };

  const toCleo = message => {
    if (socket && !socket.destroyed && socket.linked) socket.write(`${JSON.stringify(message)}\n`);
    else if (message?.type === "response") return;
  };

  const linkCleo = () => {
    timer = null;
    if (closed || socket || !hello) return;
    const descriptor = findCleo(directory);
    if (!descriptor) { timer = setTimeout(linkCleo, RETRY_MS); return; }
    const current = connect(descriptor.address);
    socket = current;
    let buffer = "";
    let linkedAt = 0;
    current.setEncoding("utf8");
    current.on("connect", () => {
      current.write(`${JSON.stringify({ token: descriptor.token, op: "link", hello })}\n`);
      current.linked = true;
      linkedAt = Date.now();
      toBrowser({ type: "status", cleo: true });
    });
    current.on("data", chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try { toBrowser(JSON.parse(line)); } catch { /* Ignore malformed lines. */ }
      }
    });
    const lost = () => {
      if (socket !== current) return;
      socket = null;
      toBrowser({ type: "status", cleo: false });
      retry = linkedAt && Date.now() - linkedAt < SHORT_LINK_MS ? Math.min(retry * 2, MAX_RETRY_MS) : RETRY_MS;
      if (!closed) timer = setTimeout(linkCleo, retry);
    };
    current.on("error", lost);
    current.on("close", lost);
  };

  stdin.on("data", chunk => {
    inbound = Buffer.concat([inbound, chunk]);
    let parsed;
    try { parsed = readFrames(inbound); } catch { exit(1); return; }
    inbound = parsed.rest;
    for (const message of parsed.messages) {
      if (message?.type === "hello") {
        hello = message;
        if (!socket && !timer) linkCleo();
      } else {
        toCleo(message);
      }
    }
  });
  stdin.on("end", () => {
    closed = true;
    clearTimeout(timer);
    socket?.destroy();
    exit(0);
  });
  return { close: () => { closed = true; clearTimeout(timer); socket?.destroy(); } };
}

// The launcher Cleo writes passes this flag; importing the module (tests) runs nothing.
if (process.argv.includes("--cleo-native-host")) {
  const here = dirname(fileURLToPath(import.meta.url));
  const config = JSON.parse(readFileSync(join(here, "host-config.json"), "utf8"));
  runHost({ directory: config.bridgeDirectory });
}
