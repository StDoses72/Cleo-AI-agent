/** Workspace file access for the Files sidebar and built-in browser previews.
 *
 * Every request names a workspace root registered by Cleo's own UI. Paths are resolved to real
 * paths and must stay inside that root's real path, so symlinks and ".." cannot escape. Remote
 * pages never receive these capabilities: previews use an unguessable root id and responses are
 * limited to the same origin.
 */

import { open, readdir, realpath, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { resolveLocalHref } from "../local-files.mjs";
import { FILE_SCHEME } from "./schemes.mjs";

export { FILE_SCHEME };
const MAX_TEXT = 1024 * 1024;
const MAX_ENTRIES = 2000;

const MIME = {
  ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".ico": "image/x-icon", ".avif": "image/avif",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".xml": "application/xml",
  ".wasm": "application/wasm", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".csv": "text/csv",
};
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif", ".svg"]);
const MARKDOWN = new Set([".md", ".markdown", ".mdx"]);

function inside(root, target) {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path) && path.split(sep)[0] !== "..");
}

function posix(path) { return path.split(sep).join("/"); }

export class WorkspaceFiles {
  constructor() {
    this.roots = new Map();
    this.ids = new Map();
  }

  /** Purpose: Register a workspace root. Input: absolute directory. Output: stable random id. */
  async register(root) {
    if (typeof root !== "string" || !isAbsolute(root)) throw new Error("工作目录必须是绝对路径。");
    const real = await realpath(root);
    if (!(await stat(real)).isDirectory()) throw new Error("工作目录不存在。");
    if (this.ids.has(real)) return { id: this.ids.get(real), real };
    const id = randomBytes(12).toString("hex");
    this.roots.set(id, real);
    this.ids.set(real, id);
    return { id, real };
  }

  async target(root, path = "") {
    const { id, real } = await this.register(root);
    const requested = String(path ?? "").replaceAll("\\", "/");
    if (requested.includes("\0")) throw new Error("路径无效。");
    const candidate = resolve(real, ...requested.split("/").filter(Boolean));
    if (!inside(real, candidate)) throw new Error("只能访问当前工作目录中的文件。");
    let target;
    try { target = await realpath(candidate); } catch { throw new Error(`找不到文件：${requested || "."}`); }
    if (!inside(real, target)) throw new Error("该路径通过链接指向工作目录以外，已拒绝访问。");
    return { id, root: real, target, relative: posix(relative(real, target)) };
  }

  async list(root, path = "") {
    const { target, relative: base } = await this.target(root, path);
    if (!(await stat(target)).isDirectory()) throw new Error("不是文件夹。");
    const entries = await readdir(target, { withFileTypes: true });
    const items = [];
    for (const entry of entries.slice(0, MAX_ENTRIES)) {
      if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) continue;
      items.push({ name: entry.name, path: base ? `${base}/${entry.name}` : entry.name,
        kind: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "link" : "file" });
    }
    items.sort((a, b) => (a.kind === "directory" ? 0 : 1) - (b.kind === "directory" ? 0 : 1) || a.name.localeCompare(b.name));
    return { path: base, entries: items, truncated: entries.length > MAX_ENTRIES };
  }

  async read(root, path) {
    const { id, target, relative: rel } = await this.target(root, path);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("只能预览文件。");
    const extension = extname(target).toLowerCase();
    const url = `${FILE_SCHEME}://${id}/${rel.split("/").map(encodeURIComponent).join("/")}`;
    const base = { path: rel, size: info.size, modified: info.mtimeMs, url };
    if (IMAGE.has(extension)) return { ...base, kind: "image" };
    if (extension === ".pdf") return { ...base, kind: "pdf" };
    const handle = await open(target, "r");
    try {
      const length = Math.min(info.size, MAX_TEXT);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      if (buffer.includes(0)) return { ...base, kind: "binary" };
      const text = buffer.toString("utf8");
      const kind = extension === ".html" || extension === ".htm" ? "html" : MARKDOWN.has(extension) ? "markdown" : "text";
      return { ...base, kind, text, truncated: info.size > MAX_TEXT };
    } finally { await handle.close(); }
  }

  /** Purpose: Map a chat file link to the sidebar. Input: root and href. Output: relative path and line. */
  async locate(root, href) {
    const { candidate, sourceCandidate } = resolveLocalHref(href, root);
    const line = Number(/:(\d+)(?::\d+)?$/.exec(String(href).split(/[?#]/, 1)[0])?.[1]) || null;
    const { real } = await this.register(root);
    for (const path of [candidate, sourceCandidate].filter(Boolean)) {
      try {
        const target = await realpath(path);
        if (inside(real, target)) return { path: posix(relative(real, target)), line };
      } catch { /* Try the next spelling. */ }
    }
    return null;
  }

  /** Purpose: Serve workspace previews. Input: cleo-file request. Output: file response. */
  async respond(request) {
    const url = new URL(request.url);
    const root = this.roots.get(url.hostname);
    const headers = { "Cross-Origin-Resource-Policy": "same-origin", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
    if (!root) return new Response("Not found", { status: 404, headers });
    let target;
    try {
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      let located = await this.target(root, parts.join("/"));
      if ((await stat(located.target)).isDirectory()) located = await this.target(root, [...parts, "index.html"].join("/"));
      target = located.target;
      if (!(await stat(target)).isFile()) throw new Error("not a file");
    } catch {
      return new Response("Not found", { status: 404, headers });
    }
    const { createReadStream } = await import("node:fs");
    const { Readable } = await import("node:stream");
    const base = MIME[extname(target).toLowerCase()] || "application/octet-stream";
    // Workspace text is UTF-8; without a charset, pages lacking <meta charset> decode as Latin-1.
    const type = /^(text\/|application\/(json|xml)|image\/svg)/.test(base) ? `${base}; charset=utf-8` : base;
    return new Response(Readable.toWeb(createReadStream(target)), { status: 200, headers: { ...headers, "Content-Type": type } });
  }
}
