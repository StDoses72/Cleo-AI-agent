import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EvolutionTools, run } from "./evolution-tools.mjs";

test("managed Node accepts the macOS arm64 identifier from the Node release index", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "cleo-evolution-tools-"));
  const originalFetch = globalThis.fetch;
  try {
    const version = "v24.99.0";
    const name = `node-${version}-darwin-arm64`;
    const fixture = join(temporary, "fixture", name);
    await mkdir(join(fixture, "bin"), { recursive: true });
    await mkdir(join(fixture, "lib/node_modules/npm/bin"), { recursive: true });
    await writeFile(join(fixture, "bin/node"), "fixture node");
    await writeFile(join(fixture, "lib/node_modules/npm/bin/npm-cli.js"), "fixture npm");

    const archive = join(temporary, `${name}.tar.gz`);
    await run("tar", ["-czf", archive, "-C", join(temporary, "fixture"), name]);
    const archiveBytes = await readFile(archive);
    const digest = createHash("sha256").update(archiveBytes).digest("hex");

    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.endsWith("/dist/index.json")) {
        return new Response(JSON.stringify([{ version, lts: "Krypton", files: ["osx-arm64-tar"] }]));
      }
      if (href.endsWith(`/${version}/SHASUMS256.txt`)) {
        return new Response(`${digest}  ${name}.tar.gz\n`);
      }
      if (href.endsWith(`/${version}/${name}.tar.gz`)) return new Response(archiveBytes);
      throw new Error(`Unexpected URL: ${href}`);
    };

    const installed = await new EvolutionTools(join(temporary, "managed")).node();
    assert.equal(await readFile(installed.node, "utf8"), "fixture node");
    assert.equal(await readFile(installed.npm, "utf8"), "fixture npm");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(temporary, { recursive: true, force: true });
  }
});
