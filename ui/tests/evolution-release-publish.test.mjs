import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReleasePermission, previewRelease, publishRelease } from "../electron/github-releases.mjs";

const repo = "StDoses72/Cleo-AI-agent";
const url = `https://github.com/${repo}/pull/42`;
const commit = "a".repeat(40);
async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), "cleo-publish-test-"));
  const bytes = Buffer.from("verified source");
  await writeFile(join(root, "README.md"), bytes);
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const state = { prepared: true, active: "local", builds: [{ id: "local", kind: "local", sourceHash: "verified" }],
    pullRequests: [{ url, buildId: "local", sourceHash: "verified", targetBranch: "release-branch" }] };
  const remote = { login: "owner", push: true, merged: true, commit, tags: {}, releases: {}, writes: [], blob };
  const manager = {
    tools: { prepareGithub: async () => ({ gh: "gh", env: {} }) },
    source: root, githubAuth: { status: "connected" }, store: { read: async () => state },
    setGithubAuth(auth) { this.githubAuth = auth; }, prepareTools: async () => ({ gh: "gh", git: "git", env: {} }),
    operation: async (_phase, action) => action(), sourceHash: async () => "verified", checkProtection: async () => {},
    async runCommand(command, args) {
      if (command === "git") return args.includes("--stage") ? `100644 ${blob} 0\tREADME.md\0` : "README.md\0";
      if (remote.networkError) throw new Error("HTTP 503");
      if (args.includes("POST")) {
        const path = args[3], payload = JSON.parse(await readFile(args.at(-1), "utf8"));
        remote.writes.push({ path, payload });
        if (path.endsWith("/git/refs")) { remote.tags[payload.ref.slice(10)] = payload.sha; return "{}"; }
        remote.releases[payload.tag_name] = { ...payload, html_url: `https://github.com/${repo}/releases/tag/${payload.tag_name}` };
        if (remote.responseLost) throw new Error("Network response lost");
        return JSON.stringify(remote.releases[payload.tag_name]);
      }
      const path = args[1];
      if (path === "user") return JSON.stringify({ login: remote.login });
      if (path === `repos/${repo}`) return JSON.stringify({ owner: { login: "owner" }, permissions: { push: remote.push } });
      if (path.includes("/pulls/")) return JSON.stringify({ merged: remote.merged, merge_commit_sha: remote.commit,
        base: { ref: remote.branch || "release-branch", repo: { full_name: repo } } });
      if (path.includes("/git/trees/")) return JSON.stringify({ tree: [{ path: "README.md", type: "blob", mode: remote.mode || "100644", sha: remote.blob }] });
      if (path.includes("/git/ref/tags/")) {
        const sha = remote.tags[decodeURIComponent(path.split("/tags/")[1])];
        if (!sha) throw new Error("HTTP 404");
        return JSON.stringify({ object: { type: "commit", sha } });
      }
      if (path.includes("/releases/tags/")) {
        const release = remote.releases[decodeURIComponent(path.split("/tags/")[1])];
        if (!release) throw new Error("HTTP 404");
        return JSON.stringify(release);
      }
      throw new Error(`Unexpected API ${path}`);
    },
  };
  const publish = (preview, prerelease = true) => publishRelease(manager, { ...preview, tag: "v0.5.0-beta.1", title: "Test release", body: "Notes", prerelease });
  try { await action({ manager, remote, state, publish }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("permissions show owner, collaborator, denial and lookup failure without authorizing unknown users", async () => {
  await fixture(async ({ manager, remote }) => {
    assert.equal((await checkReleasePermission(manager)).role, "owner");
    remote.login = "contributor";
    const collaborator = await checkReleasePermission(manager);
    assert.equal(collaborator.role, "collaborator"); assert.equal(collaborator.canRelease, true);
    remote.push = false;
    assert.equal((await checkReleasePermission(manager)).canRelease, false);
    remote.networkError = true;
    assert.equal((await checkReleasePermission(manager)).status, "failed");
    assert.equal(manager.githubAuth.status, "connected");
    assert.equal(manager.githubAuth.repositoryAccess.canRelease, false);
  });
});

for (const prerelease of [false, true]) test(`publishes the verified merged commit with prerelease=${prerelease}`, async () => {
  await fixture(async ({ manager, remote, publish }) => {
    const preview = await previewRelease(manager, { url });
    assert.equal(preview.commit, commit); assert.equal(preview.targetBranch, "release-branch");
    const result = await publish(preview, prerelease);
    assert.equal(result.prerelease, prerelease); assert.match(result.releaseUrl, /releases\/tag\/v0.5.0-beta.1$/);
    assert.notEqual(result.releaseUrl, result.url);
    assert.equal(remote.writes[0].payload.sha, commit);
    assert.equal(remote.writes[1].payload.target_commitish, commit);
    assert.equal(remote.writes[1].payload.prerelease, prerelease);
    await publish(preview, prerelease);
    assert.equal(remote.writes.length, 2, "Retry must not create duplicate remote mutations");
  });
});

for (const failure of ["unmerged", "source", "file-mode", "unprepared", "missing-hash", "dirty", "branch", "permission", "account", "commit", "tag"]) {
  test(`${failure} is rejected before creating any tag or release`, async () => {
    await fixture(async ({ manager, remote, state, publish }) => {
      const preview = await previewRelease(manager, { url });
      if (failure === "unmerged") remote.merged = false;
      if (failure === "source") remote.blob = "b".repeat(40);
      if (failure === "file-mode") remote.mode = "100755";
      if (failure === "unprepared") state.prepared = false;
      if (failure === "missing-hash") delete state.builds[0].sourceHash;
      if (failure === "dirty") state.draftDirty = true;
      if (failure === "branch") remote.branch = "another-branch";
      if (failure === "permission") remote.push = false;
      if (failure === "account") remote.login = "other-owner";
      if (failure === "commit") remote.commit = "b".repeat(40);
      if (failure === "tag") remote.tags["v0.5.0-beta.1"] = "b".repeat(40);
      await assert.rejects(publish(preview));
      assert.equal(remote.writes.length, 0);
    });
  });
}

test("lost create response reconciles the exact release without reposting", async () => {
  await fixture(async ({ manager, remote, publish }) => {
    const preview = await previewRelease(manager, { url });
    remote.responseLost = true;
    const result = await publish(preview);
    assert.equal(result.prerelease, true); assert.equal(remote.writes.length, 2);
  });
});
