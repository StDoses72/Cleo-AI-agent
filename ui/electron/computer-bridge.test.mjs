import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ComputerBridge } from "./computer/bridge.mjs";

/** Purpose: Send an authenticated fixture request. Input: private descriptor. Output: reply. */
async function probe(path, tokenOverride) {
  const descriptor = JSON.parse(await readFile(path, "utf8"));
  return new Promise((accept, reject) => {
    const socket = createConnection(descriptor.address);
    socket.setTimeout(3000, () => socket.destroy(new Error("Fixture bridge timed out")));
    socket.on("error", reject);
    let result = "";
    socket.on("data", chunk => { result += chunk; });
    socket.on("end", () => { try { accept(JSON.parse(result)); } catch (error) { reject(error); } });
    socket.on("connect", () => socket.write(JSON.stringify({
      id: "fixture", op: "tools", token: tokenOverride ?? descriptor.token,
    }) + "\n"));
  });
}

/** Purpose: Isolate channel tests. Input: test callback. Output: cleanup of owned fixtures only. */
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "cleo-bridge-owner-"));
  const bridges = [];
  const create = label => {
    const bridge = new ComputerBridge({ directory: root, protect: () => {},
      handler: async () => [{ type: "text", text: label }] });
    bridges.push(bridge);
    return bridge;
  };
  try { await run({ root, create }); }
  finally {
    for (const bridge of bridges) await bridge.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
    await rm(root, { recursive: true, force: true });
  }
}

test("each desktop instance retains its own authenticated bridge descriptor", async () => {
  await fixture(async ({ create }) => {
    const first = create("first");
    const firstPath = await first.start();
    const initial = await readFile(firstPath, "utf8");
    const second = create("second");
    const secondPath = await second.start();
    assert.notEqual(firstPath, secondPath, "Another instance must not publish over this descriptor");
    assert.ok(await readFile(firstPath, "utf8") === initial, "Private descriptor must remain unchanged");
    assert.equal((await probe(firstPath)).content[0].text, "first");
    assert.equal((await probe(secondPath)).content[0].text, "second");
    assert.equal((await probe(firstPath, "invalid-token")).ok, false);
    await first.close();
    assert.equal((await probe(secondPath)).content[0].text, "second");
  });
});

test("a second process crashing cannot redirect the running desktop to a dead channel", async () => {
  await fixture(async ({ root, create }) => {
    const firstPath = await create("running-desktop").start();
    const initial = await readFile(firstPath, "utf8");
    const child = spawn(process.execPath, [fileURLToPath(new URL(
      "../tests/fixtures/computer-bridge-child.mjs", import.meta.url)), root],
    { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
    const exited = once(child, "exit");
    try {
      await Promise.race([once(child, "message"), exited.then(() => { throw new Error("Fixture exited early"); })]);
      child.kill();
      await exited;
      assert.ok(await readFile(firstPath, "utf8") === initial,
        "An abruptly exited secondary instance must not leave its descriptor in the primary's path");
      assert.equal((await probe(firstPath)).content[0].text, "running-desktop");
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    }
  });
});

test("repeated shutdown of an old bridge cannot remove the new bridge's descriptor", async () => {
  await fixture(async ({ create }) => {
    const previous = create("previous");
    await previous.start();
    await previous.close();
    const nextPath = await create("new").start();
    await previous.close();
    assert.equal((await probe(nextPath)).content[0].text, "new");
  });
});
