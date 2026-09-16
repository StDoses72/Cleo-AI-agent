import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReleasePermission, previewRelease, publishRelease } from "../electron/github-releases.mjs";
import { releaseBuilds, publishReleasePackages, releasePackageStatus } from "../electron/release-packages.mjs";

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
      if (args.includes("POST") || args.includes("PATCH")) {
        const path = args[3], payload = JSON.parse(await readFile(args.at(-1), "utf8"));
        remote.writes.push({ path, payload });
        if (args.includes("PATCH")) {
          const release = Object.values(remote.releases).find(item => String(item.id) === path.split("/").at(-1));
          Object.assign(release, payload);
          return JSON.stringify(release);
        }
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
        if (!release || release.draft) throw new Error("HTTP 404");
        return JSON.stringify(release);
      }
      if (path.includes("/releases?")) return JSON.stringify(Object.values(remote.releases));
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

test("an exact existing source-only draft can be completed on retry", async () => {
  await fixture(async ({ manager, remote, publish }) => {
    const preview = await previewRelease(manager, { url });
    remote.tags["v0.5.0-beta.1"] = commit;
    remote.releases["v0.5.0-beta.1"] = { id: 17, tag_name: "v0.5.0-beta.1", name: "Test release",
      body: "Notes", prerelease: true, draft: true, assets: [], html_url: `https://github.com/${repo}/releases/tag/v0.5.0-beta.1` };
    const result = await publish(preview);
    assert.equal(remote.releases["v0.5.0-beta.1"].draft, false);
    assert.match(result.releaseUrl, /releases\/tag/);
  });
});

test("a draft with partial packages must be completed by the verified package workflow", async () => {
  await fixture(async ({ manager, remote, publish }) => {
    const preview = await previewRelease(manager, { url });
    remote.tags["v0.5.0-beta.1"] = commit;
    remote.releases["v0.5.0-beta.1"] = { id: 17, tag_name: "v0.5.0-beta.1", name: "Test release",
      body: "Notes", prerelease: true, draft: true, assets: [{ name: "release.json" }] };
    await assert.rejects(publish(preview), /安装包/);
    assert.equal(remote.writes.length, 0);
    assert.equal(remote.releases["v0.5.0-beta.1"].draft, true);
  });
});

async function packageFixture(action) {
  return fixture(async context => {
    const { manager, remote, publish } = context;
    const params = { ...await previewRelease(manager, { url }), tag: "v0.5.0-beta.1", title: "Test release", body: "Notes", prerelease: true, runId: "99" };
    await publish(params);
    remote.writes = [];
    const build = { id: 99, workflow_id: 10, head_sha: commit, status: "completed", conclusion: "success", event: "workflow_dispatch", html_url: `https://github.com/${repo}/actions/runs/99`, created_at: "2026-01-01" };
    const actions = { build, runs: [], dispatches: [], lost: false, outdated: false,
      artifacts: ["windows-x64", "macos-arm64", "macos-x64", "linux-x64"].map(target => ({ name: `desktop-${target}`, expired: false, size_in_bytes: 100 })) };
    const original = manager.runCommand.bind(manager);
    manager.runCommand = async (command, args) => {
      const path = args.includes("POST") ? args[3] : args[1];
      if (command !== "gh") return original(command, args);
      if (path.endsWith("/dispatches")) {
        actions.dispatches.push(JSON.parse(await readFile(args.at(-1), "utf8")));
        actions.runs.unshift({ id: 200 + actions.runs.length, event: "workflow_dispatch", display_title: `release ${params.tag} build 99`, status: "queued", html_url: `https://github.com/${repo}/actions/runs/200` });
        if (actions.lost) throw new Error("Response lost after dispatch");
        return "";
      }
      if (path === `repos/${repo}`) return JSON.stringify({ owner: { login: "owner" }, permissions: { push: remote.push }, default_branch: "main" });
      if (path.includes("/contents/")) return JSON.stringify({ encoding: "base64", content: Buffer.from(actions.outdated ? "old workflow" : "allow_existing_release:\nprerelease:").toString("base64") });
      if (path.endsWith("/actions/runs/99")) return JSON.stringify(build);
      if (path.includes("/artifacts?")) return JSON.stringify({ artifacts: actions.artifacts });
      if (path.endsWith("/desktop-platforms.yml")) return JSON.stringify({ id: 10 });
      if (path.includes("/desktop-platforms.yml/runs?")) return JSON.stringify({ workflow_runs: [build] });
      if (path.includes("/publish-release.yml/runs?")) return JSON.stringify({ workflow_runs: actions.runs });
      return original(command, args);
    };
    await action({ ...context, params, actions });
  });
}

