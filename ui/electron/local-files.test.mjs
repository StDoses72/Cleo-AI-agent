import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openLocalHref, resolveLocalHref } from "./local-files.mjs";

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

    assert.equal(result.path, page);
    assert.deepEqual(opened, [page]);
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
