import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ContributionMerge } from "../../src/components/ContributionMerge";
import "../../src/index.css";
import "../../src/components/evolution.css";

declare global { interface Window { mergeTest: { offset: number; reads: string[]; hold: boolean; finish?: () => void } } }
window.mergeTest = { offset: 0, reads: [], hold: false };
const now = Date.now;
Date.now = () => now() + window.mergeTest.offset;

function Fixture() {
  const [mode, setMode] = useState("conflict");
  const [action, setAction] = useState("");
  const [target, setTarget] = useState("target");
  const onAction = async (name: string, params?: Record<string, unknown>) => {
    setAction(`${name}:${params?.url || params?.targetBranch}`);
    if (name === "repairContribution") return;
    window.mergeTest.reads.push(String(params?.url || params?.targetBranch));
    if (window.mergeTest.hold) {
      window.mergeTest.hold = false;
      await new Promise<void>(resolve => { window.mergeTest.finish = resolve; });
    }
    if (mode === "error") throw new Error("HTTP 403: permission denied");
    return { url: params?.url, state: params?.url ? "OPEN" : undefined, targetBranch: target,
      baseSha: "a".repeat(40), headSha: "b".repeat(40), checkedAt: new Date().toISOString(),
      snapshotFormat: !params?.url && mode === "clean" ? "empty-target-snapshot-v1" : undefined, fileCount: 512,
      compatible: mode === "clean", conflicts: mode === "conflict" ? ["ui/src/App.tsx"] : [],
      canUpdate: false, mergeStateStatus: "BLOCKED", checks: [{ name: "build", conclusion: "FAILURE" }] };
  };
  return <main style={{ padding: 24, maxWidth: 850 }}>
    <button onClick={() => setMode("clean")}>fixture clean</button>
    <button onClick={() => { setMode("error"); setTarget("error-target"); }}>fixture error</button>
    <button onClick={() => setTarget("changed")}>fixture target</button>
    <output data-testid="action">{action}</output>
    <ContributionMerge params={{ url: "https://github.com/StDoses72/Cleo-AI-agent/pull/49" }} busy={false} onAction={onAction} />
    <ContributionMerge params={{ targetBranch: target, buildId: "selected" }} busy={false} onAction={onAction} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
