import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, FolderMinus, FolderOpen, FolderPlus, X } from "lucide-react";
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
}

/** Purpose: Show, and let the user change, which project an unsent draft belongs to.
 * Input: the space's projects and the draft's current project. Output: a pill in the composer
 * that reads 不关联项目 until a project is chosen; the menu lists every real project and
 * adding one from a local folder. "No project" has no row of its own: it is simply the state
 * where nothing in the list is selected, and the selected project carries a clear button that
 * returns the draft to it. The backend keeps folder-less threads in its general project, which
 * never appears here by name; this menu never removes a project, only the draft's link to it.
 * Existing threads keep their project, so the pill only renders while drafting.
 */
export function ProjectTarget({
  space,
  projects,
  activeProjectId,
  disabled = false,
  choosing = false,
  onSelect,
  onChooseWorkspace,
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
  const general = ordered.find(isGeneralProject);
  const active = ordered.find((project) => project.id === activeProjectId) ?? general ?? ordered[0];
  const noFolder = !active || isGeneralProject(active);
  const listed = ordered.filter((project) => !isGeneralProject(project));
  const noun = space === "chat" ? "对话" : "任务";

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
          {listed.map((project) => {
            const selected = !noFolder && project.id === active?.id;
            return (
              <div className="project-target-row" key={project.id}>
                <button
                  className={`project-target-option ${selected ? "selected" : ""}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  aria-label={projectLabel(project)}
                  onClick={() => {
                    setOpen(false);
                    onSelect(project.id);
                  }}
                >
                  <span className="project-glyph compact" style={{ "--project-accent": project.accent } as CSSProperties}>
                    {projectLabel(project).slice(0, 1)}
                  </span>
                  <span className="project-target-copy">
                    <strong>{projectLabel(project)}</strong>
                    <small>{projectPathLabel(project)}</small>
                  </span>
                  {selected ? <Check size={14} /> : null}
                </button>
                {selected && general ? (
                  <button
                    className="project-target-clear"
                    type="button"
                    aria-label={`取消关联项目 ${projectLabel(project)}`}
                    title={`取消关联，${noun}改为不关联项目（项目保留在列表中）`}
                    onClick={() => {
                      setOpen(false);
                      onSelect(general.id);
                    }}
                    data-testid="project-target-clear"
                  >
                    <X size={13} />
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
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
