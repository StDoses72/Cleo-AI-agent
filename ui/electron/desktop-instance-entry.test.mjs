import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const outcome of ["denied", "accepted"]) {
  test(`desktop initialization is gated by the actual entry's instance lock: ${outcome}`, () => {
    const result = JSON.parse(execFileSync(process.execPath, ["--experimental-vm-modules",
      fileURLToPath(new URL("../tests/fixtures/desktop-instance-entry.mjs", import.meta.url)), outcome],
    { encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
    assert.equal(result.accepted, outcome === "accepted");
  });
}
