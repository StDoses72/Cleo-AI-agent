import { t as tr } from "./i18n.mjs";
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
  if (!rawHref) throw new Error(tr("local_files.the_link_contains_no_file_path"));

  const hrefWithoutSuffix = rawHref.split(/[?#]/, 1)[0];
  let decodedHref;
  try {
    decodedHref = /^file:/i.test(hrefWithoutSuffix)
      ? fileURLToPath(hrefWithoutSuffix) : decodeURIComponent(hrefWithoutSuffix);
  } catch {
    throw new Error(tr("local_files.the_file_path_in_the_link_is_invalid"));
  }
  if (process.platform === "win32" && /^\/[a-z]:[\\/]/i.test(decodedHref)) {
    decodedHref = decodedHref.slice(1);
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(decodedHref) && !/^[a-z]:[\\/]/i.test(decodedHref)) {
    throw new Error(tr("local_files.this_link_is_not_an_openable_local_file"));
  }

  if (!isAbsolute(decodedHref) && !rawWorkspace) {
    throw new Error(tr("local_files.relative_file_links_require_a_working_directory_for_the_current_task_none_is_attached"));
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
        throw new Error(tr("broker.file_not_found_value", { p0: String(href).split(/[?#]/, 1)[0] }));
      }
      throw error;
    }
    try {
      target = await realpath(resolved.sourceCandidate);
    } catch (fallbackError) {
      if (fallbackError?.code !== "ENOENT") throw fallbackError;
      throw new Error(tr("broker.file_not_found_value", { p0: String(href).split(/[?#]/, 1)[0] }));
    }
  }
  const targetStat = await stat(target);
  if (!targetStat.isFile() && !targetStat.isDirectory()) {
    throw new Error(tr("local_files.this_link_is_not_a_regular_file_or_directory"));
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
    throw new Error(tr("local_files.for_safety_message_links_cannot_directly_run_programs_or_scripts"));
  }

  const openError = await shellAdapter.openPath(target);
  if (openError) throw new Error(tr("local_files.could_not_open_the_file_value", { p0: openError }));
  return { path: target, kind: targetStat.isDirectory() ? "directory" : "file" };
}
