import { t as tr } from "../../electron/i18n.mjs";
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
  { id: "chat" as const, get label() { return tr("app.chat"); }, icon: MessageCircle },
  { id: "productivity" as const, get label() { return tr("app.development"); }, icon: Code2 },
  { id: "evolution" as const, get label() { return tr("app.evolution"); }, icon: GitBranch },
  { id: "memory" as const, get label() { return tr("app.memory"); }, icon: Brain },
];

export function WorkspaceRail({
  activeSpace,
  unreadSpaces,
  onSelectSpace,
  onOpenSettings,
}: WorkspaceRailProps) {
  return (
    <nav className="workspace-rail" aria-label={tr("inspector.workspace")}>
      <div className="brand-mark" role="img" aria-label="Cleo" />
      <div className="rail-spaces">
        {spaces.map(({ id, label, icon: Icon }) => (
          <button
            className={`rail-button ${activeSpace === id ? "active" : ""}`}
            key={id}
            type="button"
            aria-label={unreadSpaces?.has(id) ? tr("workspacerail.value_unread_replies", { p0: label }) : label}
            title={unreadSpaces?.has(id) ? tr("workspacerail.value_unread_replies_2", { p0: label }) : label}
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
          aria-label={tr("overlays.settings")}
          title={tr("overlays.settings")}
          onClick={onOpenSettings}
        >
          <Settings2 size={18} strokeWidth={1.8} />
        </button>
      </div>
    </nav>
  );
}
