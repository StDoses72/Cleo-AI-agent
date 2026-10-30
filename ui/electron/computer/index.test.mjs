import assert from "node:assert/strict";
import test from "node:test";
import { ComputerUse } from "./index.mjs";
import { FILE_SCHEME } from "./schemes.mjs";

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
