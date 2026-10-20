import { Brain, Code2, GitBranch, MessageCircle, Settings2 } from "lucide-react";
import type { WorkspaceSpace } from "../types";

interface WorkspaceRailProps {
  activeSpace: WorkspaceSpace | "evolution";
  /** Spaces holding finished replies the user has not opened yet; they get the dot. */
  unreadSpaces?: ReadonlySet<WorkspaceSpace | "evolution">;
  onSelectSpace: (space: WorkspaceSpace | "evolution") => void;
  onOpenSettings: () => void;
}

const spaces = [
  { id: "chat" as const, label: "对话", icon: MessageCircle },
  { id: "productivity" as const, label: "开发", icon: Code2 },
  { id: "evolution" as const, label: "进化", icon: GitBranch },
  { id: "memory" as const, label: "记忆", icon: Brain },
];

export function WorkspaceRail({
  activeSpace,
  unreadSpaces,
  onSelectSpace,
  onOpenSettings,
}: WorkspaceRailProps) {
  return (
    <nav className="workspace-rail" aria-label="工作区">
      <div className="brand-mark" role="img" aria-label="Cleo" />
      <div className="rail-spaces">
        {spaces.map(({ id, label, icon: Icon }) => (
          <button
            className={`rail-button ${activeSpace === id ? "active" : ""}`}
            key={id}
            type="button"
            aria-label={unreadSpaces?.has(id) ? `${label}（有未读回复）` : label}
            title={unreadSpaces?.has(id) ? `${label} · 有未读回复` : label}
            data-unread={unreadSpaces?.has(id) ? "true" : undefined}
            onClick={() => onSelectSpace(id)}
          >
            <Icon size={18} strokeWidth={1.8} />
          </button>
        ))}
      </div>
      <div className="rail-bottom">
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
