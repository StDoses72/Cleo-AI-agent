import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
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
]);

function insideWorkspace(workspacePath, candidatePath) {
  const pathFromWorkspace = relative(workspacePath, candidatePath);
  return pathFromWorkspace === "" || (
    pathFromWorkspace !== ".."
    && !pathFromWorkspace.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && !isAbsolute(pathFromWorkspace)
  );
}

export function resolveLocalHref(href, workspacePath) {
  const rawHref = String(href || "").trim();
  const rawWorkspace = String(workspacePath || "").trim();
  if (!rawHref) throw new Error("链接没有包含文件路径");
  if (!rawWorkspace) throw new Error("当前任务没有关联工作目录");

  const hrefWithoutSuffix = rawHref.split(/[?#]/, 1)[0];
  let decodedHref;
  try {
    decodedHref = decodeURIComponent(hrefWithoutSuffix);
  } catch {
    throw new Error("链接中的文件路径格式无效");
  }
  if (decodedHref.startsWith("file:")) decodedHref = fileURLToPath(decodedHref);
  if (/^[a-z][a-z\d+.-]*:/i.test(decodedHref) && !/^[a-z]:[\\/]/i.test(decodedHref)) {
    throw new Error("这个链接不是可打开的本地文件");
  }

  const workspace = resolve(rawWorkspace);
  const candidate = isAbsolute(decodedHref)
    ? resolve(decodedHref)
    : resolve(workspace, decodedHref);
  if (!insideWorkspace(workspace, candidate)) {
    throw new Error("只能打开当前项目目录中的文件");
  }
  return { candidate, workspace };
}

export async function openLocalHref({ href, workspacePath, shellAdapter }) {
  const resolved = resolveLocalHref(href, workspacePath);
  let workspace;
  let target;
  try {
    [workspace, target] = await Promise.all([
      realpath(resolved.workspace),
      realpath(resolved.candidate),
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`找不到文件：${String(href).split(/[?#]/, 1)[0]}`);
    }
    throw error;
  }
  if (!insideWorkspace(workspace, target)) {
    throw new Error("只能打开当前项目目录中的文件");
  }

  const targetStat = await stat(target);
  if (!targetStat.isFile() && !targetStat.isDirectory()) {
    throw new Error("这个链接不是普通文件或目录");
  }
  if (targetStat.isFile() && blockedExtensions.has(extname(target).toLowerCase())) {
    throw new Error("为安全起见，消息中的链接不能直接运行程序或脚本");
  }

  const openError = await shellAdapter.openPath(target);
  if (openError) throw new Error(`无法打开文件：${openError}`);
  return { path: target, kind: targetStat.isDirectory() ? "directory" : "file" };
}
