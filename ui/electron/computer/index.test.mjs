import assert from "node:assert/strict";
import test from "node:test";
import { ComputerUse } from "./index.mjs";
import { FILE_SCHEME } from "./schemes.mjs";

test("a viewport report without a conversation hides the shown browser and leaves panel actions without a target", () => {
  const foregrounds = [];
  const viewports = [];
  const browser = {
    foregroundId: "thread-a",
    setForeground(threadId) { this.foregroundId = threadId; foregrounds.push(threadId); },
    setViewport(rect) { viewports.push(rect); },
  };
  const window = { webContents: { getZoomFactor: () => 1 } };
  const rect = { x: 10, y: 20, width: 300, height: 200 };
  ComputerUse.prototype.setViewport.call({ browser }, window, rect, "thread-b");
  assert.deepEqual(foregrounds, ["thread-b"], "a named conversation becomes the foreground");
  ComputerUse.prototype.setViewport.call({ browser }, window, rect, null);
  assert.deepEqual(foregrounds, ["thread-b", null], "no conversation selected clears the foreground");
  assert.deepEqual(viewports.at(-1), rect, "the viewport itself is still placed");
  assert.throws(() => ComputerUse.prototype.threadFor.call({ browser }, {}), /选择|select/i,
    "address bar and tab actions have no conversation to fall back to");
  assert.equal(ComputerUse.prototype.threadFor.call({ browser }, { threadId: "thread-c" }), "thread-c");
});

for (const handled of [false, true]) {
  test(`workspace previews register in the UI session when handled=${handled}`, async () => {
    const registrations = [];
    const protocol = name => ({
      async isProtocolHandled(scheme) { assert.equal(scheme, FILE_SCHEME); return handled; },
      handle(scheme, handler) { registrations.push(name); assert.equal(scheme, FILE_SCHEME); assert.equal(typeof handler, "function"); },
    });
    const previousBridge = process.env.CLEO_COMPUTER_BRIDGE;
    try {
      let reclaim = null;
      await ComputerUse.prototype.start.call({
        electron: { session: { defaultSession: { protocol: protocol("ui") } } },
        browser: { registerProtocol: (scheme, handler) => { registrations.push("browser"); assert.equal(scheme, FILE_SCHEME); assert.equal(typeof handler, "function"); },
          startIdleReclaim: options => { reclaim = options; } },
        broker: { threadBusy: () => false },
        files: { respond: () => {} },
        bridge: { start: async () => "test-bridge" },
      });
      assert.equal(typeof reclaim?.busy, "function", "idle reclaim starts with the broker's busy check");
      assert.deepEqual(registrations, handled ? ["browser"] : ["browser", "ui"]);
    } finally {
      if (previousBridge === undefined) delete process.env.CLEO_COMPUTER_BRIDGE;
      else process.env.CLEO_COMPUTER_BRIDGE = previousBridge;
    }
  });
}
