import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readUiLanguage } from "./language.mjs";

test("startup reads an explicit language from the shared runtime, independent of OS locale", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-language-"));
  try {
    assert.equal(await readUiLanguage(root, { LANG: "en_US.UTF-8" }), "zh-CN");
    await mkdir(join(root, "data"));
    await writeFile(join(root, "data/runtime.json"), JSON.stringify({ ui_language: "en", current_thread_id: "keep" }));
    assert.equal(await readUiLanguage(root, { LANG: "zh_CN.UTF-8" }), "en");
    assert.equal(await readUiLanguage(join(root, "another-program-version"), { CLEO_HOME: root }), "en");
    await writeFile(join(root, "data/runtime.json"), JSON.stringify({ ui_language: "system" }));
    assert.equal(await readUiLanguage(root, {}), "zh-CN");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup honors the active directory profile and configured runtime path", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-language-"));
  try {
    await mkdir(join(root, "custom"));
    await writeFile(join(root, "cleo-test.json"), JSON.stringify({ active_profiles: { directory: "custom" },
      profiles: { directories: { custom: { root_dir: "custom", runtime_state_path: "saved.json" } } } }));
    await writeFile(join(root, "custom/saved.json"), '\ufeff' + JSON.stringify({ ui_language: "en" }));
    assert.equal(await readUiLanguage(root, { CLEO_CONFIG_PATH: "cleo-test.json" }), "en");
  } finally { await rm(root, { recursive: true, force: true }); }
});
