import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { GithubLogin } from "../../src/components/GithubLogin";
import { ReleasePublisher } from "../../src/components/ReleasePublisher";
import { UpdateVersionPicker } from "../../src/components/UpdateVersionPicker";
import "../../src/index.css";
import "../../src/components/evolution.css";
import type { EvolutionState } from "../../src/evolution-types";
import type { UpdateState } from "../../src/types";

const url = "https://github.com/StDoses72/Cleo-AI-agent/pull/42";
const initial: EvolutionState = { phase: "idle", supported: true, prepared: true, currentVersion: "0.6.0",
  active: "local", baseline: null, baseTag: "v0.6.0", source: "fixture", threadId: null, error: null, logs: "",
  githubAuth: { status: "connected", message: "GitHub 已连接", repositoryAccess: { status: "checked", repository: "StDoses72/Cleo-AI-agent",
    login: "fixture-owner", role: "owner", canRelease: true, message: "有仓库写权限，可以创建 Release。" } },
  builds: [{ id: "local", kind: "local", version: null, baseTag: "v0.6.0", createdAt: "2026-01-01", sourceHash: "verified" }],
  pullRequest: { url, state: "MERGED", merged: true, buildId: "local", sourceHash: "verified", targetBranch: "release-branch" },
  releases: [], recoveryPath: null };

function Fixture() {
  const [state, setState] = useState(initial);
  const [calls, setCalls] = useState<unknown[]>([]);
  const [update, setUpdate] = useState<UpdateState>({ phase: "available", currentVersion: "0.6.0", latestVersion: "0.9.0", error: null,
    totalBytes: 0, downloadedBytes: 0, releases: [
      { tag: "v0.9.0", title: "Stable", prerelease: false, reason: null },
      { tag: "v0.8.0-beta.1", title: "Preview", prerelease: true, reason: null },
      { tag: "v0.6.0", title: "Current", prerelease: false, reason: null },
      { tag: "v0.3.0", title: "Old", prerelease: false, reason: null },
      { tag: "v0.1.0", title: "Unavailable", prerelease: false, reason: "缺少当前平台的安装包" },
    ] });
  window.cleoDesktop = { ...window.cleoDesktop!, checkForUpdates: async tag => {
    const next = { ...update, selectedTag: tag, phase: "available" as const, latestVersion: tag?.replace(/^v/, "") || "0.9.0" };
    setUpdate(next); return next;
  } };
  const action = async (name: string, params?: Record<string, unknown>) => {
    setCalls(current => [...current, { name, params }]);
    if (name === "previewRelease") return { repository: "StDoses72/Cleo-AI-agent", url, buildId: "local",
      targetBranch: "release-branch", commit: "a".repeat(40), login: "fixture-owner" };
    if (name === "publishRelease") return { tag: params?.tag, prerelease: params?.prerelease,
      releaseUrl: `https://github.com/StDoses72/Cleo-AI-agent/releases/tag/${params?.tag}` };
  };
  return <main style={{ maxWidth: 660, margin: "0 auto", padding: 16 }}>
    <button onClick={() => setState(current => ({ ...current, githubAuth: { ...current.githubAuth!, repositoryAccess: {
      ...current.githubAuth!.repositoryAccess!, canRelease: false, role: "read-only", message: "当前账号没有直接发布权限，仍可提交 PR。" } } }))}>撤销权限（测试）</button>
    <GithubLogin auth={state.githubAuth} busy={false} onAction={() => {}} onContribute={() => {}} />
    <div className="evolution-dialog" style={{ width: "100%", maxWidth: "100%", maxHeight: "none" }}>
      <ReleasePublisher state={state} initialUrl={url} busy={false} onAction={action} />
    </div>
    <UpdateVersionPicker state={update} busy={false} />
    <output data-testid="calls" hidden>{JSON.stringify(calls)}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
