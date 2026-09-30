import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceFiles } from "./files.mjs";

async function workspace() {
  const base = await mkdtemp(join(tmpdir(), "cleo-files-"));
  const root = join(base, "project");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(base, "private"));
  await writeFile(join(root, "src", "app.ts"), "one\ntwo\nthree");
  await writeFile(join(root, "README.md"), "# Title");
  await writeFile(join(root, "index.html"), "<h1>hi</h1>");
  await writeFile(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
  await writeFile(join(base, "private", "secret.txt"), "secret");
  return { base, root };
}

test("lists and previews only files inside the registered workspace", async () => {
  const { base, root } = await workspace();
  const files = new WorkspaceFiles();
  const listing = await files.list(root, "");
  assert.deepEqual(listing.entries.map(item => item.path), ["src", "index.html", "logo.png", "README.md"].sort((a, b) =>
    (a === "src" ? -1 : b === "src" ? 1 : a.localeCompare(b))));
  const code = await files.read(root, "src/app.ts");
  assert.equal(code.kind, "text");
  assert.equal(code.text, "one\ntwo\nthree");
  assert.match(code.url, /^cleo-file:\/\/[a-f0-9]{24}\/src\/app\.ts$/);
  assert.equal((await files.read(root, "README.md")).kind, "markdown");
  assert.equal((await files.read(root, "index.html")).kind, "html");
  assert.equal((await files.read(root, "logo.png")).kind, "image");
  await assert.rejects(files.read(root, "../private/secret.txt"), /工作目录/);
  await assert.rejects(files.read(root, join(base, "private", "secret.txt")), /工作目录|找不到/);
  await assert.rejects(files.list("relative/path", ""), /绝对路径/);
});

test("links that point outside the workspace are refused", async t => {
  const { base, root } = await workspace();
  try {
    await symlink(join(base, "private"), join(root, "escape"), "junction");
  } catch {
    t.skip("junctions unavailable");
    return;
  }
  const files = new WorkspaceFiles();
  await assert.rejects(files.read(root, "escape/secret.txt"), /工作目录以外/);
  const response = await files.respond(new Request(`cleo-file://${(await files.register(root)).id}/escape/secret.txt`));
  assert.equal(response.status, 404);
});

test("chat links resolve to sidebar paths with line numbers", async () => {
  const { base, root } = await workspace();
  const files = new WorkspaceFiles();
  assert.deepEqual(await files.locate(root, "src/app.ts:2"), { path: "src/app.ts", line: 2 });
  assert.deepEqual(await files.locate(root, join(root, "README.md")), { path: "README.md", line: null });
  assert.equal(await files.locate(root, join(base, "private", "secret.txt")), null);
});

test("preview protocol serves same-origin responses for registered roots only", async () => {
  const { root } = await workspace();
  const files = new WorkspaceFiles();
  const { id } = await files.register(root);
  const page = await files.respond(new Request(`cleo-file://${id}/`));
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(page.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(await page.text(), "<h1>hi</h1>");
  assert.equal((await files.respond(new Request("cleo-file://0000/index.html"))).status, 404);
  assert.equal((await files.respond(new Request(`cleo-file://${id}/..%2F..%2Fprivate%2Fsecret.txt`))).status, 404);
});
