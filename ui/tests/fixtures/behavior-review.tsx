import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { EvolutionCases } from "../../src/components/EvolutionCases";
import { EvolutionPanel } from "../../src/components/EvolutionPanel";
import { UpdateNotice } from "../../src/components/Overlays";
import "../../src/index.css";
import "../../src/components/evolution.css";

const item = { id: "case", title: "发现本机 skills", expectation: "输入 / 后显示当前 harness 的 skills。",
  evidence: "当前行为：源码分析显示只有固定命令，尚未运行验证。\n操作：在 Codex 会话输入 / 并查找 eli5。",
  enabled: true, kind: "manual", sourceThread: "fixture", baseline: "base" };

function Fixture() {
  const [active, setActive] = useState("base");
  const [passed, setPassed] = useState(false);
  const [valid, setValid] = useState(true);
  const [automatic, setAutomatic] = useState(false);
  const [checkFails, setCheckFails] = useState(true);
  const [comparisons, setComparisons] = useState(0);
  const [downloads, setDownloads] = useState(0);
  const [installs, setInstalls] = useState(0);
  const [updatePhase, setUpdatePhase] = useState("available");
  const acceptance = { cases: [{ ...item, kind: automatic ? "dream-format" : "manual", enabled: !passed }], fresh: true, report: { candidate: "new", sourceHash: "hash",
    results: [{ id: "case", before: { status: automatic ? "passed" : "manual", detail: "generic placeholder" },
      after: { status: automatic ? checkFails ? "error" : "passed" : passed ? "passed" : "manual", detail: passed ? "已应用并观察到 eli5" : "generic placeholder" } }] } };
  const state = { active, candidate: "new", phase: "idle", builds: [
    { id: "base", kind: "official", version: "0.4.0" }, { id: "new", kind: "local", sourceHash: "hash" }],
    iteration: { base: "base" }, validation: { status: valid ? "passed" : "failed", candidate: "new", sourceHash: "hash" },
    githubAuth: { status: "connected" }, acceptance };
  const action = (name: string) => { if (name === "apply") setActive("new"); if (name === "completeCase") setPassed(true); if (name === "compareCases") { setCheckFails(false); setComparisons(value => value + 1); } };
  return <>
    <button onClick={() => setValid((value) => !value)}>切换构建检查结果</button>
    <button onClick={() => setAutomatic(true)}>自动检查失败（测试）</button>
    <output data-testid="comparison-count">{comparisons}</output>
    <output data-testid="update-counts">{downloads}:{installs}</output>
    <EvolutionPanel state={state as any} busy={false} running={false} error={null} inspectorOpen={false}
      onToggleInspector={() => {}} onAction={action} onRetry={() => {}} onRepair={() => {}}>
      <EvolutionCases state={acceptance as any} busy={false} canReview={active === "new"}
        onAction={action} onImprove={async () => {}} onCreate={async () => {}} />
    </EvolutionPanel>
    <UpdateNotice state={{ phase: updatePhase, latestVersion: "0.4.1", downloadedBytes: 0, totalBytes: 1 } as any}
      onDownload={() => { setDownloads((value) => value + 1); setUpdatePhase("ready"); }}
      onInstall={() => setInstalls((value) => value + 1)} />
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
