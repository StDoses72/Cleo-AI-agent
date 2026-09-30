import test from "node:test";
import assert from "node:assert/strict";
import { developmentBundleDigest } from "./evolution.mjs";

test("backend-only source updates change the imported bundle identity", async () => {
  let backend = "backend-before";
  const filesystem = { readFile: async (path) => Buffer.from(
    path.endsWith("app.asar") ? "unchanged-ui" : backend
  ) };
  const first = await developmentBundleDigest("resources", filesystem);
  assert.equal(await developmentBundleDigest("resources", filesystem), first);
  backend = "backend-after";
  assert.notEqual(await developmentBundleDigest("resources", filesystem), first);
});

test("legacy bundles without source retain deterministic identity; read failures are not hidden", async () => {
  const filesystem = { readFile: async (path) => {
    if (path.endsWith("app.asar")) return Buffer.from("old-ui");
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  } };
  assert.equal(await developmentBundleDigest("resources", filesystem),
    await developmentBundleDigest("resources", filesystem));
  await assert.rejects(developmentBundleDigest("resources", {
    readFile: async (path) => {
      if (path.endsWith("app.asar")) return Buffer.from("old-ui");
      throw Object.assign(new Error("unreadable source"), { code: "EACCES" });
    },
  }), /unreadable source/);
});
