import { open, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const blockedExtensions = new Set([
  ".bat",
  ".cmd",
  ".com",
  ".exe",
  ".lnk",
  ".msi",
  ".ps1",
  ".scr",
  ".sh",
  ".url",
  ".app",
  ".appimage",
  ".command",
  ".desktop",
  ".deb",
  ".pkg",
  ".rpm",
]);

export function resolveLocalHref(href, workspacePath) {
  const rawHref = String(href || "").trim();
  const rawWorkspace = String(workspacePath || "").trim();
  if (!rawHref) throw new Error("链接没有包含文件路径");

  const hrefWithoutSuffix = rawHref.split(/[?#]/, 1)[0];
  let decodedHref;
  try {
    decodedHref = /^file:/i.test(hrefWithoutSuffix)
      ? fileURLToPath(hrefWithoutSuffix) : decodeURIComponent(hrefWithoutSuffix);
  } catch {
    throw new Error("链接中的文件路径格式无效");
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(decodedHref) && !/^[a-z]:[\\/]/i.test(decodedHref)) {
    throw new Error("这个链接不是可打开的本地文件");
  }

  if (!isAbsolute(decodedHref) && !rawWorkspace) {
    throw new Error("相对文件链接需要当前任务关联工作目录；当前任务没有关联工作目录");
  }
  const workspace = rawWorkspace ? resolve(rawWorkspace) : null;
  const candidate = isAbsolute(decodedHref)
    ? resolve(decodedHref)
    : resolve(workspace, decodedHref);
  const sourcePath = /^(.*?):\d+(?::\d+)?$/.exec(decodedHref)?.[1] || null;
  const sourceCandidate = sourcePath
    ? (isAbsolute(sourcePath) ? resolve(sourcePath) : resolve(workspace, sourcePath))
    : null;
  return { candidate, sourceCandidate, workspace };
}

export async function openLocalHref({ href, workspacePath, shellAdapter }) {
  const resolved = resolveLocalHref(href, workspacePath);
  let target;
  try {
    target = await realpath(resolved.candidate);
  } catch (error) {
    if (error?.code !== "ENOENT" || !resolved.sourceCandidate) {
      if (error?.code === "ENOENT") {
        throw new Error(`找不到文件：${String(href).split(/[?#]/, 1)[0]}`);
      }
      throw error;
    }
    try {
      target = await realpath(resolved.sourceCandidate);
    } catch (fallbackError) {
      if (fallbackError?.code !== "ENOENT") throw fallbackError;
      throw new Error(`找不到文件：${String(href).split(/[?#]/, 1)[0]}`);
    }
  }
  const targetStat = await stat(target);
  if (!targetStat.isFile() && !targetStat.isDirectory()) {
    throw new Error("这个链接不是普通文件或目录");
  }
  let executable = false;
  if (process.platform !== "win32" && targetStat.isFile() && (targetStat.mode & 0o111)) {
    const file = await open(target, "r");
    try {
      const header = Buffer.alloc(4);
      await file.read(header, 0, 4, 0);
      executable = header.subarray(0, 2).toString() === "#!"
        || ["7f454c46", "feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"]
          .includes(header.toString("hex"));
    } finally { await file.close(); }
  }
  if (blockedExtensions.has(extname(target).toLowerCase()) || executable) {
    throw new Error("为安全起见，消息中的链接不能直接运行程序或脚本");
  }

  const openError = await shellAdapter.openPath(target);
  if (openError) throw new Error(`无法打开文件：${openError}`);
  return { path: target, kind: targetStat.isDirectory() ? "directory" : "file" };
}
