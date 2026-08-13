import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BackendBridge } from "./backend.mjs";

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("legacy desktop profiles migrate into the canonical Cleo home", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-backend-home-"));
  const legacy = join(root, "roaming");
  const canonical = join(root, "local");
  const legacyConfig = join(legacy, "config");
  const canonicalConfig = join(canonical, "config");
  try {
    await mkdir(legacyConfig, { recursive: true });
    await mkdir(canonicalConfig, { recursive: true });
    await writeJson(join(legacyConfig, "cleo.json"), {
      profiles: { agents: { roaming: { model: "roaming-model" }, shared: { model: "old" } } },
    });
    await writeJson(join(canonicalConfig, "cleo.json"), {
      profiles: { agents: { local: { model: "local-model" }, shared: { model: "current" } } },
    });
    await writeJson(join(legacyConfig, "harnesses.json"), {
      providers: { claude: { type: "claude_sdk" } },
    });
    await writeJson(join(canonicalConfig, "harnesses.json"), {
      providers: { codex: { type: "codex_sdk" } },
    });

    const bridge = new BackendBridge({ app: {}, here: "" });
    bridge.migrateLegacyHome({ cleoHome: canonical, legacyCleoHome: legacy });

    const cleo = JSON.parse(await readFile(join(canonicalConfig, "cleo.json"), "utf8"));
    assert.deepEqual(Object.keys(cleo.profiles.agents).sort(), ["local", "roaming", "shared"]);
    assert.equal(cleo.profiles.agents.shared.model, "current");
    const harnesses = JSON.parse(
      await readFile(join(canonicalConfig, "harnesses.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(harnesses.providers).sort(), ["claude", "codex"]);
    assert.ok((await readFile(join(canonical, ".desktop-home-migrated-v1"), "utf8")).trim());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
