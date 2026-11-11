import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Conversation } from "../src/components/Conversation";
import type { LocalSkill } from "../src/types";
import "../src/index.css";

/** The real composer with a harness whose local skills the slash menu searches. */
function Fixture() {
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState("codex");
  const [sent, setSent] = useState<string[]>([]);
  const skills: LocalSkill[] = (provider === "codex" ? ["grill-me", "grilling", "other"] : ["claude-only"])
    .map((name) => ({ name, command: `/${name}`, source: provider, path: `/fixture/${name}/SKILL.md` }));
  return <div style={{ maxWidth: 1000, margin: "20px auto", height: "calc(100vh - 40px)" }}>
    <style>{".fixture-conversation > .conversation-shell { height: 100%; }"}</style>
    <button onClick={() => setProvider(provider === "codex" ? "claude" : "codex")}>切换测试 harness</button>
    <output data-testid="sent">{JSON.stringify(sent)}</output>
    <div className="fixture-conversation" style={{ height: 500, position: "relative" }}><Conversation
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
    /></div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
