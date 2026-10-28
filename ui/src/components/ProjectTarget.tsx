import { t as tr } from "../../electron/i18n.mjs";
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
  const noun = space === "chat" ? tr("app.chat") : tr("computerpanel.task");

  return (
    <div className="project-target-wrap" ref={wrapRef}>
      <button
        className="text-control project-target"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={tr("projecttarget.project_for_value_value", { p0: noun, p1: noFolder ? tr("inspector.no_project") : projectLabel(active) })}
        title={noFolder ? tr("projecttarget.standalone_value_no_project_attached_click_to_choose_a_project", { p0: noun }) : active?.path}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        data-testid="project-target"
        data-choosing={choosing ? "true" : undefined}
      >
        {noFolder ? <FolderMinus size={14} /> : <FolderOpen size={14} />}
        <span className="project-target-name">{noFolder ? tr("inspector.no_project") : projectLabel(active)}</span>
        <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="project-target-menu surface-popover" role="menu" aria-label={tr("projecttarget.choose_a_project_for_value", { p0: noun })}>
          <div className="project-target-heading">{tr("projecttarget.which_project_does_this_value_belong_to", { p0: noun })}</div>
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
                    aria-label={tr("projecttarget.detach_project_value", { p0: projectLabel(project) })}
                    title={tr("projecttarget.detach_this_value_from_its_project_the_project_stays_in_the_list", { p0: noun })}
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
              <strong>{choosing ? tr("projecttarget.choosing_a_folder") : tr("projecttarget.add_project")}</strong>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
