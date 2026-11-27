import { t as tr } from "../../../electron/i18n.mjs";
import { Ban, Check, CircleAlert, Copy, LoaderCircle, Maximize, Minus, Network, Pencil, Plus, Repeat, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import type {
  WorkflowDefinition,
  WorkflowHarness,
  WorkflowNode,
  WorkflowNodeFields,
  WorkflowNodeStatus,
  WorkflowRun,
} from "../../workflow-types";
import { harnessName, refusalText } from "./workflow-labels";
import {
  END, GRID, NODE_HEIGHT, NODE_WIDTH, START, TERMINAL_HEIGHT, TERMINAL_WIDTH,
  addNode, autoLayout, connect, fieldsOf, newNode, removeEdge, removeNode, snap,
} from "./workflow-model";

export type CanvasSelection = { kind: "node" | "edge"; id: string } | null;

/** A node the user can drop in ready-made. The blank one asks what it should do. */
export interface NodePreset {
  key: string;
  label: string;
  /** Kept by the user rather than built in; listed apart. */
  saved?: boolean;
  fields: Partial<WorkflowNodeFields>;
}

interface Box { left: number; top: number; width: number; height: number }

/** Where things are on screen, for what is drawn over the canvas beside a node or an edge. */
export interface CanvasFrame {
  width: number;
  height: number;
  node: (nodeId: string) => Box | null;
  edge: (edgeId: string) => { left: number; top: number } | null;
}

interface WorkflowCanvasProps {
  definition: WorkflowDefinition;
  harnesses: readonly WorkflowHarness[];
  selection: CanvasSelection;
  onSelect: (selection: CanvasSelection) => void;
  /** Absent on a canvas that only shows: nothing can be created, moved or connected. */
  onChange?: (definition: WorkflowDefinition) => void;
  presets?: readonly NodePreset[];
  /** Write a blank node's definition from one sentence. */
  onDraftNode?: (nodeId: string, intent: string) => void;
  /** Nodes whose definition is being written now. */
  drafting?: ReadonlySet<string>;
  /** With a run, every node shows where that run is. */
  run?: WorkflowRun | null;
  /** Ids of nodes and edges that keep the workflow from running. */
  flagged?: ReadonlySet<string>;
  /** A connection that cannot exist says why. */
  onNotice?: (message: string) => void;
  /** A node was opened in full (a double click, or Enter on it): where a run shows its sessions. */
  onOpenNode?: (id: string) => void;
  /** Drawn over the canvas, in its own coordinates: the card of what is selected. */
  children?: (frame: CanvasFrame) => ReactNode;
}

interface View { x: number; y: number; k: number }
interface Point { x: number; y: number }

type Drag =
  | { kind: "pan"; startX: number; startY: number; viewX: number; viewY: number }
  | { kind: "node"; id: string; startX: number; startY: number; originX: number; originY: number; x: number; y: number; moved: boolean }
  | { kind: "connect"; from: string; x: number; y: number; over: string | null }
  | { kind: "add"; startX: number; startY: number; x: number; y: number; moved: boolean };

interface Menu {
  left: number;
  top: number;
  /** Where on the canvas it was opened, in the workflow's own coordinates; absent for the add button. */
  point: Point | null;
  target: { kind: "canvas" } | { kind: "node"; id: string } | { kind: "edge"; id: string } | { kind: "connect"; from: string };
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 1.6;
/** A run is shown no smaller than this, so node names stay readable in a narrow pane. */
const READABLE_ZOOM = 0.7;
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

/** Purpose: The workflow as a graph the user builds by hand. Nodes are created from the right-click
 * menu or the add button, dragged into place, and joined by dragging from the dot under a node; an
 * edge drawn back to an earlier node becomes a loop. A node shows its name and a few marks only:
 * what it is set to appears when it is opened. Without `onChange` the canvas only shows. */
export function WorkflowCanvas({ definition, harnesses, selection, onSelect, onChange, presets = [], onDraftNode, drafting, run, flagged, onNotice, onOpenNode, children }: WorkflowCanvasProps) {
  const editable = Boolean(onChange);
  const root = useRef<HTMLDivElement>(null);
  const markers = `wf-arrow-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  /** The blank node that is asking what it should do. */
  const [asking, setAsking] = useState<{ nodeId: string; text: string } | null>(null);
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
    // A next node placed beside or above gets a wider curve, so the edge reads as one sweep.
    const sideways = end.y - start.y < 48;
    const bend = clamp(sideways ? Math.abs(end.x - start.x) / 2.5 : Math.abs(end.y - start.y) / 2, sideways ? 44 : 24, 100);
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

  // Where a run is: the first node at work, else the one that failed.
  const focusId = useMemo(() => {
    if (!run) return null;
    const states = definition.nodes.map((node) => [node.id, nodeStatus(run, node)] as const);
    return (states.find(([, status]) => status === "running") ?? states.find(([, status]) => status === "failed"))?.[0] ?? null;
  }, [run, definition.nodes]);
  const focusRef = useRef(focusId);
  focusRef.current = focusId;

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
    const k = clamp(Math.min((width - 64) / spanX, (height - 64) / spanY, 1), run ? READABLE_ZOOM : MIN_ZOOM, 1);
    // A graph too large to read whole in its pane is shown around where the run is, from its start.
    const focus = (run && definition.nodes.find((node) => node.id === focusRef.current)) || { ...definition.start, w: TERMINAL_WIDTH, h: TERMINAL_HEIGHT };
    const along = (pane: number, low: number, span: number, at: number) => span * k <= pane - 32
      ? (pane - span * k) / 2 - low * k
      : clamp(pane / 2 - at * k, pane - 24 - (low + span) * k, 24 - low * k);
    setView({ k,
      x: along(width, left, spanX, focus.x + ("w" in focus ? focus.w : NODE_WIDTH) / 2),
      y: along(height, top, spanY, focus.y + ("h" in focus ? focus.h : NODE_HEIGHT) / 2) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition, Boolean(run)]);
  // A workflow opens fitted to the canvas; after that the view is the user's.
  useLayoutEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition.id]);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useEffect(() => {
    const element = root.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const box = element.getBoundingClientRect();
      setSize({ width: box.width, height: box.height });
      // A canvas that only shows keeps the whole graph in view as its pane changes size.
      if (!editable) fitRef.current();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [editable]);

  /** Move the view just far enough to show a node that lies outside it. */
  const reveal = (nodeId: string | null) => {
    const node = nodeId ? nodes.get(nodeId) : undefined;
    const element = root.current;
    if (!node || !element) return;
    const { width, height } = element.getBoundingClientRect();
    setView((current) => {
      const left = node.x * current.k + current.x;
      const top = node.y * current.k + current.y;
      const right = left + NODE_WIDTH * current.k;
      const bottom = top + NODE_HEIGHT * current.k;
      const dx = right > width - 16 ? width - 16 - right : left < 16 ? 16 - left : 0;
      const dy = bottom > height - 48 ? height - 48 - bottom : top < 48 ? 48 - top : 0;
      return dx || dy ? { ...current, x: current.x + dx, y: current.y + dy } : current;
    });
  };
  // A node selected from elsewhere (a duplicate, an issue, an undo) may lie outside the view.
  // A node the user clicks is already in view.
  const selectedNodeId = selection?.kind === "node" ? selection.id : null;
  useEffect(() => {
    reveal(selectedNodeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeId]);
  // A run is followed: the node at work, or the one that failed, comes into view as the run moves.
  useEffect(() => {
    reveal(focusId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

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
  const askElement = useRef<HTMLInputElement>(null);
  useEffect(() => { if (asking) askElement.current?.focus({ preventScroll: true }); }, [asking?.nodeId]);

  // A menu that closes hands the keyboard back to the canvas, so Escape and Delete keep working.
  const hadMenu = useRef(false);
  useEffect(() => {
    if (hadMenu.current && !menu && document.activeElement === document.body) root.current?.focus({ preventScroll: true });
    hadMenu.current = Boolean(menu);
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
    // A blank node asks what it should do, right where it is; a ready-made one is simply there.
    if (!node.role && !node.instructions && onDraftNode) { setAsking({ nodeId: node.id, text: "" }); onSelect(null); }
    else onSelect({ kind: "node", id: node.id });
  };
  const blank = presets.find((preset) => preset.key === "blank") ?? { key: "blank", label: "", fields: {} };
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
    const copy = newNode(node.x + NODE_WIDTH + 24, node.y, fieldsOf(node));
    onChange(addNode(definition, copy));
    onSelect({ kind: "node", id: copy.id });
  };

  const nodeUnder = (clientX: number, clientY: number) => {
    const hit = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-node-id]");
    return hit && root.current?.contains(hit) ? hit.dataset.nodeId ?? null : null;
  };
  const inside = (clientX: number, clientY: number) => {
    const box = root.current!.getBoundingClientRect();
    return clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
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
      if (over && over !== drag.from) link(drag.from, over);
      // Let go over empty canvas: choose what the new edge should lead to.
      else if (!over && inside(event.clientX, event.clientY)) openMenu(event.clientX, event.clientY, { kind: "connect", from: drag.from });
    } else if (drag.kind === "add") {
      // Dragged onto the canvas: a blank node lands there. Pressed in place: the menu of what to add.
      if (drag.moved && inside(event.clientX, event.clientY)) {
        const point = toWorld(event.clientX, event.clientY);
        create(blank, point.x - NODE_WIDTH / 2, point.y - NODE_HEIGHT / 2);
      } else if (!drag.moved) openAddMenu();
    }
  };

  const menuAt = (left: number, top: number, target: Menu["target"], point: Point | null) => {
    const box = root.current!.getBoundingClientRect();
    const rows = target.kind === "canvas" ? presets.length + 2 : target.kind === "connect" ? presets.length : target.kind === "node" ? 2 : 1;
    const height = rows * 32 + 52;
    setMenu({ target, point, left: clamp(left, 8, Math.max(8, box.width - 216)), top: clamp(top, 8, Math.max(8, box.height - height)) });
  };
  const openMenu = (clientX: number, clientY: number, target: Menu["target"]) => {
    const box = root.current!.getBoundingClientRect();
    menuAt(clientX - box.left, clientY - box.top, target, toWorld(clientX, clientY));
  };
  const openAddMenu = () => menuAt(12, 48, { kind: "canvas" }, null);
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
    if (!editable || target.closest("[data-canvas-control], [data-node-id], [data-edge-id]")) return;
    openMenu(event.clientX, event.clientY, { kind: "canvas" });
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && (menu || drag)) { event.stopPropagation(); setMenu(null); setDrag(null); return; }
    // Escape closes what is open, from the canvas or from inside its card.
    if (event.key === "Escape" && selection && !event.nativeEvent.isComposing) { onSelect(null); root.current?.focus({ preventScroll: true }); return; }
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
    const at = menu.point ?? toWorld(root.current!.getBoundingClientRect().left + size.width / 2, root.current!.getBoundingClientRect().top + size.height / 2);
    // From a dragged edge the node's input lands where the edge was dropped; otherwise it centres on the point.
    if (menu.target.kind === "connect") create(preset, at.x - NODE_WIDTH / 2, at.y, menu.target.from);
    else create(preset, at.x - NODE_WIDTH / 2, at.y - NODE_HEIGHT / 2);
    setMenu(null);
  };
  const draft = drag?.kind === "connect" ? (() => {
    const from = place(drag.from);
    return from ? forwardPath(outPort(drag.from, from), drag, 0) : null;
  })() : null;
  const ghost = drag?.kind === "add" && drag.moved && root.current ? (() => {
    const box = root.current.getBoundingClientRect();
    return { left: drag.x - box.left, top: drag.y - box.top };
  })() : null;
  const frame: CanvasFrame = {
    width: size.width, height: size.height,
    node: (nodeId) => {
      const at = place(nodeId);
      return at ? { left: at.x * view.k + view.x, top: at.y * view.k + view.y, width: NODE_WIDTH * view.k, height: NODE_HEIGHT * view.k } : null;
    },
    edge: (edgeId) => {
      const edge = definition.edges.find((item) => item.id === edgeId);
      const from = edge && place(edge.from);
      const to = edge && place(edge.to);
      if (!edge || !from || !to) return null;
      const start = outPort(edge.from, from);
      const end = inPort(edge.to, to);
      const at = edge.loop ? loopPath(flank(from), flank(to)).label : { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
      return { left: at.x * view.k + view.x, top: at.y * view.k + view.y };
    },
  };
  const builtIn = presets.filter((preset) => !preset.saved);
  const kept = presets.filter((preset) => preset.saved);
  const presetButton = (preset: NodePreset) => (
    <button type="button" role="menuitem" key={preset.key} data-testid={`menu-${preset.key}`} onClick={() => menuPreset(preset)}>
      {preset.key === "blank" ? <Plus size={14} /> : <span className="wf-menu-dot" />}{preset.label}
    </button>
  );

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
              data-edge-id={edge.id} title={tr("workflows.loop_label", { p0: edge.loop!.maxRounds })} style={{ left: label.x, top: label.y }}>
              <Repeat size={11} />{round ? `${round}/${edge.loop!.maxRounds}` : `≤${edge.loop!.maxRounds}`}
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
          const writing = drafting?.has(node.id);
          const asked = asking?.nodeId === node.id;
          return (
            <div key={node.id} data-node-id={node.id} data-testid="workflow-node" data-status={status}
              className={`wf-cnode ${selected ? "selected" : ""} ${flagged?.has(node.id) && !asked && !writing ? "flagged" : ""} ${drag?.kind === "node" && drag.id === node.id && drag.moved ? "dragging" : ""} ${drag?.kind === "connect" && drag.over === node.id ? "drop" : ""}`}
              style={{ left: at.x, top: at.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
              tabIndex={0} role="button" aria-pressed={selected} aria-label={`${name}${tr("punctuation.comma")}${harnessName(node, harnesses)}`}
              // Reached with the keyboard: the node opens. A press is handled where the pointer lands,
              // so that pulling an edge out of a node does not open it.
              onFocus={(event) => { if (!selected && event.target === event.currentTarget && event.currentTarget.matches(":focus-visible")) onSelect({ kind: "node", id: node.id }); }}
              onDoubleClick={onOpenNode ? () => onOpenNode(node.id) : undefined}
              onKeyDown={onOpenNode ? (event) => { if (event.key === "Enter" && event.target === event.currentTarget) onOpenNode(node.id); } : undefined}>
              <span className="wf-port in" />
              {asked ? (
                <input ref={askElement} className="wf-ask" data-canvas-control data-testid="node-intent" value={asking.text} maxLength={120}
                  placeholder={tr("workflows.ask_placeholder")} aria-label={tr("workflows.ask_placeholder")}
                  onChange={(event) => setAsking({ nodeId: node.id, text: event.target.value })}
                  onBlur={() => setAsking((current) => current?.nodeId === node.id ? null : current)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === "Escape") setAsking(null);
                    if (event.key === "Enter") {
                      const intent = asking.text.trim();
                      setAsking(null);
                      if (intent) onDraftNode?.(node.id, intent); else onSelect({ kind: "node", id: node.id });
                    }
                  }} />
              ) : (
                <span className="wf-cnode-copy">
                  <strong>{writing ? tr("workflows.drafting_node") : name}</strong>
                  <small>{harnessName(node, harnesses)}</small>
                </span>
              )}
              <span className="wf-cnode-marks">
                {writing ? <LoaderCircle size={13} className="spin" /> : null}
                {node.drafted && !writing ? <em className="drafted" title={tr("workflows.drafted_tag")}><Sparkles size={11} /></em> : null}
                {node.each !== null ? <em title={tr("workflows.each_mark", { p0: node.each })}>×{node.each}</em> : null}
                {node.access === "write" ? <em title={tr("workflows.access_write")}><Pencil size={11} /></em> : null}
                {judges.has(node.id) ? <em title={tr("workflows.judge")}><Repeat size={11} /></em> : null}
                {status ? <StatusMark status={status} /> : flagged?.has(node.id) && !asked && !writing ? <CircleAlert size={13} className="wf-flag" /> : null}
              </span>
              <span className="wf-port out" data-port="out" title={editable ? tr("workflows.port_hint") : undefined} />
            </div>
          );
        })}
      </div>

      {editable && !definition.nodes.length ? (
        <div className="wf-canvas-empty"><span>{tr("workflows.canvas_empty_hint")}</span></div>
      ) : null}
      {editable ? (
        <button type="button" className="wf-add" data-canvas-control data-testid="workflow-add" aria-label={tr("workflows.menu_new")} title={tr("workflows.menu_new")}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            setMenu(null);
            setDrag({ kind: "add", startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false });
            root.current?.setPointerCapture(event.pointerId);
          }}
          // Keyboard only: a pointer press is finished by the canvas, which holds the pointer.
          onClick={(event) => { if (event.detail === 0) openAddMenu(); }}>
          <Plus size={16} />
        </button>
      ) : null}
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

      {children ? <div className="wf-overlay" data-canvas-control>{children(frame)}</div> : null}

      {menu ? (
        <div ref={menuElement} className="wf-menu surface-popover" role="menu" data-canvas-control data-testid="workflow-menu" style={{ left: menu.left, top: menu.top }}>
          {menu.target.kind === "canvas" || menu.target.kind === "connect" ? (
            <>
              {builtIn.map(presetButton)}
              {kept.length ? <><hr /><span className="wf-menu-title">{tr("workflows.menu_saved")}</span>{kept.map(presetButton)}</> : null}
              {menu.target.kind === "canvas" && menu.point ? (
                <>
                  <hr />
                  <button type="button" role="menuitem" onClick={() => { onChange?.(autoLayout(definition)); setMenu(null); requestAnimationFrame(() => fitRef.current()); }}>
                    <Network size={14} />{tr("workflows.tidy")}
                  </button>
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
      {ghost ? <div className="wf-ghost" style={{ left: ghost.left, top: ghost.top }}><Plus size={13} /></div> : null}
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
