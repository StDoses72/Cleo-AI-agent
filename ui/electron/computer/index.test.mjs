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
      await ComputerUse.prototype.start.call({
        electron: { session: { defaultSession: { protocol: protocol("ui") } } },
        browser: { session: () => ({ protocol: protocol("browser") }) },
        files: { respond: () => {} },
        bridge: { start: async () => "test-bridge" },
      });
      assert.deepEqual(registrations, handled ? ["browser"] : ["browser", "ui"]);
    } finally {
      if (previousBridge === undefined) delete process.env.CLEO_COMPUTER_BRIDGE;
      else process.env.CLEO_COMPUTER_BRIDGE = previousBridge;
    }
  });
}
