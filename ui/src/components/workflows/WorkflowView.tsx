import { t as tr } from "../../../electron/i18n.mjs";
import { CircleAlert, Copy, LoaderCircle, Play, Plus, Sparkles, Trash2, Workflow, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkflowClient, WorkflowDefinition, WorkflowLibrary } from "../../workflow-types";
import { WorkflowEditor } from "./WorkflowEditor";
import { END, NODE_HEIGHT, NODE_WIDTH, START, TERMINAL_HEIGHT, TERMINAL_WIDTH, duplicateWorkflow, newWorkflow, workflowIssues } from "./workflow-model";
import "./workflows.css";

/** Where the workflows page is. It lives above the page so leaving and coming back keeps an unsaved edit. */
export type WorkflowScreen =
  | { name: "library" }
  /** `baseline` is the saved copy as JSON; `null` for a workflow the library does not hold yet. */
  | { name: "editor"; definition: WorkflowDefinition; baseline: string | null };

export const workflowHome: WorkflowScreen = { name: "library" };

interface WorkflowViewProps {
  client: WorkflowClient;
  screen: WorkflowScreen;
  onScreenChange: (screen: WorkflowScreen) => void;
  /** Start the workflow: it runs in a conversation, so this leaves the page for one. */
  onRun: (definition: WorkflowDefinition) => void;
  /** Describe a workflow to Cleo instead of drawing it: this leaves the page for a conversation. */
  onAsk: () => void;
  /** The library changed (saved, removed): whoever lists workflows elsewhere reads it again. */
  onLibraryChange: () => void;
  onNotify: (message: string, tone?: "success" | "error") => void;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Purpose: The library: the workflows the user keeps and the node definitions saved for reuse.
 * A workflow is drawn in the editor here and started in a conversation. */
export function WorkflowView({ client, screen, onScreenChange, onRun, onAsk, onLibraryChange, onNotify }: WorkflowViewProps) {
  const [library, setLibrary] = useState<WorkflowLibrary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const createMenu = useRef<HTMLDivElement>(null);
  // The menu closes on a press anywhere else, and on Escape.
  useEffect(() => {
    if (!creating) return;
    const close = (event: Event) => { if (!(event.target instanceof Node && createMenu.current?.contains(event.target))) setCreating(false); };
    const key = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setCreating(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", key); };
  }, [creating]);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const requests = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++requests.current;
    try {
      const loaded = await client.library();
      if (request === requests.current) { setLibrary(loaded); setLoadError(null); }
    } catch (error) {
      if (request === requests.current) setLoadError(message(error));
    }
  }, [client]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { setActionError(null); }, [screen.name]);

  if (!library) {
    return (
      <main className="workflow-view" data-testid="workflow-view">
        {loadError ? <div className="wf-banner failed" role="alert"><CircleAlert size={16} /><div><strong>{tr("workflows.load_failed")}</strong><span>{loadError}</span></div>
          <button type="button" className="wf-button" onClick={() => void refresh()}>{tr("app.retry")}</button></div>
          : <div className="wf-loading" role="status"><LoaderCircle size={16} className="spin" />{tr("overlays.loading")}</div>}
      </main>
    );
  }

  const save = async (definition: WorkflowDefinition) => {
    const saved = await client.save(definition);
    await refresh();
    onLibraryChange();
    return saved;
  };

  if (screen.name === "editor") {
    const dirty = screen.baseline === null || JSON.stringify(screen.definition) !== screen.baseline;
    const untouched = screen.baseline === null && !screen.definition.nodes.length;
    const keep = () => {
      setSaving(true);
      setActionError(null);
      return save(screen.definition)
        .then((saved) => { onScreenChange({ ...screen, definition: saved, baseline: JSON.stringify(saved) }); return saved; })
        .finally(() => setSaving(false));
    };
    return (
      <main className="workflow-view editing" data-testid="workflow-view">
        <WorkflowEditor definition={screen.definition} harnesses={library.harnesses} roles={library.roles} saved={screen.baseline !== null} dirty={dirty}
          saving={saving} error={actionError} onNotify={onNotify}
          onChange={(definition) => onScreenChange({ ...screen, definition })}
          onSave={() => void keep().then((saved) => onNotify(tr("workflows.saved_toast", { p0: saved.name })), (error: unknown) => setActionError(message(error)))}
          // What runs is what the library holds, so starting an edited workflow keeps the edit first.
          onRun={() => void (dirty ? keep() : Promise.resolve(screen.definition)).then(onRun, (error: unknown) => setActionError(message(error)))}
          onBack={() => {
            if (dirty && !untouched && !window.confirm(tr("workflows.discard_confirm"))) return;
            onScreenChange(workflowHome);
          }}
          onDraftNode={(intent, definition, nodeId) => client.draftNode(intent, definition, nodeId)}
          onSaveRole={async (fields) => {
            const role = await client.saveRole(fields);
            await refresh();
            onNotify(tr("workflows.role_kept", { p0: role.fields.role }));
          }} />
      </main>
    );
  }

