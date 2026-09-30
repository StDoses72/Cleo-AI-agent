import { useState } from "react";
import { createRoot } from "react-dom/client";
import { EvolutionPanel } from "../../src/components/EvolutionPanel";
import { useEvolution } from "../../src/useEvolution";
import type { EvolutionState } from "../../src/evolution-types";
import "../../src/index.css";
import "../../src/components/evolution.css";

declare global { interface Window { evolutionUI: typeof control } }
const control = { branches: ["main", "submission-base", "accept-existing"], failCatalog: false,
  reads: [] as string[], writes: [] as { action: string; params: Record<string, unknown> }[],
  activeReads: 0, maxReads: 0, failSubmit: true, offset: 0, finishLogin: null as (() => void) | null,
  holdState: false, finishState: null as (() => void) | null };
window.evolutionUI = control;
const now = Date.now;
Date.now = () => now() + control.offset;
const listeners = new Set<(state: EvolutionState) => void>();
let state: EvolutionState = { phase: "idle", supported: true, prepared: true, currentVersion: "0.4.8",
  active: "local", baseline: "base", baseTag: "v0.4.8", source: "fixture", threadId: null, error: null, logs: "",
  githubAuth: { status: "connected", message: "Connected", repositoryAccess: { status: "checked", repository: "fixture", login: "fixture", canRelease: false, message: "PR only" } },
  builds: [
    { id: "base", kind: "official", version: "0.4.8", baseTag: "v0.4.8", createdAt: "2026-01-01" },
    { id: "local", kind: "local", version: "0.4.8", name: "当前改进", sourceHash: "verified", baseTag: "v0.4.8", createdAt: "2026-01-02", savedAt: "2026-01-02" },
  ], pullRequest: null, pullRequests: [{ url: "https://github.com/StDoses72/Cleo-AI-agent/pull/7", number: 7, title: "旧改进", state: "OPEN", merged: false }],
  branchRequests: [{ id: "request", branch: "waiting", body: "申请说明", buildId: "local", buildName: "当前改进", sourceHash: "verified", status: "requested", createdAt: "2026-01-01", url: "https://github.com/StDoses72/Cleo-AI-agent/issues/8" }],
  releases: [], recoveryPath: null };
const setState = (patch: Partial<EvolutionState>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(state); };
const reads = new Set(["contributionBranches", "checkContribution", "mergeAssistance", "releases"]);
window.cleoDesktop = { ...window.cleoDesktop!, getEvolutionState: async () => {
  const loaded = structuredClone(state);
  if (control.holdState) await new Promise<void>(resolve => { control.finishState = resolve; });
  return loaded;
},
  onEvolutionState: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  evolutionAction: async <T,>(action: string, params: Record<string, unknown> = {}): Promise<T> => {
    const reading = reads.has(action);
    if (reading) { control.reads.push(action); control.activeReads++; control.maxReads = Math.max(control.maxReads, control.activeReads); }
    else control.writes.push({ action, params });
    setState({ phase: reading ? "checking" : "submitting" });
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      if (action === "login") {
        setState({ phase: "authenticating", githubAuth: { status: "waiting", code: "TEST-CODE", message: "请输入验证码完成授权。" } });
        await new Promise<void>(resolve => { control.finishLogin = resolve; });
        setState({ githubAuth: { status: "connected", message: "已连接" } });
        return state.githubAuth as T;
      }
      if (action === "contributionBranches") {
        if (control.failCatalog) throw new Error("无法读取分支（测试）");
        return [...control.branches] as T;
      }
      if (action === "checkContribution" || action === "mergeAssistance") return {
        baseSha: "a".repeat(40), headSha: "b".repeat(40), targetBranch: params.targetBranch || "waiting",
        snapshotFormat: params.url ? undefined : "empty-target-snapshot-v1", checkedAt: new Date().toISOString(),
        compatible: true, url: params.url, state: "OPEN", checks: [{ name: "build", conclusion: "SUCCESS" }], canUpdate: true,
      } as T;
      if (action === "releases") return [{ tag: "v0.4.9", title: "Release", reason: null, prerelease: false }] as T;
      if (action === "submit") {
        if (control.failSubmit) { control.failSubmit = false; throw new Error("提交网络失败（测试）"); }
        const url = "https://github.com/StDoses72/Cleo-AI-agent/pull/9";
        setState({ pullRequests: [...state.pullRequests!, { url, number: 9, title: String(params.title), state: "OPEN", merged: false }] });
        return url as T;
      }
      throw new Error(`Unexpected action: ${action}`);
    } finally { if (reading) control.activeReads--; setState({ phase: "idle" }); }
  },
};

function Fixture() {
  const evolution = useEvolution();
  const [otherRunning, setOtherRunning] = useState(false);
  return <main style={{ minHeight: "100vh" }}>
    <button onClick={() => setOtherRunning(value => !value)}>其他任务运行（测试）</button>
    <button onClick={() => setState({ githubAuth: { status: "disconnected", message: "请连接 GitHub。" } })}>断开账号（测试）</button>
    <button onClick={() => void evolution.refresh()}>读取状态（测试）</button>
    <button onClick={() => setState({ error: "新状态已经到达" })}>发送新状态（测试）</button>
    <EvolutionPanel state={evolution.state} error={evolution.error} busy={evolution.pending || evolution.state?.phase !== "idle"}
      running={false} otherTasksRunning={otherRunning} inspectorOpen={false} onToggleInspector={() => {}} onRetry={() => {}} onRepair={() => {}}
      onAction={(action, params) => reads.has(action) ? evolution.inspect(action, params) : evolution.run(action, params)} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
