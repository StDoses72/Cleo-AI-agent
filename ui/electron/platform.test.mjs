import assert from "node:assert/strict";
import test from "node:test";
import { bundledPython, desktopDataHome, desktopPlatform, harnessPath, installationRoot } from "./platform.mjs";

test("release names and application layouts are specific to OS and architecture", () => {
  const mac = desktopPlatform("darwin", "arm64");
  assert.equal(mac.archive, "Cleo-macos-arm64.zip");
  assert.equal(mac.manifest, "release-macos-arm64.json");
  assert.equal(installationRoot("/Applications/Cleo.app/Contents/MacOS/Cleo", mac), "/Applications/Cleo.app");
  assert.equal(desktopPlatform("darwin", "x64").manifest, "release-macos-x64.json");
  assert.equal(desktopPlatform("linux", "x64").archive, "Cleo-linux-x64.tar.gz");
  assert.equal(desktopPlatform("win32", "x64").manifest, "release.json");
  assert.throws(() => desktopPlatform("linux", "arm64"), /Unsupported/);
  assert.throws(() => installationRoot("/Applications/Cleo", mac), /layout/);
});

test("packaged Python paths and data homes agree with platform conventions", () => {
  assert.equal(bundledPython("C:\\Cleo\\resources", "win32"), "C:\\Cleo\\resources\\python\\python.exe");
  assert.equal(bundledPython("/Applications/Cleo.app/Contents/Resources", "darwin"),
    "/Applications/Cleo.app/Contents/Resources/python/bin/python3");
  assert.equal(desktopDataHome({ platform: "darwin", environment: {}, home: "/Users/test" }),
    "/Users/test/Library/Application Support/Cleo");
  assert.equal(desktopDataHome({ platform: "linux", environment: {}, home: "/home/test" }),
    "/home/test/.local/share/Cleo");
  assert.equal(desktopDataHome({ platform: "linux", environment: { XDG_DATA_HOME: "/data" }, home: "/home/test" }), "/data/Cleo");
  assert.equal(desktopDataHome({ platform: "linux", environment: { CLEO_HOME: "~/custom" }, home: "/home/test" }), "/home/test/custom");
});

test("Finder launches discover Homebrew and user CLI installations without running shell profiles", () => {
  const value = harnessPath({ python: "/App/python/bin/python3", browserRoot: "/App/browser" },
    { PATH: "/usr/bin:/bin" }, "darwin", "/Users/test");
  assert.equal(value.split(":")[0], "/App/python/bin");
  assert.ok(value.includes("/opt/homebrew/bin"));
  assert.ok(value.includes("/usr/local/bin"));
  assert.ok(value.includes("/Users/test/.local/bin"));
  assert.ok(!value.includes("Scripts") && !value.includes(";"));
});