  return (
    <main className="workflow-view" data-testid="workflow-view">
      <header className="wf-library-header">
        <h2>{tr("workflows.title")}</h2>
        <div className="wf-create" ref={createMenu}>
          <button type="button" className="wf-button primary" data-testid="new-workflow" aria-haspopup="menu" aria-expanded={creating}
            onClick={() => setCreating((open) => !open)}>
            <Plus size={14} />{tr("workflows.new")}
          </button>
          {creating ? (
            <div className="wf-menu surface-popover" role="menu" data-testid="new-workflow-menu">
              <button type="button" role="menuitem" data-testid="new-blank"
                onClick={() => { setCreating(false); onScreenChange({ name: "editor", definition: newWorkflow(tr("workflows.untitled")), baseline: null }); }}>
                <Plus size={14} />{tr("workflows.blank_canvas")}
              </button>
              <button type="button" role="menuitem" data-testid="ask-ai" onClick={() => { setCreating(false); onAsk(); }}>
                <Sparkles size={14} />{tr("workflows.ask_ai")}
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {library.workflows.length ? (
        <div className="wf-gallery" data-testid="workflow-list">
          {library.workflows.map((definition) => {
            const blocked = workflowIssues(definition, library.harnesses).length > 0;
            return (
              <article className="wf-tile" key={definition.id} data-testid="workflow-card">
                <button type="button" className="wf-tile-open" title={definition.description || tr("workflows.edit")} aria-label={`${tr("workflows.edit")} ${definition.name}`}
                  onClick={() => onScreenChange({ name: "editor", definition, baseline: JSON.stringify(definition) })}>
                  <WorkflowThumb definition={definition} />
                </button>
                <footer>
                  <strong title={definition.name}>{definition.name}</strong>
                  {blocked ? <CircleAlert size={14} className="wf-flag" aria-label={tr("workflows.fix_issues_first")} /> : null}
                  <button type="button" className="icon-button" aria-label={tr("workflows.duplicate_value", { p0: definition.name })} title={tr("workflows.duplicate")}
                    onClick={() => void save(duplicateWorkflow(definition, tr("workflows.copy_name", { p0: definition.name })))
                      .catch((error: unknown) => onNotify(message(error), "error"))}><Copy size={14} /></button>
                  <button type="button" className="icon-button" aria-label={tr("workflows.delete_value", { p0: definition.name })} title={tr("workflows.delete")}
                    onClick={() => {
                      if (!window.confirm(tr("workflows.delete_confirm", { p0: definition.name }))) return;
                      void client.remove(definition.id).then(refresh).then(() => { onLibraryChange(); onNotify(tr("workflows.deleted_toast", { p0: definition.name })); })
                        .catch((error: unknown) => onNotify(message(error), "error"));
                    }}><Trash2 size={14} /></button>
                  <button type="button" className="wf-button primary" disabled={blocked} data-testid="workflow-card-run"
                    title={blocked ? tr("workflows.fix_issues_first") : undefined} onClick={() => onRun(definition)}>
                    <Play size={13} />{tr("workflows.run")}
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="wf-empty" data-testid="workflow-empty">
          <Workflow size={20} />
          <strong>{tr("workflows.empty_title")}</strong>
        </div>
      )}

      {library.roles.length ? (
        <section className="wf-roles" aria-label={tr("workflows.kept_roles")}>
          <h3>{tr("workflows.kept_roles")}</h3>
          <ul data-testid="workflow-roles">
            {library.roles.map((role) => (
              <li key={role.id} title={role.fields.instructions}>
                <span>{role.fields.role}</span>
                <button type="button" aria-label={tr("workflows.delete_value", { p0: role.fields.role })} title={tr("workflows.delete")}
                  onClick={() => void client.removeRole(role.id).then(refresh).catch((error: unknown) => onNotify(message(error), "error"))}><X size={12} /></button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

/** Purpose: A workflow at a glance, as its shape: nodes as blocks where they sit on the canvas,
 * edges between them, a way back as a dashed curve. No words. */
export function WorkflowThumb({ definition }: { definition: WorkflowDefinition }) {
  const boxes = [
    { id: START, ...definition.start, w: TERMINAL_WIDTH, h: TERMINAL_HEIGHT }, { id: END, ...definition.end, w: TERMINAL_WIDTH, h: TERMINAL_HEIGHT },
    ...definition.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y, w: NODE_WIDTH, h: NODE_HEIGHT })),
  ];
  const at = new Map(boxes.map((box) => [box.id, box]));
  const left = Math.min(...boxes.map((box) => box.x)) - 24;
  const top = Math.min(...boxes.map((box) => box.y)) - 16;
  const right = Math.max(...boxes.map((box) => box.x + box.w)) + 100;
  const bottom = Math.max(...boxes.map((box) => box.y + box.h)) + 16;
  return (
    <svg className="wf-thumb" viewBox={`${left} ${top} ${right - left} ${bottom - top}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {definition.edges.map((edge) => {
        const from = at.get(edge.from);
        const to = at.get(edge.to);
        if (!from || !to) return null;
        if (edge.loop) {
          const reach = Math.max(from.x + from.w, to.x + to.w) + 72;
          return <path key={edge.id} className="loop" d={`M ${from.x + from.w} ${from.y + from.h / 2} C ${reach} ${from.y + from.h / 2}, ${reach} ${to.y + to.h / 2}, ${to.x + to.w} ${to.y + to.h / 2}`} />;
        }
        const startX = from.x + from.w / 2;
        const startY = from.y + from.h;
        const endX = to.x + to.w / 2;
        const bend = Math.max(16, Math.abs(to.y - startY) / 2);
        return <path key={edge.id} d={`M ${startX} ${startY} C ${startX} ${startY + bend}, ${endX} ${to.y - bend}, ${endX} ${to.y}`} />;
      })}
      {boxes.map((box) => <rect key={box.id} className={box.id === START || box.id === END ? "end" : ""} x={box.x} y={box.y} width={box.w} height={box.h} rx={box.h === NODE_HEIGHT ? 10 : 15} />)}
    </svg>
  );
}
