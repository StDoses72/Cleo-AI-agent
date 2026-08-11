import { Brain, Code2, MessageCircle, Settings2 } from "lucide-react";
import type { WorkspaceSpace } from "../types";

interface WorkspaceRailProps {
  activeSpace: WorkspaceSpace;
  onSelectSpace: (space: WorkspaceSpace) => void;
  onOpenSettings: () => void;
}

const spaces = [
  { id: "chat" as const, label: "对话", icon: MessageCircle },
  { id: "productivity" as const, label: "开发", icon: Code2 },
  { id: "memory" as const, label: "记忆", icon: Brain },
];

export function WorkspaceRail({
  activeSpace,
  onSelectSpace,
  onOpenSettings,
}: WorkspaceRailProps) {
  return (
    <nav className="workspace-rail" aria-label="工作区">
      <div className="brand-mark" aria-label="Cleo">
        <span>C</span>
      </div>
      <div className="rail-spaces">
        {spaces.map(({ id, label, icon: Icon }) => (
          <button
            className={`rail-button ${activeSpace === id ? "active" : ""}`}
            key={id}
            type="button"
            aria-label={label}
            title={label}
            onClick={() => onSelectSpace(id)}
          >
            <Icon size={18} strokeWidth={1.8} />
          </button>
        ))}
      </div>
      <div className="rail-bottom">
        <span className="runtime-dot" title="本地 runtime 已就绪" />
        <button
          className="rail-button"
          type="button"
          aria-label="设置"
          title="设置"
          onClick={onOpenSettings}
        >
          <Settings2 size={18} strokeWidth={1.8} />
        </button>
      </div>
    </nav>
  );
}
