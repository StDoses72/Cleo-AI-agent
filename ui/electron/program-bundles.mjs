import { t as tr } from "./i18n.mjs";
import { cp, mkdir, open } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { run } from "./run-command.mjs";

/** Purpose: Fetch metadata from public release services. Input: HTTPS URL. Output: JSON or text. */
export async function fetchRelease(url, json = true, { signal } = {}) {
  const timeout = AbortSignal.timeout(120000);
  const response = await fetch(url, { headers: { "User-Agent": "Cleo" }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(tr("evolution_tools.download_failed_value_check_your_connection_and_retry", { p0: response.status }));
  return json ? response.json() : response.text();
}

/** Purpose: Unpack a verified release archive. Input: archive and new destination. Output: extracted tree. */
export async function extract(archive, destination, { signal, log = () => {} } = {}) {
  signal?.throwIfAborted();
  await mkdir(destination, { recursive: true });
  const options = { outputMode: "tail", log, signal };
  if (process.platform === "win32" && archive.endsWith(".zip")) {
    // Keep long-path support without passing Unicode paths through tar's ANSI argv.
    // Node opens the archive and sets the working directory using Windows Unicode APIs.
    const tar = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    const input = await open(archive, "r");
    try { await run(tar, ["-xf", "-"], { ...options, cwd: destination, stdin: input.fd }); }
    finally { await input.close(); }
  } else if (process.platform === "darwin" && archive.endsWith(".zip")) await run("ditto", ["-x", "-k", archive, destination], options);
  else if (archive.endsWith(".zip")) await run("unzip", ["-q", archive, "-d", destination], options);
  else await run("tar", ["-xf", archive, "-C", destination], options);
}

/** Purpose: Retain an installation as physical files without Electron expanding ASAR archives.
 * Input: installation root and destination. Output: byte-preserving bundle copy, including native symlinks.
 */
export async function copyProgramBundle(source, destination, { signal } = {}) {
  signal?.throwIfAborted();
  if (process.platform === "win32") {
    // Native copying avoids ASAR expansion and per-file JS overhead in the large Python runtime.
    await run("robocopy.exe", [source, destination, "/E", "/SL", "/COPY:DAT", "/R:0", "/W:0",
      "/MT:8", "/NFL", "/NDL", "/NP", "/NJH", "/NJS"],
    { successCodes: [0, 1, 2, 3, 4, 5, 6, 7], timeout: 600000, signal });
    return;
  }
  const filesystem = process.versions.electron
    ? createRequire(import.meta.url)("original-fs").promises
    : { cp };
  await filesystem.cp(source, destination, { recursive: true, verbatimSymlinks: true });
  signal?.throwIfAborted();
}
