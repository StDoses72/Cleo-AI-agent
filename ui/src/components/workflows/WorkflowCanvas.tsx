import { t as tr } from "../../../electron/i18n.mjs";
import { Ban, Check, CircleAlert, Copy, LoaderCircle, Maximize, Minus, Network, Pencil, Plus, Repeat, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import type {
  WorkflowDefinition,
  WorkflowExecutor,
  WorkflowNode,
  WorkflowNodeStatus,
  WorkflowRun,
} from "../../workflow-types";
import { executorLabel, refusalText } from "./workflow-labels";
import {
  END, GRID, NODE_HEIGHT, NODE_WIDTH, START, TERMINAL_HEIGHT, TERMINAL_WIDTH,
  addNode, autoLayout, connect, freeSpot, newNode, removeEdge, removeNode, snap,
} from "./workflow-model";

export type CanvasSelection = { kind: "node" | "edge"; id: string } | null;

/** A node the user can drop in ready-made: a role with its instructions already written. */
export interface NodePreset {
  key: string;
  label: string;
  fields: Partial<WorkflowNode>;
}

interface WorkflowCanvasProps {
  definition: WorkflowDefinition;
  executors: readonly WorkflowExecutor[];
  selection: CanvasSelection;
  onSelect: (selection: CanvasSelection) => void;
  /** Absent on a canvas that only shows: nothing can be created, moved or connected. */
  onChange?: (definition: WorkflowDefinition) => void;
  presets?: readonly NodePreset[];
  /** With a run, every node shows where that run is. */
  run?: WorkflowRun | null;
  /** Ids of nodes and edges that keep the workflow from running. */
  flagged?: ReadonlySet<string>;
  /** A connection that cannot exist says why. */
  onNotice?: (message: string) => void;
  /** Double-click on a node: the user wants to edit it. */
  onOpenNode?: (nodeId: string) => void;
}

interface View { x: number; y: number; k: number }
interface Point { x: number; y: number }

type Drag =
  | { kind: "pan"; startX: number; startY: number; viewX: number; viewY: number }
  | { kind: "node"; id: string; startX: number; startY: number; originX: number; originY: number; x: number; y: number; moved: boolean }
  | { kind: "connect"; from: string; x: number; y: number; over: string | null }
  | { kind: "palette"; preset: NodePreset; startX: number; startY: number; x: number; y: number; moved: boolean };

interface Menu {
  left: number;
  top: number;
  /** Where on the canvas it was opened, in the workflow's own coordinates. */
  point: Point;
  target: { kind: "canvas" } | { kind: "node"; id: string } | { kind: "edge"; id: string } | { kind: "connect"; from: string };
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 1.6;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Where a run has got to on one node: running while any of its sessions is, otherwise how the latest ended. */
export function nodeStatus(run: WorkflowRun, node: WorkflowNode): WorkflowNodeStatus {
  const sessions = run.sessions.filter((session) => session.nodeId === node.id);
  if (!sessions.length) return "pending";
  if (sessions.some((session) => session.status === "running")) return "running";
  if (sessions.at(-1)!.status === "done") return "done";
  // Copies started together end together: one failure is the node's, whichever copy is listed last.
  return sessions.slice(-(node.each ?? 1)).some((session) => session.status === "failed") ? "failed" : sessions.at(-1)!.status;
}

/** Purpose: The workflow as a graph the user builds by hand: nodes are dragged into place, created
 * from the right-click menu or the palette, and joined by dragging from a node's right edge.
 * An edge drawn back to an earlier node becomes a loop. Without `onChange` it only shows. */
export function WorkflowCanvas({ definition, executors, selection, onSelect, onChange, presets = [], run, flagged, onNotice, onOpenNode }: WorkflowCanvasProps) {
  const editable = Boolean(onChange);
  const root = useRef<HTMLDivElement>(null);
  const markers = `wf-arrow-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const nodes = useMemo(() => new Map(definition.nodes.map((node) => [node.id, node])), [definition.nodes]);
  const judges = useMemo(() => new Set(definition.edges.filter((edge) => edge.loop).map((edge) => edge.from)), [definition.edges]);

  /** Top-left corner of a node or an end, following the pointer while it is dragged. */
  const place = (id: string): Point | null => {
    if (drag?.kind === "node" && drag.id === id && drag.moved) return { x: drag.x, y: drag.y };
    if (id === START) return definition.start;
    if (id === END) return definition.end;
    return nodes.get(id) ?? null;
  };
  const terminal = (id: string) => id === START || id === END;
  // The flow runs top to bottom: an edge leaves the bottom of a node and arrives at the top of
  // the next; a way back leaves and arrives at the right side, so it never crosses the flow.
  const outPort = (id: string, at: Point) => terminal(id) ? { x: at.x + TERMINAL_WIDTH / 2, y: at.y + TERMINAL_HEIGHT } : { x: at.x + NODE_WIDTH / 2, y: at.y + NODE_HEIGHT };
  const inPort = (id: string, at: Point) => ({ x: at.x + (terminal(id) ? TERMINAL_WIDTH : NODE_WIDTH) / 2, y: at.y });
  const flank = (at: Point) => ({ x: at.x + NODE_WIDTH, y: at.y + NODE_HEIGHT / 2 });
  const forwardPath = (start: Point, end: Point, gap = 3) => {
    const bend = clamp(Math.abs(end.y - start.y) / 2, 24, 100);
    return `M ${start.x} ${start.y} C ${start.x} ${start.y + bend}, ${end.x} ${end.y - bend}, ${end.x} ${end.y - gap}`;
  };
  const loopPath = (start: Point, end: Point) => {
    const reach = Math.max(start.x, end.x) + 72;
    return { path: `M ${start.x} ${start.y} C ${reach} ${start.y}, ${reach} ${end.y}, ${end.x + 3} ${end.y}`,
      label: { x: (start.x + end.x) / 8 + reach * 0.75, y: (start.y + end.y) / 2 } };
  };

  const toWorld = (clientX: number, clientY: number): Point => {
    const box = root.current!.getBoundingClientRect();
    return { x: (clientX - box.left - view.x) / view.k, y: (clientY - box.top - view.y) / view.k };
  };

  const fit = useCallback(() => {
    const element = root.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    if (!width || !height) return;
    const loops = definition.edges.some((edge) => edge.loop);
    const boxes = [
      { ...definition.start, w: TERMINAL_WIDTH, h: TERMINAL_HEIGHT }, { ...definition.end, w: TERMINAL_WIDTH, h: TERMINAL_HEIGHT },
      ...definition.nodes.map((node) => ({ x: node.x, y: node.y, w: NODE_WIDTH + (loops ? 110 : 0), h: NODE_HEIGHT })),
    ];
    const left = Math.min(...boxes.map((box) => box.x));
    const top = Math.min(...boxes.map((box) => box.y));
    const spanX = Math.max(...boxes.map((box) => box.x + box.w)) - left;
    const spanY = Math.max(...boxes.map((box) => box.y + box.h)) - top;
    // Room for the palette above and the hint and zoom controls below.
    const above = editable ? 60 : 24;
    const below = editable ? 52 : 24;
    const k = clamp(Math.min((width - 64) / spanX, (height - above - below) / spanY, 1), MIN_ZOOM, 1);
    setView({ k, x: (width - spanX * k) / 2 - left * k, y: above + (height - above - below - spanY * k) / 2 - top * k });
  }, [definition, editable]);
  // A workflow opens fitted to the canvas; after that the view is the user's.
  useLayoutEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition.id]);
  // A canvas that only shows keeps the whole graph in view as its pane changes size.
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useEffect(() => {
    const element = root.current;
    if (editable || !element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fitRef.current());
    observer.observe(element);
    return () => observer.disconnect();
  }, [editable]);

  // A node selected from elsewhere (a duplicate, an issue in the list, an undo) may lie outside the
  // view; the view moves just far enough to show it. A node the user clicks is already in view.
  const selectedNodeId = selection?.kind === "node" ? selection.id : null;
  useEffect(() => {
    const node = selectedNodeId ? nodes.get(selectedNodeId) : undefined;
    const element = root.current;
    if (!node || !element) return;
    const { width, height } = element.getBoundingClientRect();
    setView((current) => {
      const left = node.x * current.k + current.x;
      const top = node.y * current.k + current.y;
      const right = left + NODE_WIDTH * current.k;
      const bottom = top + NODE_HEIGHT * current.k;
      const above = editable ? 52 : 12;
      const dx = right > width - 16 ? width - 16 - right : left < 16 ? 16 - left : 0;
      const dy = bottom > height - 48 ? height - 48 - bottom : top < above ? above - top : 0;
      return dx || dy ? { ...current, x: current.x + dx, y: current.y + dy } : current;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeId]);

  const zoom = (factor: number, originX?: number, originY?: number) => setView((current) => {
    const box = root.current!.getBoundingClientRect();
    const cx = originX ?? box.width / 2;
    const cy = originY ?? box.height / 2;
    const k = clamp(current.k * factor, MIN_ZOOM, MAX_ZOOM);
    return { k, x: cx - (cx - current.x) * (k / current.k), y: cy - (cy - current.y) * (k / current.k) };
  });
  // Ctrl or Command with the wheel (a trackpad pinch) zooms; a plain wheel still scrolls the page.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const box = element.getBoundingClientRect();
      zoom(Math.exp(-event.deltaY * 0.002), event.clientX - box.left, event.clientY - box.top);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  const menuElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    // Focus without scrolling: the canvas must never move under the pointer.
    menuElement.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const close = (event: Event) => { if (!(event.target instanceof Element && event.target.closest(".wf-menu"))) setMenu(null); };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [menu]);

  const create = (preset: NodePreset, x: number, y: number, from?: string) => {
    if (!onChange) return;
    const node = newNode(x, y, preset.fields);
    let next = addNode(definition, node);
    if (from) {
      const linked = connect(next, from, node.id);
      if ("definition" in linked) next = linked.definition;
    }
    onChange(next);
    onSelect({ kind: "node", id: node.id });
  };
  const link = (from: string, to: string) => {
    if (!onChange) return;
    const linked = connect(definition, from, to);
    if ("refused" in linked) { onNotice?.(refusalText(linked.refused)); return; }
    onChange(linked.definition);
    // A way back has settings (how many rounds); show them at once.
    onSelect(linked.edge.loop ? { kind: "edge", id: linked.edge.id } : selection);
  };
  const remove = (target: NonNullable<CanvasSelection>) => {
    if (!onChange) return;
    onChange(target.kind === "node" ? removeNode(definition, target.id) : removeEdge(definition, target.id));
    onSelect(null);
  };
  const duplicate = (nodeId: string) => {
    const node = nodes.get(nodeId);
    if (!node || !onChange) return;
    const { id: _original, ...fields } = node;
    const copy = newNode(node.x + NODE_WIDTH + 24, node.y, fields);
    onChange(addNode(definition, copy));
    onSelect({ kind: "node", id: copy.id });
  };

  const nodeUnder = (clientX: number, clientY: number) => {
    const hit = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-node-id]");
    return hit && root.current?.contains(hit) ? hit.dataset.nodeId ?? null : null;
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest("[data-canvas-control]")) return;
    const element = target.closest<HTMLElement>("[data-node-id]");
    const edge = target.closest<HTMLElement | SVGElement>("[data-edge-id]");
    const id = element?.dataset.nodeId;
    if (id && editable && target.closest("[data-port='out']")) {
      const point = toWorld(event.clientX, event.clientY);
      setDrag({ kind: "connect", from: id, x: point.x, y: point.y, over: null });
    } else if (id) {
      const at = place(id)!;
      if (!terminal(id)) onSelect({ kind: "node", id });
      if (editable) setDrag({ kind: "node", id, startX: event.clientX, startY: event.clientY, originX: at.x, originY: at.y, x: at.x, y: at.y, moved: false });
      else return;
    } else if (edge) {
      onSelect({ kind: "edge", id: (edge as HTMLElement).dataset.edgeId! });
      return;
    } else {
      onSelect(null);
      setDrag({ kind: "pan", startX: event.clientX, startY: event.clientY, viewX: view.x, viewY: view.y });
    }
    root.current?.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    if (drag.kind === "pan") {
      setView((current) => ({ ...current, x: drag.viewX + event.clientX - drag.startX, y: drag.viewY + event.clientY - drag.startY }));
    } else if (drag.kind === "node") {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      setDrag({ ...drag, x: drag.originX + dx / view.k, y: drag.originY + dy / view.k, moved: drag.moved || Math.hypot(dx, dy) > 3 });
    } else if (drag.kind === "connect") {
      const point = toWorld(event.clientX, event.clientY);
      const over = nodeUnder(event.clientX, event.clientY);
      setDrag({ ...drag, ...point, over: over && over !== drag.from && over !== START ? over : null });
    } else {
      setDrag({ ...drag, x: event.clientX, y: event.clientY,
        moved: drag.moved || Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4 });
    }
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    setDrag(null);
    if (root.current?.hasPointerCapture(event.pointerId)) root.current.releasePointerCapture(event.pointerId);
    if (!onChange) return;
    if (drag.kind === "node" && drag.moved) {
      const at = { x: snap(drag.x), y: snap(drag.y) };
      onChange(drag.id === START ? { ...definition, start: at } : drag.id === END ? { ...definition, end: at }
        : { ...definition, nodes: definition.nodes.map((node) => node.id === drag.id ? { ...node, ...at } : node) });
    } else if (drag.kind === "connect") {
      const over = nodeUnder(event.clientX, event.clientY);
      const box = root.current!.getBoundingClientRect();
      const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (over && over !== drag.from) link(drag.from, over);
      // Let go over empty canvas: choose what the new edge should lead to.
      else if (!over && inside) openMenu(event.clientX, event.clientY, { kind: "connect", from: drag.from });
    } else if (drag.kind === "palette") {
      const box = root.current!.getBoundingClientRect();
      const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (drag.moved && inside) {
        const point = toWorld(event.clientX, event.clientY);
        create(drag.preset, point.x - NODE_WIDTH / 2, point.y - NODE_HEIGHT / 2);
      } else if (!drag.moved) {
        const spot = freeSpot(definition);
        create(drag.preset, spot.x, spot.y);
      }
    }
  };

  const openMenu = (clientX: number, clientY: number, target: Menu["target"]) => {
    const box = root.current!.getBoundingClientRect();
    const rows = target.kind === "canvas" ? presets.length + 2 : target.kind === "connect" ? presets.length : target.kind === "node" ? 2 : 1;
    const height = rows * 32 + 44;
    setMenu({ target, point: toWorld(clientX, clientY),
      left: clamp(clientX - box.left, 8, Math.max(8, box.width - 216)), top: clamp(clientY - box.top, 8, Math.max(8, box.height - height)) });
  };
  const contextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const target = event.target as Element;
    if (!editable || target.closest("[data-canvas-control]")) return;
    const id = target.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
    const edge = target.closest<HTMLElement>("[data-edge-id]")?.dataset.edgeId;
    if (id && !terminal(id)) { onSelect({ kind: "node", id }); openMenu(event.clientX, event.clientY, { kind: "node", id }); }
    else if (edge) { onSelect({ kind: "edge", id: edge }); openMenu(event.clientX, event.clientY, { kind: "edge", id: edge }); }
    else if (!id) openMenu(event.clientX, event.clientY, { kind: "canvas" });
  };
  const doubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest("[data-canvas-control]")) return;
    const id = target.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
    if (id && !terminal(id)) onOpenNode?.(id);
    else if (!id && editable && !target.closest("[data-edge-id]")) openMenu(event.clientX, event.clientY, { kind: "canvas" });
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && (menu || drag)) { event.stopPropagation(); setMenu(null); setDrag(null); return; }
    if (!onChange || !selection || (event.target as Element).closest("[data-canvas-control]")) return;
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); remove(selection); return; }
    const steps: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const step = steps[event.key];
    if (!step || selection.kind !== "node") return;
    event.preventDefault();
    const distance = GRID * (event.shiftKey ? 4 : 1);
    onChange({ ...definition, nodes: definition.nodes.map((node) => node.id === selection.id
      ? { ...node, x: node.x + step[0] * distance, y: node.y + step[1] * distance } : node) });
  };

  const menuPreset = (preset: NodePreset) => {
    if (!menu) return;
    // From a dragged edge the node's input lands where the edge was dropped; otherwise it centres on the click.
    if (menu.target.kind === "connect") create(preset, menu.point.x - NODE_WIDTH / 2, menu.point.y, menu.target.from);
    else create(preset, menu.point.x - NODE_WIDTH / 2, menu.point.y - NODE_HEIGHT / 2);
    setMenu(null);
  };
  const draft = drag?.kind === "connect" ? (() => {
    const from = place(drag.from);
    if (!from) return null;
    return forwardPath(outPort(drag.from, from), drag, 0);
  })() : null;
  const ghost = drag?.kind === "palette" && drag.moved && root.current ? (() => {
    const box = root.current.getBoundingClientRect();
    return { left: drag.x - box.left, top: drag.y - box.top, label: drag.preset.label };
  })() : null;

  return (
    <div ref={root} className={`wf-canvas ${drag?.kind === "pan" ? "panning" : ""} ${drag?.kind === "connect" ? "connecting" : ""}`}
      data-testid="workflow-canvas" data-editable={editable || undefined} tabIndex={0} aria-label={tr("workflows.canvas")}
      style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${24 * view.k}px ${24 * view.k}px` }}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => setDrag(null)}
      onContextMenu={contextMenu} onDoubleClick={doubleClick} onKeyDown={keyDown}
      // Positions are the view's alone: focus inside must not scroll the canvas itself.
      onScroll={(event) => event.currentTarget.scrollTo(0, 0)}>
      <div className="wf-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <svg className="wf-links" viewBox="-6000 -6000 12000 12000" aria-hidden="true">
          <defs>
            {["base", "done", "selected", "flagged"].map((tone) => (
              <marker key={tone} id={`${markers}-${tone}`} className={`wf-arrow ${tone}`} viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="8" markerHeight="8"
                markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0.5 L7 4 L0 7.5 z" /></marker>
            ))}
          </defs>
          {definition.edges.map((edge) => {
            const from = place(edge.from);
            const to = place(edge.to);
            if (!from || !to) return null;
            const path = edge.loop ? loopPath(flank(from), flank(to)).path : forwardPath(outPort(edge.from, from), inPort(edge.to, to));
            const source = nodes.get(edge.from);
            const passed = run ? edge.from === START || (source ? nodeStatus(run, source) === "done" : false) : false;
            const tone = selection?.kind === "edge" && selection.id === edge.id ? "selected" : flagged?.has(edge.id) ? "flagged" : passed ? "done" : "base";
            return (
              <g key={edge.id} className={`wf-link ${edge.loop ? "loop" : ""} ${tone}`} data-edge-id={edge.id} data-testid="workflow-edge">
                <path className="wf-link-hit" d={path} />
                <path className="wf-link-line" d={path} markerEnd={`url(#${markers}-${tone})`} />
              </g>
            );
          })}
          {draft ? <path className="wf-link-draft" d={draft} /> : null}
        </svg>

        {definition.edges.filter((edge) => edge.loop).map((edge) => {
          const from = place(edge.from);
          const to = place(edge.to);
          if (!from || !to) return null;
          const { label } = loopPath(flank(from), flank(to));
          const round = run?.rounds[edge.id];
          return (
            <div key={edge.id} className={`wf-loop-label ${selection?.kind === "edge" && selection.id === edge.id ? "selected" : ""}`}
              data-edge-id={edge.id} style={{ left: label.x, top: label.y }}>
              <Repeat size={11} />{round ? tr("workflows.round_of", { p0: round, p1: edge.loop!.maxRounds }) : tr("workflows.loop_label", { p0: edge.loop!.maxRounds })}
            </div>
          );
        })}

        {([[START, tr("workflows.diagram_task")], [END, tr("workflows.diagram_result")]] as const).map(([id, label]) => {
          const at = place(id)!;
          return (
            <div key={id} className={`wf-terminal ${id} ${drag?.kind === "connect" && drag.over === id ? "drop" : ""}`} data-node-id={id}
              style={{ left: at.x, top: at.y, width: TERMINAL_WIDTH, height: TERMINAL_HEIGHT }}>
              {label}
              {id === START ? <span className="wf-port out" data-port="out" title={editable ? tr("workflows.port_hint") : undefined} /> : <span className="wf-port in" />}
            </div>
          );
        })}

        {definition.nodes.map((node) => {
          const at = place(node.id)!;
          const status = run ? nodeStatus(run, node) : undefined;
          const selected = selection?.kind === "node" && selection.id === node.id;
          const name = node.role || tr("workflows.unnamed_role");
          return (
            <div key={node.id} data-node-id={node.id} data-testid="workflow-node" data-status={status}
              className={`wf-cnode ${selected ? "selected" : ""} ${flagged?.has(node.id) ? "flagged" : ""} ${drag?.kind === "node" && drag.id === node.id && drag.moved ? "dragging" : ""} ${drag?.kind === "connect" && drag.over === node.id ? "drop" : ""}`}
              style={{ left: at.x, top: at.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
              tabIndex={0} role="button" aria-pressed={selected} aria-label={`${name}${tr("punctuation.comma")}${executorLabel(node.executorId, executors)}`}
              onFocus={() => { if (!selected) onSelect({ kind: "node", id: node.id }); }}>
              <span className="wf-port in" />
              <span className="wf-cnode-copy">
                <strong>{name}</strong>
                <small>{executorLabel(node.executorId, executors)}</small>
              </span>
              <span className="wf-cnode-marks">
                {node.each !== null ? <em title={tr("workflows.each_mark", { p0: node.each })}>×{node.each}</em> : null}
                {node.access === "write" ? <em title={tr("workflows.access_write")}><Pencil size={11} /></em> : null}
                {judges.has(node.id) ? <em title={tr("workflows.judge")}><Repeat size={11} /></em> : null}
                {status ? <StatusMark status={status} /> : flagged?.has(node.id) ? <CircleAlert size={13} className="wf-flag" /> : null}
              </span>
              <span className="wf-port out" data-port="out" title={editable ? tr("workflows.port_hint") : undefined} />
            </div>
          );
        })}
      </div>

      {editable && !definition.nodes.length ? (
        <div className="wf-canvas-empty"><strong>{tr("workflows.canvas_empty_title")}</strong><span>{tr("workflows.canvas_empty_hint")}</span></div>
      ) : null}
      {editable ? (
        <div className="wf-palette" data-canvas-control role="group" aria-label={tr("workflows.palette")}>
          <span>{tr("workflows.palette")}</span>
          {presets.map((preset) => (
            <button type="button" key={preset.key} className="wf-palette-item" data-testid={`palette-${preset.key}`}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                setMenu(null);
                setDrag({ kind: "palette", preset, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false });
                root.current?.setPointerCapture(event.pointerId);
              }}
              // Keyboard only: a pointer press is finished by the canvas, which holds the pointer.
              onClick={(event) => { if (event.detail === 0) { const spot = freeSpot(definition); create(preset, spot.x, spot.y); } }}>
              <Plus size={12} />{preset.label}
            </button>
          ))}
        </div>
      ) : null}
      {editable ? <p className="wf-canvas-hint">{tr("workflows.canvas_hint")}</p> : null}
      <div className="wf-canvas-tools" data-canvas-control role="group" aria-label={tr("workflows.view_controls")}>
        <button type="button" className="icon-button" onClick={() => zoom(1 / 1.2)} aria-label={tr("workflows.zoom_out")} title={tr("workflows.zoom_out")}><Minus size={14} /></button>
        <span data-testid="workflow-zoom">{Math.round(view.k * 100)}%</span>
        <button type="button" className="icon-button" onClick={() => zoom(1.2)} aria-label={tr("workflows.zoom_in")} title={tr("workflows.zoom_in")}><Plus size={14} /></button>
        <button type="button" className="icon-button" onClick={fit} aria-label={tr("workflows.fit")} title={tr("workflows.fit")}><Maximize size={14} /></button>
        {onChange ? (
          <button type="button" className="icon-button" data-testid="workflow-tidy" aria-label={tr("workflows.tidy")} title={tr("workflows.tidy")}
            onClick={() => { onChange(autoLayout(definition)); requestAnimationFrame(() => fitRef.current()); }}><Network size={14} /></button>
        ) : null}
      </div>

      {menu ? (
        <div ref={menuElement} className="wf-menu surface-popover" role="menu" data-canvas-control data-testid="workflow-menu" style={{ left: menu.left, top: menu.top }}>
          {menu.target.kind === "canvas" || menu.target.kind === "connect" ? (
            <>
              <span className="wf-menu-title">{menu.target.kind === "connect" ? tr("workflows.menu_connect_new") : tr("workflows.menu_new")}</span>
              {presets.map((preset, index) => (
                <button type="button" role="menuitem" key={preset.key} data-testid={`menu-${preset.key}`} onClick={() => menuPreset(preset)}>
                  <Plus size={14} />{preset.label}
                </button>
              ))}
              {menu.target.kind === "canvas" ? (
                <>
                  <hr />
                  <button type="button" role="menuitem" onClick={() => { onChange?.(autoLayout(definition)); setMenu(null); requestAnimationFrame(() => fitRef.current()); }}>
                    <Network size={14} />{tr("workflows.tidy")}
                  </button>
                  <button type="button" role="menuitem" onClick={() => { fit(); setMenu(null); }}><Maximize size={14} />{tr("workflows.fit")}</button>
                </>
              ) : null}
            </>
          ) : menu.target.kind === "node" ? (
            <>
              <button type="button" role="menuitem" data-testid="menu-duplicate"
                onClick={() => { duplicate((menu.target as { id: string }).id); setMenu(null); }}><Copy size={14} />{tr("workflows.menu_duplicate_node")}</button>
              <button type="button" role="menuitem" className="danger" data-testid="menu-delete"
                onClick={() => { remove({ kind: "node", id: (menu.target as { id: string }).id }); setMenu(null); }}><Trash2 size={14} />{tr("workflows.menu_delete_node")}</button>
            </>
          ) : (
            <button type="button" role="menuitem" className="danger" data-testid="menu-delete"
              onClick={() => { remove({ kind: "edge", id: (menu.target as { id: string }).id }); setMenu(null); }}><Trash2 size={14} />{tr("workflows.menu_delete_edge")}</button>
          )}
        </div>
      ) : null}
      {ghost ? <div className="wf-ghost" style={{ left: ghost.left, top: ghost.top }}>{ghost.label}</div> : null}
    </div>
  );
}

export function StatusMark({ status }: { status: WorkflowNodeStatus }) {
  const label = statusLabel(status);
  return (
    <span className="wf-status-mark" data-status={status} title={label} aria-label={label} role="img">
      {status === "running" ? <LoaderCircle size={13} className="spin" />
        : status === "done" ? <Check size={13} />
        : status === "failed" ? <CircleAlert size={13} />
        : status === "cancelled" ? <Ban size={12} /> : <span className="wf-status-dot" />}
    </span>
  );
}

export function statusLabel(status: WorkflowNodeStatus) {
  return status === "running" ? tr("workflows.status_running")
    : status === "done" ? tr("workflows.status_done")
    : status === "failed" ? tr("workflows.status_failed")
    : status === "cancelled" ? tr("workflows.status_cancelled") : tr("workflows.status_pending");
}
