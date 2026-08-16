import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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

test("desktop home receives user-editable AGENTS guidance without overwriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-backend-defaults-"));
  const defaultsRoot = join(root, "defaults");
  const cleoHome = join(root, "home");
  try {
    await mkdir(join(defaultsRoot, "config"), { recursive: true });
    await mkdir(join(defaultsRoot, "memory"), { recursive: true });
    await mkdir(join(defaultsRoot, "assets"), { recursive: true });
    await writeFile(join(defaultsRoot, "config", "cleo.json"), "{}\n", "utf8");
    await writeFile(join(defaultsRoot, "config", "harnesses.json"), "{}\n", "utf8");
    await writeFile(
      join(defaultsRoot, "memory", "MEMORY_POLICY.md"),
      "# Memory Policy\n",
      "utf8",
    );
    await writeFile(join(defaultsRoot, "assets", "startup.png"), "image", "utf8");
    await writeFile(join(defaultsRoot, "AGENTS.md"), "# Default Guidance\n", "utf8");
    await writeFile(join(defaultsRoot, "PERSONA.md"), "# Persona\n", "utf8");

    const bridge = new BackendBridge({ app: {}, here: "" });
    bridge.prepareHome({ cleoHome, defaultsRoot });
    assert.equal(await readFile(join(cleoHome, "AGENTS.md"), "utf8"), "# Default Guidance\n");

    await writeFile(join(cleoHome, "AGENTS.md"), "# My Guidance\n", "utf8");
    bridge.prepareHome({ cleoHome, defaultsRoot });
    assert.equal(await readFile(join(cleoHome, "AGENTS.md"), "utf8"), "# My Guidance\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows desktop backend discovers npm global commands", () => {
  const root = join(tmpdir(), "cleo-backend-path");
  const appData = join(root, "roaming");
  const python = join(root, "python", "python.exe");
  const systemPath = join(root, "system-bin");
  const bridge = new BackendBridge({ app: {}, here: "" });

  const runtimePath = bridge.runtimePath(
    { python, browserRoot: null },
    { APPDATA: appData, PATH: systemPath },
    "win32",
  );

  assert.equal(
    runtimePath,
    [join(dirname(python), "Scripts"), join(appData, "npm"), systemPath].join(delimiter),
  );
});
