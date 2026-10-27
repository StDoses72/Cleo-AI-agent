import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import uiMessages from "./locales.json" with { type: "json" };
import recoveryMessages from "./recovery-locales.json" with { type: "json" };
import { getLanguage, relativeTime, setLanguage, subscribeLanguage, t } from "./i18n.mjs";
const messages = { ...uiMessages, ...recoveryMessages };

test("every interface message has both languages and matching interpolation parameters", () => {
  assert.ok(Object.keys(uiMessages).every(key => !Object.hasOwn(recoveryMessages, key)));
  const parameters = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const [key, value] of Object.entries(messages)) {
    assert.deepEqual(Object.keys(value).sort(), ["en", "zh-CN"], key);
    assert.equal(typeof value.en, "string", key);
    assert.equal(typeof value["zh-CN"], "string", key);
    assert.deepEqual(parameters(value.en), parameters(value["zh-CN"]), key);
    if (value["zh-CN"] !== "简体中文") assert.doesNotMatch(value.en, /[\u3400-\u9fff]/, key);
  }
});

test("language changes are explicit and interpolation never translates parameter values", () => {
  let notifications = 0;
  const unsubscribe = subscribeLanguage(() => notifications++);
  try {
    setLanguage("en");
    assert.equal(t("settings.language"), "Language");
    assert.equal(relativeTime(1, "minute"), "1 minute ago");
    assert.equal(relativeTime(2, "minute"), "2 minutes ago");
    assert.throws(() => setLanguage("system"), /Unsupported UI language/);
    assert.equal(getLanguage(), "en");
    const [key] = Object.entries(messages).find(([, value]) => value.en.includes("{p0}"));
    assert.ok(t(key, { p0: "用户原文 {p1}" }).includes("用户原文 {p1}"));
    setLanguage("zh-CN");
    assert.equal(t("settings.language"), "语言");
    assert.equal(notifications, 2);
  } finally { unsubscribe(); setLanguage("zh-CN"); }
});

test("production translation references exist, including native window labels", async () => {
  async function files(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory()
      ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
  }
  const here = dirname(fileURLToPath(import.meta.url));
  for (const path of [...await files(here), ...await files(join(here, "../src"))]) {
    if (!/\.(mjs|cjs|js|ts|tsx|html)$/.test(path) || path.includes(".test.")) continue;
    const source = await readFile(path, "utf8");
    const references = [...source.matchAll(/\b(?:tr|t)\(\s*["']([^"']+)["']/g),
      ...source.matchAll(/data-i18n(?:-(?:title|aria-label|placeholder))?="([^"]+)"/g)];
    for (const match of references) assert.ok(Object.hasOwn(messages, match[1]), `${path}: ${match[1]}`);
  }
});
