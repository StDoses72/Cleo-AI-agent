import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Conversation } from "../src/components/Conversation";
import { EvolutionCases } from "../src/components/EvolutionCases";
import { EvolutionPreparation } from "../src/components/EvolutionPreparation";
import type { EvolutionAcceptanceState, EvolutionRequest } from "../src/evolution-types";
import type { LocalSkill } from "../src/types";
import "../src/index.css";
import "../src/components/evolution.css";

declare global {
  interface Window {
    fixtureSnapshot: () => Promise<{ acceptance: EvolutionAcceptanceState; requests: EvolutionRequest[] }>;
    fixtureAction: (action: string, params: Record<string, unknown>) => Promise<void>;
  }
}

function Fixture() {
  const [data, setData] = useState<Awaited<ReturnType<typeof window.fixtureSnapshot>>>();
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState("codex");
  const [sent, setSent] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [showComposer, setShowComposer] = useState(true);
  const skills: LocalSkill[] = (provider === "codex" ? ["grill-me", "grilling", "other"] : ["claude-only"])
    .map((name) => ({ name, command: `/${name}`, source: provider, path: `/fixture/${name}/SKILL.md` }));
  const refresh = async () => setData(await window.fixtureSnapshot());
  useEffect(() => { void refresh(); }, []);
  const action = async (name: string, params: Record<string, unknown> = {}) => {
    setBusy(true);
    try { await window.fixtureAction(name, params); }
    finally { await refresh(); setBusy(false); }
  };
  return <div style={{ maxWidth: 1000, margin: "20px auto" }}>
    <button onClick={() => setProvider(provider === "codex" ? "claude" : "codex")}>切换测试 harness</button>
    <button onClick={() => setShowComposer(false)}>查看验收测试</button>
    <output data-testid="sent">{JSON.stringify(sent)}</output>
    {showComposer && <div style={{ height: 500, position: "relative" }}><Conversation
      thread={null} project={null} space="productivity"
      runtime={{ provider, model: "test", effort: null, access: "workspace-write", approval: "deny_all", editable: true }}
      runtimeCatalog={null} productivityModels={{}} runtimeModelsLoading={null} runtimeModelsError={null}
      running={false} sendBlocked={null} prompt={prompt} onPromptChange={setPrompt}
      onRename={async () => {}} undoing={false} sidebarCollapsed={false} inspectorOpen={false}
      onToggleSidebar={() => {}} onToggleInspector={() => {}} onOpenCommand={() => {}}
      onSend={(value) => { setSent((all) => [...all, value]); setPrompt(""); }} onCancel={() => {}} onUndo={() => {}}
      onSelectNonProductivityProfile={() => {}} onSelectProductivityRuntime={() => {}}
      onLoadProductivityModels={async () => ({ provider, models: [], source: "sdk" })} onEffortChange={() => {}}
      attachments={[]} onPickAttachments={async () => {}} onPrepareAttachments={async () => {}}
      onRemoveAttachment={() => {}} onShowRun={() => {}} onShowContext={() => {}} onRevealPath={() => {}}
      onOpenPath={() => {}} onThreadCommand={() => {}} commands={["/help", "/git"]} skills={skills}
      approvalRequest={null} approvalPending={false} approvalError={null} onResolveApproval={() => {}}
    /></div>}
    <EvolutionCases state={data?.acceptance} requests={data?.requests} busy={busy} canReview canCompare
      onAction={(name, params) => { void action(name, params); }} onCreate={async () => {}}
      onImprove={(caseId, body, id) => action("feedback", { caseId, body, id, threadId: "thread" })} />
    <EvolutionPreparation requests={data?.requests || []} acceptance={data?.acceptance} preparing={busy} busy={busy}
      onResume={(request, clarification, skipClarification) => { void action("resume", {
        id: request.id, threadId: request.threadId, prompt: request.prompt, clarification, skipClarification,
      }); }} onRevise={async () => {}} />
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
