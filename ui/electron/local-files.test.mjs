import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openLocalHref, resolveLocalHref } from "./local-files.mjs";

test("application bundles and Linux desktop launchers are not opened as documents", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-platform-links-"));
  try {
    await mkdir(join(root, "Example.app"));
    await writeFile(join(root, "example.desktop"), "[Desktop Entry]\n");
    for (const href of ["Example.app", "example.desktop"]) {
      await assert.rejects(openLocalHref({ href, workspacePath: root,
        shellAdapter: { openPath: async () => assert.fail("must not launch") } }), /不能直接运行/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("POSIX executable files without extensions cannot launch from a message link", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-executable-link-"));
  try {
    await writeFile(join(root, "program"), "#!/bin/sh\nexit 0\n");
    await chmod(join(root, "program"), 0o755);
    await assert.rejects(openLocalHref({ href: "program", workspacePath: root,
      shellAdapter: { openPath: async () => assert.fail("must not launch") } }), /不能直接运行/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("relative Markdown links resolve inside the active workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-local-link-"));
  const site = join(root, "site");
  const page = join(site, "index.html");
  const opened = [];
  try {
    await mkdir(site);
    await writeFile(page, "<!doctype html>", "utf8");
    const result = await openLocalHref({
      href: "site/index.html#work",
      workspacePath: root,
      shellAdapter: { openPath: async (path) => { opened.push(path); return ""; } },
    });

    assert.equal(result.path, await realpath(page));
    assert.deepEqual(opened, [await realpath(page)]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex file links ignore trailing line and column numbers", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-local-link-location-"));
  const page = join(root, "index.html");
  const opened = [];
  try {
    await writeFile(page, "<!doctype html>", "utf8");
    const lineResult = await openLocalHref({
      href: `${page}:82`,
      workspacePath: root,
      shellAdapter: { openPath: async (path) => { opened.push(path); return ""; } },
    });
    const columnResult = await openLocalHref({
      href: `${page}:82:4`,
      workspacePath: root,
      shellAdapter: { openPath: async (path) => { opened.push(path); return ""; } },
    });

    const canonical = await realpath(page);
    assert.equal(lineResult.path, canonical);
    assert.equal(columnResult.path, canonical);
    assert.deepEqual(opened, [canonical, canonical]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local links cannot escape the active workspace", () => {
  const workspace = join(tmpdir(), "cleo-workspace");
  assert.throws(
    () => resolveLocalHref("../outside.html", workspace),
    /只能打开当前项目目录中的文件/,
  );
});

test("missing files and executable links return useful errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-local-link-errors-"));
  try {
    await assert.rejects(
      openLocalHref({
        href: "missing.html",
        workspacePath: root,
        shellAdapter: { openPath: async () => "" },
      }),
      /找不到文件：missing\.html/,
    );

    await writeFile(join(root, "setup.cmd"), "exit /b 0", "utf8");
    await assert.rejects(
      openLocalHref({
        href: "setup.cmd",
        workspacePath: root,
        shellAdapter: { openPath: async () => "" },
      }),
      /不能直接运行程序或脚本/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
