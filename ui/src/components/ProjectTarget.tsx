import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, FolderMinus, FolderOpen, FolderPlus, Trash2 } from "lucide-react";
import { isGeneralProject, projectLabel, projectPathLabel, projectsInSpace } from "../runtime-labels";
import type { Project, ThreadSpace } from "../types";

interface ProjectTargetProps {
  space: ThreadSpace;
  projects: Project[];
  activeProjectId: string;
  disabled?: boolean;
  choosing?: boolean;
  onSelect: (projectId: string) => void;
  onChooseWorkspace: () => void;
  onRemoveProject?: (project: Project) => void;
}

/** Purpose: Show, and let the user change, which project an unsent draft belongs to.
 * Input: the space's projects and the draft's current project. Output: a pill in the composer
 * that reads 不关联项目 until a project is chosen; the menu offers that, every project, and
 * adding a project from a local folder. A standalone draft is not a project of its own in
 * the interface: the backend keeps those threads in its general project, which never appears
 * here by name. Existing threads keep their project, so the pill only renders while drafting.
 */
export function ProjectTarget({
  space,
  projects,
  activeProjectId,
  disabled = false,
  choosing = false,
  onSelect,
  onChooseWorkspace,
  onRemoveProject,
}: ProjectTargetProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const ordered = projectsInSpace(projects, space);
  const active = ordered.find((project) => project.id === activeProjectId)
    ?? ordered.find(isGeneralProject) ?? ordered[0];
  const noFolder = !active || isGeneralProject(active);
  const noun = space === "chat" ? "对话" : "任务";
  const optionLabel = (project: Project) => (isGeneralProject(project) ? "不关联项目" : projectLabel(project));

  return (
    <div className="project-target-wrap" ref={wrapRef}>
      <button
        className="text-control project-target"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${noun}所属项目：${noFolder ? "不关联项目" : projectLabel(active)}`}
        title={noFolder ? `独立${noun}，不关联项目；点击可选择一个项目` : active?.path}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        data-testid="project-target"
        data-choosing={choosing ? "true" : undefined}
      >
        {noFolder ? <FolderMinus size={14} /> : <FolderOpen size={14} />}
        <span className="project-target-name">{noFolder ? "不关联项目" : projectLabel(active)}</span>
        <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="project-target-menu surface-popover" role="menu" aria-label={`选择${noun}所属项目`}>
          <div className="project-target-heading">{`${noun}属于哪个项目`}</div>
          {ordered.map((project) => {
            const selected = project.id === active?.id;
            const general = isGeneralProject(project);
            return (
              <div className="project-target-row" key={project.id}>
                <button
                  className={`project-target-option ${selected ? "selected" : ""}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  aria-label={optionLabel(project)}
                  onClick={() => {
                    setOpen(false);
                    onSelect(project.id);
                  }}
                >
                  <span className={`project-glyph compact ${general ? "plain" : ""}`} style={{ "--project-accent": project.accent } as CSSProperties}>
                    {general ? <FolderMinus size={12} /> : projectLabel(project).slice(0, 1)}
                  </span>
                  <span className="project-target-copy">
                    <strong>{optionLabel(project)}</strong>
                    <small>{general ? `独立${noun}：一次性脚本、探索和提问` : projectPathLabel(project)}</small>
                  </span>
                  {selected ? <Check size={14} /> : null}
                </button>
                {onRemoveProject && project.removable ? (
                  <button
                    className="project-target-remove"
                    type="button"
                    aria-label={`移除项目 ${projectLabel(project)}`}
                    title="移除项目（不删除本地文件）"
                    onClick={() => {
                      setOpen(false);
                      onRemoveProject(project);
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                ) : null}
              </div>
            );
          })}
          <button
            className="project-target-option project-target-open"
            type="button"
            role="menuitem"
            disabled={choosing}
            onClick={() => {
              setOpen(false);
              onChooseWorkspace();
            }}
            data-testid="choose-workspace"
          >
            <span className="project-glyph compact"><FolderPlus size={13} /></span>
            <span className="project-target-copy">
              <strong>{choosing ? "正在选择文件夹…" : "添加项目…"}</strong>
              <small>{space === "chat" ? "选择一个目录来归档对话和记忆" : "选择本地文件夹作为项目，任务在它的目录里运行"}</small>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
