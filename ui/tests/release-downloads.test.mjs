import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ReleaseDownloads } from "../electron/release-downloads.mjs";

const payload = Buffer.from("verified Cleo release archive");
const manifestFor = (bytes = payload, extra = {}) => ({
  schemaVersion: 1, app: "Cleo", version: "0.4.0", platform: "windows-x64",
  archive: "Cleo-windows-x64.zip", sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length, ...extra,
});
const url = "https://example.test/Cleo.zip";
const deferred = () => Promise.withResolvers();

async function isolated(action) {
  const root = await mkdtemp(join(tmpdir(), "cleo-release-downloads-"));
  try { await action(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("same artifact shares one fetch and progress across instances; only verified files become visible", async () => {
  await isolated(async root => {
    const firstChunk = deferred();
    const finish = deferred();
    const manifest = manifestFor();
    let fetched = 0;
    const first = new ReleaseDownloads({ root, fetchImpl: async () => {
      fetched++;
      return { ok: true, status: 200, body: (async function* () {
        yield payload.subarray(0, 4);
        await finish.promise;
        yield payload.subarray(4);
      })() };
    } });
    const second = new ReleaseDownloads({ root, fetchImpl: () => { throw new Error("Duplicate fetch"); } });
    const progressA = [], progressB = [];
    const a = first.get(manifest, { url, onProgress: bytes => {
      progressA.push(bytes);
      if (bytes === 4) firstChunk.resolve();
    } });
    await firstChunk.promise;
    const b = second.get(manifest, { url, onProgress: bytes => progressB.push(bytes) });
    await assert.rejects(stat(first.pathFor(manifest)), { code: "ENOENT" });
    assert.equal((await readdir(dirname(first.pathFor(manifest)))).filter(name => name.endsWith(".partial")).length, 1);
    finish.resolve();
    const [aPath, bPath] = await Promise.all([a, b]);
    assert.equal(aPath, bPath);
    assert.equal(fetched, 1);
    assert.deepEqual(await readFile(aPath), payload);
    for (const progress of [progressA, progressB]) {
      assert.ok(progress.includes(4));
      assert.equal(progress.at(-1), payload.length);
    }
    assert.deepEqual(await readdir(dirname(aPath)), [manifest.archive]);
    assert.equal(await second.get(manifest, { url }), aPath);
  });
});

test("verified legacy packages are copied into the private cache and remain available to their owner", async () => {
  await isolated(async root => {
    const legacy = join(root, "old-cache.zip");
    const corrupt = join(root, "corrupt-old-cache.zip");
    await writeFile(legacy, payload);
    await writeFile(corrupt, Buffer.alloc(payload.length));
    const downloads = new ReleaseDownloads({ root: join(root, "profile", "downloads"),
      fetchImpl: () => { throw new Error("Verified legacy cache should avoid the network"); },
      legacyPaths: async () => [corrupt, legacy],
    });
    const manifest = manifestFor();
    const path = await downloads.get(manifest, { url });
    assert.equal(path, downloads.pathFor(manifest));
    assert.notEqual(path, legacy);
    assert.deepEqual(await readFile(path), payload);
    assert.deepEqual(await readFile(legacy), payload);
    assert.equal((await stat(corrupt)).size, payload.length);
  });
});

test("platform, version, checksum and profile select distinct cache entries", async () => {
  await isolated(async root => {
    const otherPayload = Buffer.from("another verified Cleo archive");
    let fetched = 0;
    const fetchImpl = async requestUrl => {
      fetched++;
      return new Response(requestUrl.endsWith("other.zip") ? otherPayload : payload);
    };
    const first = new ReleaseDownloads({ root: join(root, "first"), fetchImpl });
    const second = new ReleaseDownloads({ root: join(root, "second"), fetchImpl });
    const manifest = manifestFor();
    const paths = await Promise.all([
      first.get(manifest, { url }), second.get(manifest, { url }),
      first.get(manifestFor(payload, { platform: "macos-arm64", archive: "Cleo-macos-arm64.zip" }), { url }),
      first.get(manifestFor(payload, { version: "0.4.1" }), { url }),
      first.get(manifestFor(otherPayload), { url: "https://example.test/other.zip" }),
    ]);
    assert.equal(new Set(paths).size, 5);
    assert.equal(fetched, 5);
  });
});

for (const failure of ["checksum", "oversize"]) {
  test(`${failure} failure leaves no published/partial file and the next request can retry`, async () => {
    await isolated(async root => {
      let fetched = 0;
      const downloads = new ReleaseDownloads({ root, fetchImpl: async () => {
        fetched++;
        return new Response(fetched > 1 ? payload : failure === "checksum"
          ? Buffer.alloc(payload.length) : Buffer.concat([payload, Buffer.from("extra")]));
      } });
      const manifest = manifestFor();
      await assert.rejects(downloads.get(manifest, { url }), failure === "checksum" ? /SHA-256/ : /larger/);
      await assert.rejects(stat(downloads.pathFor(manifest)), { code: "ENOENT" });
      assert.deepEqual(await readdir(dirname(downloads.pathFor(manifest))), []);
      assert.deepEqual(await readFile(await downloads.get(manifest, { url })), payload);
      assert.equal(fetched, 2);
    });
  });
}

test("an incomplete response resumes the owned partial and verifies the combined archive", async () => {
  await isolated(async root => {
    const requests = [];
    const downloads = new ReleaseDownloads({ root, fetchImpl: async (_url, options) => {
      requests.push(options.headers);
      return requests.length === 1 ? new Response(payload.subarray(0, 4))
        : new Response(payload.subarray(4), { status: 206 });
    } });
    const path = await downloads.get(manifestFor(), { url });
    assert.deepEqual(requests, [{}, { Range: "bytes=4-" }]);
    assert.deepEqual(await readFile(path), payload);
  });
});

test("exhausted incomplete responses fail cleanly and can be retried", async () => {
  await isolated(async root => {
    let complete = false;
    let fetched = 0;
    const downloads = new ReleaseDownloads({ root, fetchImpl: async () => {
      fetched++;
      return new Response(complete ? payload : Buffer.alloc(0));
    } });
    const manifest = manifestFor();
    await assert.rejects(downloads.get(manifest, { url }), /incomplete/);
    assert.equal(fetched, 5);
    assert.deepEqual(await readdir(dirname(downloads.pathFor(manifest))), []);
    complete = true;
    assert.deepEqual(await readFile(await downloads.get(manifest, { url })), payload);
  });
});

test("closing one subscriber preserves another instance's shared download", async () => {
  await isolated(async root => {
    const firstChunk = deferred(), finish = deferred();
    const first = new ReleaseDownloads({ root, fetchImpl: async () => ({
      ok: true, status: 200, body: (async function* () {
        yield payload.subarray(0, 4);
        await finish.promise;
        yield payload.subarray(4);
      })(),
    }) });
    const second = new ReleaseDownloads({ root, fetchImpl: () => { throw new Error("Duplicate fetch"); } });
    const manifest = manifestFor();
    const a = assert.rejects(first.get(manifest, { url, onProgress: bytes => {
      if (bytes === 4) firstChunk.resolve();
    } }), /cancelled/);
    await firstChunk.promise;
    const b = second.get(manifest, { url });
    await first.close();
    await a;
    finish.resolve();
    assert.deepEqual(await readFile(await b), payload);
    await second.close();
  });
});

test("closing the last subscriber aborts network I/O and waits for partial cleanup", async () => {
  await isolated(async root => {
    const started = deferred();
    const downloads = new ReleaseDownloads({ root, fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      started.resolve();
    }) });
    const manifest = manifestFor();
    const pending = assert.rejects(downloads.get(manifest, { url }), /cancelled/);
    await started.promise;
    await downloads.close();
    await pending;
    assert.deepEqual(await readdir(dirname(downloads.pathFor(manifest))), []);
    await assert.rejects(downloads.get(manifest, { url }), /closed/);
    const retry = new ReleaseDownloads({ root, fetchImpl: async () => new Response(payload) });
    assert.deepEqual(await readFile(await retry.get(manifest, { url })), payload);
  });
});

test("cache path fields cannot escape the private directory", async () => {
  await isolated(async root => {
    const downloads = new ReleaseDownloads({ root });
    for (const key of ["platform", "version", "archive"]) {
      assert.throws(() => downloads.pathFor(manifestFor(payload, { [key]: "../outside" })), /Invalid release/);
    }
    assert.deepEqual(await readdir(root), [], "Constructing the client must not create cache directories");
  });
});
