import assert from "node:assert/strict";
import test from "node:test";
import { detectTarget, downloadLinks, releaseInfo, TARGETS } from "../site/targets.mjs";

for (const [platform, architecture, target] of [
  ["Windows", "x86", "windows-x64"], ["macOS", "arm", "macos-arm64"],
  ["macOS", "x86", "macos-x64"], ["Linux", "x86", "linux-x64"],
]) {
  test(`browser architecture hints select ${target}`, () => {
    assert.equal(detectTarget({ hints: { platform, architecture, bitness: "64" } }).target, target);
  });
}
test("32-bit Windows browsers can identify a 64-bit OS through wow64", () => {
  assert.equal(detectTarget({ hints: { platform: "Windows", architecture: "x86", bitness: "32", wow64: true } }).target, "windows-x64");
});
test("Safari's Intel Mac user agent does not establish Intel hardware", () => {
  const value = detectTarget({ platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15" });
  assert.equal(value.os, "macos");
  assert.equal(value.target, null);
});
test("unsupported ARM and 32-bit systems never default to x64", () => {
  for (const platform of ["Windows", "Linux"]) {
    assert.equal(detectTarget({ hints: { platform, architecture: "arm", bitness: "64" }, userAgent: "Win64; x64" }).target, null);
    assert.equal(detectTarget({ hints: { platform, architecture: "x86", bitness: "32" } }).target, null);
  }
  assert.equal(detectTarget({ platform: "Linux aarch64", userAgent: "X11; Linux aarch64" }).target, null);
});
test("desktop UA fallback and denied hints preserve useful platform selection", () => {
  assert.equal(detectTarget({ platform: "Win32", userAgent: "Windows NT 10.0; Win64; x64" }).target, "windows-x64");
  assert.equal(detectTarget({ platform: "Linux x86_64", userAgent: "X11; Linux x86_64" }).target, "linux-x64");
  assert.equal(detectTarget({ hints: { platform: "macOS" } }).target, null);
});
test("Android and iPad desktop mode are not mistaken for supported desktops", () => {
  assert.equal(detectTarget({ userAgent: "Linux; Android 15; x86_64", platform: "Linux" }).os, "mobile");
  assert.equal(detectTarget({ userAgent: "Macintosh; Intel Mac OS X", platform: "MacIntel", maxTouchPoints: 5 }).os, "mobile");
});
test("downloads stay pinned to one release and require both the package and checksum", () => {
  const release = releaseInfo({ tag_name: "v0.3.0", assets: Object.values(TARGETS).flatMap(({ file, checksum }) => [
    { name: file, size: 123 }, { name: checksum, size: 90 },
  ]) });
  for (const target of Object.keys(TARGETS)) {
    const links = downloadLinks(target, release);
    assert.equal(links.archive, `https://github.com/StDoses72/Cleo-AI-agent/releases/download/v0.3.0/${TARGETS[target].file}`);
    assert.equal(links.bytes, 123);
  }
  release.assets.delete(TARGETS["linux-x64"].checksum);
  assert.equal(downloadLinks("linux-x64", release), null);
  assert.equal(downloadLinks("unsupported", release), null);
  assert.match(downloadLinks("windows-x64").archive, /releases\/latest\/download\/Cleo-windows-x64.zip$/);
  for (const value of [{ tag_name: "https://other.test", assets: [] }, { tag_name: "v0.3.0", prerelease: true, assets: [] }]) {
    assert.throws(() => releaseInfo(value));
  }
});
