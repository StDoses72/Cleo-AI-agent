import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ComputerPanel } from "../../src/components/ComputerPanel";
import { FilesPanel, type FileReveal } from "../../src/components/FilesPanel";
import { Modal } from "../../src/components/Modal";
import "../../src/index.css";
import type { Thread } from "../../src/types";

const thread = { id: "fixture", items: [
  { id: "step", type: "tool", name: "mcp__cleo_computer__computer_call", status: "running",
    command: '{"name":"browser_click","arguments":{"x":1,"y":2}}' },
] } as unknown as Thread;

function Fixture() {
  const [reveal, setReveal] = useState<FileReveal | null>(null);
  const [dialog, setDialog] = useState(false);
  const [settings, setSettings] = useState(false);
  return <div style={{ display: "flex", gap: 16, padding: 16, height: "100vh", boxSizing: "border-box" }}>
    <aside className="inspector" style={{ width: 460, height: 760, display: "flex", flexDirection: "column" }}>
      <ComputerPanel thread={thread} running onStop={() => { document.documentElement.dataset.chatStopped = "true"; }} />
    </aside>
    <aside className="inspector" style={{ width: 420, height: 760, display: "flex", flexDirection: "column" }}>
      <button type="button" onClick={() => setReveal({ path: "src/app.ts", line: 3, nonce: Date.now() })}>定位聊天链接</button>
      <button type="button" onClick={() => setDialog(value => !value)}>切换对话框</button>
      <button type="button" onClick={() => setSettings(true)}>打开保留的设置</button>
      {dialog && <dialog open aria-label="示例对话框">fixture dialog</dialog>}
      <FilesPanel root={"C:\\work"} reveal={reveal} onNotify={() => {}} onCopyText={() => {}}
        onOpenExternal={path => { document.documentElement.dataset.external = path; }}
        onOpenBrowser={() => { document.documentElement.dataset.browser = "open"; }} />
    </aside>
    <Modal open={settings} className="overlay-backdrop settings-backdrop" label="保留的设置"
      onClose={() => setSettings(false)}>
      <div className="settings-modal">
        <button type="button" onClick={() => setSettings(false)}>关闭保留的设置</button>
      </div>
    </Modal>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
