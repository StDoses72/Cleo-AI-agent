import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ComputerPreview } from "../../src/components/ComputerPreview";
import "../../src/index.css";
import type { Thread } from "../../src/types";

const thread = { id: "fixture", waitingFor: "approval", items: [
  { id: "step", type: "tool", name: "mcp__cleo_computer__computer_call", status: "running",
    command: '{"name":"Snapshot","arguments":{"use_vision":true}}' },
] } as Thread;
function Fixture() {
  const [open, setOpen] = useState(true);
  const [running, setRunning] = useState(true);
  return <div style={{ padding: 24, height: "100%", overflow: "auto" }}>
    <button onClick={() => setOpen(value => !value)}>切换面板</button>
    <button onClick={() => setRunning(value => !value)}>切换运行状态</button>
    <aside className="inspector" style={{ width: 420, height: 680, marginTop: 12 }}>
      {open && <ComputerPreview thread={thread} running={running} onStop={() => {
        document.documentElement.dataset.stopped = "true";
      }} />}
    </aside>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
