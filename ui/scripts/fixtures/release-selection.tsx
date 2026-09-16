import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { EvolutionPanel } from "../../src/components/EvolutionPanel";
import { ReleasePublisher } from "../../src/components/ReleasePublisher";
import { UpdateVersionPicker } from "../../src/components/UpdateVersionPicker";
import "../../src/index.css";
import "../../src/components/evolution.css";
import type { EvolutionState } from "../../src/evolution-types";
import type { UpdateState } from "../../src/types";

const url = "https://github.com/StDoses72/Cleo-AI-agent/pull/42";
const initial: EvolutionState = { phase: "idle", supported: true, prepared: false, draftDirty: true, currentVersion: "0.6.0",
  active: "different-running-version", baseline: null, baseTag: "v0.6.0", source: "fixture", threadId: null, error: null, logs: "",
  githubAuth: { status: "connected", message: "GitHub 已连接", repositoryAccess: { status: "checked", repository: "StDoses72/Cleo-AI-agent",
    login: "fixture-owner", role: "owner", canRelease: true, message: "有仓库写权限，可以创建 Release。" } },
  builds: [{ id: "local", name: "PR release candidate", kind: "local", version: "0.6.1", baseTag: "v0.6.0", createdAt: "2026-01-01", sourceHash: "verified" }],
  pullRequest: { url, state: "MERGED", merged: true, buildId: "local", sourceHash: "verified", targetBranch: "release-branch" },
  pullRequests: [
    { url: url.replace("42", "43"), title: "Historical merged version", state: "MERGED", merged: true, buildId: "pruned", targetBranch: "release-branch" },
    { url: url.replace("42", "44"), title: "Not merged version", state: "OPEN", merged: false, targetBranch: "release-branch" },
  ],
  releases: [], recoveryPath: null };

function Fixture() {
  const [state, setState] = useState(initial);
  const [calls, setCalls] = useState<unknown[]>([]);
  const [failPublish, setFailPublish] = useState(false);
  const [busy, setBusy] = useState(false);
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
    if (name === "retryRelease") setState(current => ({ ...current, releaseJob: { ...current.releaseJob!, phase: "building", message: "正在重试构建" } }));
    if (name === "cancelRelease") setState(current => ({ ...current, releaseJob: { ...current.releaseJob!, phase: "cancelled", message: "发布已停止" } }));
    if (name === "releasePermission") setState(initial);
    if (name === "startRelease") {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (failPublish) { setFailPublish(false); throw new Error("网络中断，请恢复连接后使用相同标签重试。"); }
      if (String(params?.url).endsWith("/44")) throw new Error("该 PR 尚未合并，暂不可发布。");
      const job = { id: "fixture-job", tag: String(params?.tag), phase: "building", message: "正在构建各平台安装包（1/4）",
        workflowUrl: "https://github.com/StDoses72/Cleo-AI-agent/actions/runs/99" };
      setState(current => ({ ...current, releaseJob: job }));
      return job;
    }
  };
  return <main style={{ maxWidth: 660, margin: "0 auto", padding: 16 }}>
    <button onClick={() => setState(current => ({ ...current, releaseJob: { ...current.releaseJob!, phase: "repairing", message: "正在调用 harness 修复发布问题（1/3）" } }))}>模拟修复</button>
    <button onClick={() => setState(current => ({ ...current, releaseJob: { ...current.releaseJob!, phase: "failed", message: "发布未完成", error: "测试构建失败" } }))}>模拟失败</button>
    <button onClick={() => setState(current => ({ ...current, releaseJob: { ...current.releaseJob!, phase: "completed", message: "安装包已齐全", releaseUrl: "https://github.com/StDoses72/Cleo-AI-agent/releases/tag/v0.8.0" } }))}>模拟完成</button>
    <button onClick={() => setFailPublish(true)}>下次发布失败（测试）</button>
    <button onClick={() => setState(current => ({ ...current, githubAuth: { ...current.githubAuth!, repositoryAccess: {
      ...current.githubAuth!.repositoryAccess!, canRelease: false, role: "read-only", message: "当前账号没有直接发布权限，仍可提交 PR。" } } }))}>撤销权限（测试）</button>
    <EvolutionPanel state={state} busy={false} running={false} error={null} inspectorOpen={false}
      onToggleInspector={() => {}} onRetry={() => {}} onRepair={() => {}} onAction={action} />
    <div className="evolution-dialog" style={{ width: "100%", maxWidth: "100%", maxHeight: "none" }}>
      <ReleasePublisher state={state} initialUrl={url} buildId="local" busy={busy} onBusy={setBusy} onAction={action} />
    </div>
    <UpdateVersionPicker state={update} busy={false} />
    <output data-testid="calls" hidden>{JSON.stringify(calls)}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