test("only a full successful matching desktop build is selectable", async () => {
  await packageFixture(async ({ manager, params, actions }) => {
    assert.equal((await releaseBuilds(manager, params))[0].id, "99");
    actions.artifacts[0].expired = true;
    assert.deepEqual(await releaseBuilds(manager, params), []);
    actions.artifacts[0].expired = false;
    actions.build.event = "pull_request";
    assert.deepEqual(await releaseBuilds(manager, params), []);
  });
});

for (const lost of [false, true]) test(`dispatch forwards exact metadata and reconciles retry (lost=${lost})`, async () => {
  await packageFixture(async ({ manager, params, actions, remote }) => {
    actions.lost = lost;
    assert.equal((await publishReleasePackages(manager, params)).status, "running");
    assert.deepEqual(actions.dispatches[0], { ref: "main", inputs: { run_id: "99", tag: params.tag,
      title: params.title, notes: params.body, prerelease: "true", allow_existing_release: "true" } });
    await publishReleasePackages(manager, params);
    assert.equal(actions.dispatches.length, 1);
    assert.equal(remote.writes.length, 0);
  });
});

for (const failure of ["account", "permission", "commit", "tag", "workflow", "pr-build", "expired", "metadata", "outdated"]) {
  test(`package dispatch blocks ${failure} before remote mutation`, async () => {
    await packageFixture(async ({ manager, params, actions, remote }) => {
      if (failure === "account") remote.login = "other";
      if (failure === "permission") remote.push = false;
      if (failure === "commit") actions.build.head_sha = "b".repeat(40);
      if (failure === "tag") remote.tags[params.tag] = "b".repeat(40);
      if (failure === "workflow") actions.build.workflow_id = 20;
      if (failure === "pr-build") actions.build.event = "pull_request";
      if (failure === "expired") actions.artifacts[0].expired = true;
      if (failure === "metadata") params.body = "Different notes";
      if (failure === "outdated") actions.outdated = true;
      await assert.rejects(publishReleasePackages(manager, params));
      assert.equal(actions.dispatches.length, 0);
      assert.equal(remote.writes.length, 0);
    });
  });
}

test("failed runs can retry; successful runs do not claim completion without all assets", async () => {
  await packageFixture(async ({ manager, params, actions, remote }) => {
    await publishReleasePackages(manager, params);
    actions.runs[0].status = "completed"; actions.runs[0].conclusion = "failure";
    assert.equal((await releasePackageStatus(manager, params)).status, "failed");
    await publishReleasePackages(manager, params);
    assert.equal(actions.dispatches.length, 2);
    actions.runs[0].status = "completed"; actions.runs[0].conclusion = "success";
    assert.equal((await releasePackageStatus(manager, params)).status, "incomplete");
    const names = ["windows-x64", "macos-arm64", "macos-x64", "linux-x64"].flatMap(target => [
      `Cleo-${target}${target === "linux-x64" ? ".tar.gz" : ".zip"}`, `Cleo-${target}.sha256`,
      target === "windows-x64" ? "release.json" : `release-${target}.json`]);
    names.push("Cleo-linux-x64.deb", "Cleo-linux-x64.deb.sha256");
    remote.releases[params.tag].assets = names.map(name => ({ name, size: 100, digest: `sha256:${"a".repeat(64)}` }));
    const status = await releasePackageStatus(manager, params);
    assert.equal(status.status, "completed"); assert.match(status.releaseUrl, /releases\/tag/);
    await publishReleasePackages(manager, params);
    assert.equal(actions.dispatches.length, 2);
    remote.tags[params.tag] = "b".repeat(40);
    await assert.rejects(releasePackageStatus(manager, params), /标签提交/);
  });
});
