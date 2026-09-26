import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

test("files outside the workspace open from relative, absolute, and file URL links", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-outside-links-"));
  try {
    const workspace = join(root, "project");
    const page = join(root, "报告 100%.md");
    await mkdir(workspace);
    await writeFile(page, "report");
    const opened = [];
    const shellAdapter = { openPath: async (path) => { opened.push(path); return ""; } };
    const links = [
      ["../报告%20100%25.md", workspace],
      [encodeURI(page) + ":12:3", workspace],
      [pathToFileURL(page).href, ""],
      [encodeURI(page), join(root, "missing-project")],
      [encodeURI(page), ""],
    ];
    for (const [href, workspacePath] of links) {
      const result = await openLocalHref({ href, workspacePath, shellAdapter });
      assert.equal(result.path, await realpath(page));
    }
    assert.equal(opened.length, links.length);
    assert.throws(() => resolveLocalHref("report.md", ""), /没有关联工作目录/);
  } finally { await rm(root, { recursive: true, force: true }); }
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

test("Windows drive links with a leading slash open the actual file", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-drive-links-"));
  try {
    const page = join(root, "报告 file.md");
    await writeFile(page, "report");
    const href = "/" + encodeURI(page.replaceAll("\\", "/"));
    const opened = [];
    for (const suffix of ["", ":12", ":12:3", "#L12"]) {
      const result = await openLocalHref({ href: href + suffix, workspacePath: "",
        shellAdapter: { openPath: async (path) => { opened.push(path); return ""; } } });
      assert.equal(result.path, await realpath(page));
    }
    assert.equal(opened.length, 4);
    assert.equal(resolveLocalHref("/D:/example/README.md", "C:\\elsewhere").candidate,
      "D:\\example\\README.md");
    assert.equal(resolveLocalHref("//server/share/report.md", "").candidate,
      "\\\\server\\share\\report.md");
  } finally { await rm(root, { recursive: true, force: true }); }
});
