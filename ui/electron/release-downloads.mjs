import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const inFlight = new Map();
const DOWNLOAD_ATTEMPTS = 5;

class InvalidDownload extends Error {}

async function verified(path, manifest, signal) {
  signal.throwIfAborted();
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size !== manifest.bytes) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) {
      signal.throwIfAborted();
      hash.update(chunk);
    }
    return hash.digest("hex") === manifest.sha256;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** One verified artifact per profile, shared by update and evolution callers. */
export class ReleaseDownloads {
  constructor({ root, fetchImpl = globalThis.fetch, legacyPaths = () => [] }) {
    this.root = resolve(root);
    this.fetchImpl = fetchImpl;
    this.legacyPaths = legacyPaths;
    this.requests = new Set();
    this.closed = false;
  }

  pathFor(manifest) {
    for (const key of ["platform", "version", "archive"]) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(manifest[key] ?? "")) {
        throw new Error(`Invalid release ${key}.`);
      }
    }
    if (!/^[a-f0-9]{64}$/.test(manifest.sha256)
        || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0) {
      throw new Error("Invalid release checksum or size.");
    }
    return join(this.root, manifest.platform, manifest.version, manifest.sha256, manifest.archive);
  }

  async get(manifest, { url, onProgress = () => {} }) {
    if (this.closed) throw new Error("Release downloads are closed.");
    manifest = { ...manifest };
    const path = this.pathFor(manifest);
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    let entry = inFlight.get(key);
    if (!entry || entry.controller.signal.aborted) {
      entry = { controller: new AbortController(), subscribers: new Set(), downloaded: 0 };
      inFlight.set(key, entry);
      const report = (bytes) => {
        entry.downloaded = bytes;
        for (const subscriber of entry.subscribers) subscriber.onProgress(bytes, manifest.bytes);
      };
      entry.promise = Promise.resolve().then(() => this.obtain(manifest, path, url, report, entry.controller.signal))
        .finally(() => { if (inFlight.get(key) === entry) inFlight.delete(key); });
    }
    let cancel;
    const cancelled = new Promise((_, reject) => { cancel = reject; });
    const request = { entry, onProgress, cancel };
    this.requests.add(request);
    entry.subscribers.add(request);
    try {
      onProgress(entry.downloaded, manifest.bytes);
      return await Promise.race([entry.promise, cancelled]);
    } finally {
      entry.subscribers.delete(request);
      this.requests.delete(request);
    }
  }

  async close() {
    this.closed = true;
    const entries = new Set();
    for (const request of this.requests) {
      entries.add(request.entry);
      request.entry.subscribers.delete(request);
      request.cancel(new Error("Release download cancelled."));
    }
    const stopped = [...entries].filter(entry => entry.subscribers.size === 0);
    for (const entry of stopped) entry.controller.abort(new Error("Release download cancelled."));
    await Promise.allSettled(stopped.map(entry => entry.promise));
  }

  async obtain(manifest, path, url, report, signal) {
    if (await verified(path, manifest, signal)) { report(manifest.bytes); return path; }
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.partial`;
    try {
      for (const legacy of await this.legacyPaths(manifest)) {
        if (resolve(legacy) === path || !await verified(legacy, manifest, signal)) continue;
        await copyFile(legacy, temporary, constants.COPYFILE_EXCL);
        // The legacy file may have changed while it was copied.
        if (await verified(temporary, manifest, signal)) {
          signal.throwIfAborted();
          await rename(temporary, path);
          report(manifest.bytes);
          return path;
        }
        await rm(temporary);
      }
      signal.throwIfAborted();
      const file = await open(temporary, "wx", 0o600);
      await file.close();
      await this.downloadArchive(url, temporary, manifest.bytes, report, signal);
      if (!await verified(temporary, manifest, signal)) {
        throw new InvalidDownload("The downloaded update failed its SHA-256 verification.");
      }
      signal.throwIfAborted();
      await rename(temporary, path);
      report(manifest.bytes);
      return path;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async downloadArchive(url, path, expectedBytes, report, signal) {
    let downloaded = 0;
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS && downloaded < expectedBytes; attempt++) {
      signal.throwIfAborted();
      let file;
      try {
        const response = await this.fetchImpl(url, {
          headers: downloaded ? { Range: `bytes=${downloaded}-` } : {}, redirect: "follow",
          signal: AbortSignal.any([signal, AbortSignal.timeout(900000)]),
        });
        if (!response.ok && response.status !== 206) {
          throw new Error(`Update download returned HTTP ${response.status}.`);
        }
        if (!response.body) throw new Error("The update server returned an empty response.");
        if (downloaded && response.status !== 206) downloaded = 0;
        file = await open(path, downloaded ? "a" : "w");
        let lastNotification = 0;
        for await (const chunk of response.body) {
          signal.throwIfAborted();
          const buffer = Buffer.from(chunk);
          if (downloaded + buffer.length > expectedBytes) {
            throw new InvalidDownload("The update is larger than its manifest.");
          }
          await file.writeFile(buffer);
          downloaded += buffer.length;
          const now = Date.now();
          if (now - lastNotification >= 250 || downloaded === expectedBytes) {
            lastNotification = now;
            report(downloaded);
          }
        }
        await file.close();
        file = null;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof InvalidDownload || attempt === DOWNLOAD_ATTEMPTS) throw error;
        downloaded = (await stat(path)).size;
      } finally {
        await file?.close();
      }
      if (downloaded < expectedBytes && attempt < DOWNLOAD_ATTEMPTS) {
        await delay(1000 * attempt, undefined, { signal });
      }
    }
    if (downloaded !== expectedBytes) {
      throw new InvalidDownload(`The update download is incomplete (${downloaded} of ${expectedBytes} bytes).`);
    }
  }
}
