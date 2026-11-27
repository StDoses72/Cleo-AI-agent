import { t as tr } from "../../electron/i18n.mjs";
import { VirtualTimeline } from "./VirtualTimeline";
import { Timing } from "./Timing";
import { cleoClient } from "../services/cleoClient";
import type { useTimelineHistory } from "../useTimelineHistory";
import { MAX_TIMELINE_ITEMS, TIMELINE_PAGE_ITEMS } from "../timeline-cache";
import "./timeline.css";
import type { WorkflowDefinition } from "../workflow-types";
import { WorkflowProposalCard } from "./workflows/WorkflowProposal";
import { WorkflowRunCard } from "./workflows/WorkflowRun";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
  type ReactNode,
  type CSSProperties,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { normalizeMath } from "../markdown-math";
import {
  ArrowDown,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  FileDiff,
  Users,
  GitBranchPlus,
  CircleCheck,
  ExternalLink,
  FileCode2,
  FileImage,
  FileText,
  GitBranch,
  GitFork,
  LoaderCircle,
  MoreHorizontal,
  Paperclip,
  PanelLeftClose,
  Settings2,
  PanelRightClose,
  Copy,
  CornerDownRight,
  Pencil,
  RotateCcw,
  Sparkles,
  Square,
  X,
  Workflow,
} from "lucide-react";
import type {
  LocalSkill,
  Attachment,
  ProductivityModelCatalog,
  Project,
  RuntimeCatalog,
  RuntimeProfile,
  RuntimeUpdate,
  SteerReceipt,
  Thread,
  ThreadSpace,
  TimelineItem,
  ApprovalDecision,
  ApprovalRequest,
  QueuedMessage,
  ServiceTier,
  Usage,
} from "../types";
import { PermissionSelector } from "./PermissionSelector";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { ComputerApprovals } from "./ComputerPanel";
import { MoveThreadDialog, RenameThreadDialog } from "./Overlays";
import { handleDialogKeyDown } from "./Modal";
import { approvalLabel, projectLabel } from "../runtime-labels";
import { ProjectTarget } from "./ProjectTarget";
import { mentionAt, mentionText, rankFiles } from "./fileMentions";
import { modifierKey } from "../platform";
import { toolFailed } from "../toolOutcome";
import { RuntimePicker } from "./RuntimePicker";
import { ContextMeter } from "./ContextMeter";

/** Space a just-sent question needs beneath it for the start of the reply, and its gap from the top. */
const REPLY_ROOM = 160;
const QUESTION_TOP = 20;

interface ConversationProps {
  history?: ReturnType<typeof useTimelineHistory>;
  questionUI?: ReactNode;
  /** Shown in the header while the sidebar (and its settings entry) is hidden. */
  onOpenSettings?: () => void;
  thread: Thread | null;
  project: Project | null;
  /** Projects of this space; with onSelectProject, an unsent draft shows where it will run and can move. */
  projects?: Project[];
  activeProjectId?: string;
  onSelectProject?: (projectId: string) => void;
  onChooseWorkspace?: () => void;
  choosingWorkspace?: boolean;
  space: ThreadSpace;
  runtime: RuntimeProfile;
  runtimeCatalog: RuntimeCatalog | null;
  productivityModels: Record<string, ProductivityModelCatalog>;
  runtimeModelsLoading: string | null;
  runtimeModelsError: string | null;
  running: boolean;
  waitingForAnswer?: boolean;
  sendBlocked: string | null;
  sendError?: string;
  harnessSwitchStatus?: string | null;
  /** A harness picked for this task that is handed off with its next message. */
  pendingHarnessSwitch?: { provider: string; model: string } | null;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onRename: (name: string) => Promise<void>;
  /** Move the open thread into another project of its space; absent when unsupported. */
  onMoveToProject?: (projectId: string) => Promise<void>;
  undoing: boolean;
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onOpenCommand: () => void;
  onSend: (prompt: string) => void;
  queuedMessages?: QueuedMessage[];
  onSteerQueued?: (id: string) => void;
  onSendQueued?: (id: string) => void;
  onEditQueued?: (id: string) => void;
  onRemoveQueued?: (id: string) => void;
  onEditMessage?: (itemId: string, text: string) => Promise<void>;
  onCancel: () => void;
  steeringBusy?: boolean;
  onRetrySteer?: (receipt: SteerReceipt) => void;
  onRestoreSteer?: (receipt: SteerReceipt) => void;
  onUndo: () => void;
  onSelectNonProductivityProfile: (profileId: string) => void;
  onLoadProductivityModels: (provider: string, refresh?: boolean, background?: boolean) => Promise<ProductivityModelCatalog>;
  onSelectProductivityRuntime: (provider: string, model: string) => void;
  onEffortChange: (effort: NonNullable<RuntimeProfile["effort"]>) => void | Promise<void>;
  onPermissionChange?: (update: RuntimeUpdate) => Promise<void>;
  onServiceTierChange?: (tier: ServiceTier) => void;
  attachments: Attachment[];
  onPickAttachments: () => Promise<void>;
  onPrepareAttachments: (files: File[]) => Promise<void>;
  onRemoveAttachment: (path: string) => void;
  onShowRun: () => void;
  onShowContext: () => void;
  /** Open the details panel on the Changes tab. */
  onShowChanges?: () => void;
  /** Open the details panel on the Changes tab with this file's diff selected. */
  onShowChangeFile?: (path: string) => void;
  /** Offer to start the draft in an isolated git worktree (only for git projects). */
  worktree?: { enabled: boolean; onToggle: () => void };
  /** The project's files for @-mentions (git projects only). */
  onListFiles?: () => Promise<string[]>;
  /** Insert the composer's text into the running turn now instead of queueing it. */
  onSteerDraft?: (text: string) => void;
  /** Subtasks delegated from this conversation, and (for a subtask) the conversation that started it. */
  subtasks?: Thread[];
  parentThread?: Thread | null;
  /** The conversation is shown without a composer: the session of a workflow node, which the workflow drives. */
  readOnly?: boolean;
  onOpenThread?: (threadId: string) => void;
  /** The details panel is showing this conversation's changes, so the header need not repeat them. */
  changesVisible?: boolean;
  onRevealPath: (path: string) => void;
  onOpenPath: (href: string, workspacePath: string) => void;
  onThreadCommand: (command: string) => void;
  commands: string[];
  skills?: LocalSkill[];
  /** Saved workflows the composer can start with `/workflow`. */
  workflows?: { id: string; name: string }[];
  /** Show the conversation's workflow run in the details panel. */
  onShowWorkflow?: () => void;
  /** Keep a workflow an agent wrote in the library. */
  onAddWorkflow?: (definition: WorkflowDefinition) => Promise<void>;
  /** Open it on the canvas. */
  onOpenWorkflow?: (definition: WorkflowDefinition) => void;
  approvalRequest: ApprovalRequest | null;
  approvalPending: boolean;
  approvalError: string | null;
  onResolveApproval: (decision: ApprovalDecision) => void;
}

const suggestions = {
  get chat() { return [tr("conversation.help_me_plan_a_relaxed_fun_weekend"), tr("conversation.explain_a_complex_concept_in_simple_terms"), tr("conversation.turn_my_scattered_ideas_into_clear_writing")]; },
  get productivity() { return [tr("conversation.review_the_current_changes_and_suggest_next_steps"), tr("conversation.do_a_focused_code_review_of_this_repository"), tr("conversation.explain_this_project_s_structure_and_how_it_runs")]; },
};

export function Conversation({
  history,
  questionUI,
  onOpenSettings,
  thread,
  project,
  projects,
  activeProjectId,
  onSelectProject,
  onChooseWorkspace,
  choosingWorkspace,
  space,
  runtime,
  runtimeCatalog,
  productivityModels,
  runtimeModelsLoading,
  runtimeModelsError,
  running,
  waitingForAnswer = false,
  sendBlocked,
  sendError,
  harnessSwitchStatus,
  pendingHarnessSwitch,
  prompt,
  onPromptChange,
  onRename,
  onMoveToProject,
  undoing,
  sidebarCollapsed,
  inspectorOpen,
  onToggleSidebar,
  onToggleInspector,
  onOpenCommand,
  onSend,
  queuedMessages = [],
  onSteerQueued,
  onSendQueued,
  onEditQueued,
  onRemoveQueued,
  onEditMessage,
  onCancel,
  steeringBusy = false,
  onRetrySteer,
  onRestoreSteer,
  onUndo,
  onSelectNonProductivityProfile,
  onLoadProductivityModels,
  onSelectProductivityRuntime,
  onEffortChange,
  onServiceTierChange,
  onPermissionChange,
  attachments,
  onPickAttachments,
  onPrepareAttachments,
  onRemoveAttachment,
  onShowRun,
  onShowContext,
  onShowChanges,
  onShowChangeFile,
  worktree,
  onListFiles,
  onSteerDraft,
  subtasks = [],
  parentThread = null,
  readOnly = false,
  onOpenThread,
  changesVisible = false,
  onRevealPath,
  onOpenPath,
  onThreadCommand,
  commands,
  skills,
  workflows = [],
  onShowWorkflow,
  onAddWorkflow,
  onOpenWorkflow,
  approvalRequest,
  approvalPending,
  approvalError,
  onResolveApproval,
}: ConversationProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [bottomInset, setBottomInset] = useState(140);
  const localFollowRef = useRef(true);
  const stickToBottomRef = history?.followRef ?? localFollowRef;
  // Which way the reader last moved through the history. Paging only continues that way: a window of
  // a few lines has both of its edges within reach, and loading at the one behind the reader would
  // bring back what they just left.
  const travel = useRef<"up" | "down" | null>(null);
  useLayoutEffect(() => { stickToBottomRef.current = true; travel.current = null; }, [thread?.id]);
  // Reading position of the turn just sent: the question is placed once, then the view stays put
  // while the reply grows. `turnSpace` pads a short turn so the question can sit near the top.
  const turnSpaceRef = useRef<HTMLDivElement>(null);
  const heldQuestion = useRef<{ id: string; offset: number } | null>(null);
  const placedTop = useRef<number | null>(null);
  const sentSeen = useRef<{ thread?: string; id: string | null }>({ id: null });
  const [belowFold, setBelowFold] = useState(false);
  useLayoutEffect(() => {
    const bottom = bottomRef.current;
    if (!bottom) return;
    const measure = () => setBottomInset(Math.ceil(bottom.getBoundingClientRect().height) + 12);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bottom);
    return () => observer.disconnect();
  }, []);
  // A folded turn and a run of tool calls are named after their first loaded item, which paging drops
  // from the window. Each keeps the name it had, so it stays the same row, open or closed, measured
  // and in place, while the window moves over it.
  const workIds = useRef({ thread: thread?.id, groups: new Map<string, string>(), runs: new Map<string, string>() });
  if (workIds.current.thread !== thread?.id) workIds.current = { thread: thread?.id, groups: new Map(), runs: new Map() };
  const timelineItems = useMemo(() => {
    const blocks = groupTimelineItems(thread?.items ?? []);
    const ids = keepWorkIds(workIds.current.groups);
    for (const block of blocks) if (block.type === "work-group") block.id = ids.id(block.id, block.items);
    workIds.current.groups = ids.known;
    return blocks;
  }, [thread?.items]);
  const currentTurn = timelineItems.slice(timelineItems.findLastIndex(item => item.type === "message" && item.role === "user") + 1);
  const waiting = Boolean(approvalRequest || waitingForAnswer);
  const live = running && !thread?.history?.hasAfter;
  // The live turn writes its work straight into the timeline: thoughts as prose, tool calls as one
  // quiet line each. Work folds to a summary line once a reply lands after it, or the turn is over.
  const isFolded = (block: WorkGroupBlock) => block.answered || !(live && currentTurn.includes(block));
  const liveTool = live && !waiting && currentTurn.some(block => block.type === "work-group"
    && block.items.some(entry => entry.type === "tool" && entry.status === "running"));
  const lastBlock = currentTurn.at(-1);
  // A running tool spins on its own line and a streaming reply moves by itself; anything else
  // (a thought, a plan, the pause between two steps) gets the "working" line under the turn.
  const showActivity = live && !waiting && !liveTool
    && !(lastBlock?.type === "message" && lastBlock.role === "assistant" && lastBlock.content.trim());

  // Manual toggles only: folded work, tool runs and tool rows all start closed.
  const [expansion, setExpansion] = useState<Record<string, boolean>>({});
  const stateKey = (id: string) => `${thread?.id}:${id}`;
  const isOpen = (id: string) => expansion[stateKey(id)] ?? false;
  const toggle = (id: string, open: boolean) => setExpansion(current => {
    if (current[stateKey(id)] === open) return current;
    return Object.fromEntries(Object.entries({ ...current, [stateKey(id)]: open }).slice(-1000));
  });
  const rows: TimelineRow[] = [];
  const runIds = keepWorkIds(workIds.current.runs);
  for (const block of timelineItems) {
    if (block.type !== "work-group") { rows.push(block); continue; }
    const folded = isFolded(block);
    const shown = !folded || isOpen(block.id);
    if (folded) rows.push(block);
    for (const part of splitToolRuns(block.items)) {
      if (!Array.isArray(part)) { if (shown) rows.push({ id: part.id, type: "work-row", item: part, inFold: folded, inRun: false }); continue; }
      // Named behind a closed fold too: it is the same run when the fold opens again.
      const run: ToolRunRow = { id: runIds.id(`tool-run-${part[0].id}`, part), type: "tool-run", items: part, inFold: folded };
      if (!shown) continue;
      rows.push(run);
      if (!isOpen(run.id)) continue;
      rows.push(...part.map((item, index) => ({ id: item.id, type: "work-row" as const, item, inFold: folded, inRun: true,
        end: index === part.length - 1 })));
    }
    // The last opened row closes its list: the gap to what follows sits below the hairline.
    const last = rows.at(-1)!;
    if (folded && last.type !== "work-group") rows[rows.length - 1] = { ...last, end: true } as TimelineRow;
  }
  workIds.current.runs = runIds.known;
  const [reader, setReader] = useState<{ item: TimelineItem; field: string; offset: number; text: string; next: number; total: number } | null>(null);
  const [readerError, setReaderError] = useState("");
  const [readerLoading, setReaderLoading] = useState(false);
  const readerRequest = useRef(false);
  const readerNext = useRef(0);
  const readerDialog = useRef<HTMLDialogElement>(null);
  const readerViewport = useRef<HTMLDivElement>(null);
  const readerGeneration = useRef(0);
  const closeReader = () => {
    readerGeneration.current++;
    readerRequest.current = false;
    readerNext.current = 0;
    setReader(null); setReaderError(""); setReaderLoading(false);
  };
  useEffect(closeReader, [thread?.id]);
  useEffect(() => { if (reader) readerDialog.current?.showModal(); else readerDialog.current?.close(); }, [Boolean(reader)]);
  const readContent = async (item: TimelineItem, field: string, offset = 0) => {
    if (!thread || (offset > 0 && (readerRequest.current || offset !== readerNext.current))) return;
    const generation = ++readerGeneration.current;
    readerRequest.current = true; setReaderLoading(true);
    setReaderError("");
    if (!offset) {
      readerNext.current = 0;
      setReader({ item, field, offset: 0, text: "", next: 0, total: 0 });
    }
    try {
      const content = await cleoClient.readTimelineContent(thread.id, item.id, field, offset);
      if (generation === readerGeneration.current) {
        readerNext.current = content.next;
        setReader(current => ({ item, field, ...content,
          text: offset ? (current?.text ?? "") + content.text : content.text }));
      }
    } catch (error) {
      if (generation === readerGeneration.current) setReaderError(error instanceof Error ? error.message : tr("conversation.could_not_read_the_full_content"));
    } finally {
      if (generation === readerGeneration.current) { readerRequest.current = false; setReaderLoading(false); }
    }
  };
  const loadReaderEdge = () => {
    const view = readerViewport.current;
    if (!reader || !view || readerLoading || readerError || reader.next >= reader.total) return;
    if (view.scrollHeight - view.scrollTop - view.clientHeight < 240) void readContent(reader.item, reader.field, reader.next);
  };
  useEffect(() => {
    const frame = requestAnimationFrame(loadReaderEdge);
    return () => cancelAnimationFrame(frame);
  }, [reader?.next, readerLoading, readerError]);

  /** Size the turn padding to what the held question still needs, and note output below the fold. */
  const measureTail = () => {
    const viewport = viewportRef.current;
    const space = turnSpaceRef.current;
    if (!viewport || !space) { if (belowFold) setBelowFold(false); return; }
    const held = heldQuestion.current;
    const question = held ? viewport.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(held.id)}"]`) : null;
    let height = 0;
    if (held && question && space.parentElement) {
      const end = space.getBoundingClientRect();
      const turn = end.top - question.getBoundingClientRect().top;
      const tail = space.parentElement.getBoundingClientRect().bottom - end.bottom;
      height = Math.max(0, Math.floor(viewport.clientHeight - bottomInset - held.offset - turn - tail));
    }
    if (space.style.height !== `${height}px`) space.style.height = `${height}px`;
    const hidden = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 1;
    if (hidden !== belowFold) setBelowFold(hidden);
  };
  const lastItem = thread?.items.at(-1);
  const sentId = lastItem?.type === "message" && lastItem.role === "user" && !lastItem.steer ? lastItem.id : null;
  useLayoutEffect(() => {
    const seen = sentSeen.current;
    const opened = seen.thread !== thread?.id;
    sentSeen.current = { thread: thread?.id, id: sentId ?? (opened ? null : seen.id) };
    if (opened) { heldQuestion.current = null; placedTop.current = null; return; }
    if (!sentId || sentId === seen.id) return;
    const viewport = viewportRef.current;
    const question = viewport?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(sentId)}"]`);
    if (!viewport || !question) return;
    // From here the reply is read at the reader's pace: output no longer drags the view.
    stickToBottomRef.current = false;
    travel.current = null;
    history?.follow(false);
    const view = viewport.getBoundingClientRect();
    const rect = question.getBoundingClientRect();
    const visible = viewport.clientHeight - bottomInset;
    if (view.top + visible - rect.bottom >= REPLY_ROOM) return;
    // No room under the question: move it up once, as far as still leaves the reply its room.
    heldQuestion.current = { id: sentId, offset: Math.min(QUESTION_TOP, visible - REPLY_ROOM - rect.height) };
    measureTail();
    viewport.scrollTop += question.getBoundingClientRect().top - view.top - heldQuestion.current.offset;
    placedTop.current = viewport.scrollTop;
  }, [thread?.id, sentId]);
  useLayoutEffect(measureTail);

  /** The reader moved the view by `delta` pixels (negative is up). */
  const trackScrollPosition = (delta = 0) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    // The scroll that placed the question is not the reader reaching the end.
    measureTail();
    if (placedTop.current === null || Math.abs(viewport.scrollTop - placedTop.current) > 1) {
      placedTop.current = null;
      if (delta) travel.current = delta < 0 ? "up" : "down";
      stickToBottomRef.current = distanceFromBottom <= 1 && !thread?.history?.hasAfter;
      history?.follow(stickToBottomRef.current);
    }
    if (history?.busy || history?.error) return;
    const prefetchDistance = Math.max(240, viewport.clientHeight / 2);
    if (travel.current !== "down" && thread?.history?.hasBefore && reaches("before", viewport.scrollTop, prefetchDistance)) void history?.load("before");
    else if (travel.current !== "up" && thread?.history?.hasAfter && reaches("after", distanceFromBottom, prefetchDistance)) void history?.load("after");
  };

  /** Purpose: Tell whether a page loaded at one end would push a row in view out at the other.
   * The cache holds a fixed number of items and a folded turn can be most of them, so the items
   * that give way can be the very lines the reader is looking at. Input: where the page goes.
   */
  const dropsView = (direction: "before" | "after") => {
    const viewport = viewportRef.current;
    const items = thread?.items ?? [];
    const giveWay = items.length + TIMELINE_PAGE_ITEMS - MAX_TIMELINE_ITEMS;
    if (!viewport || giveWay <= 0) return false;
    const view = viewport.getBoundingClientRect();
    const shown = [...viewport.querySelectorAll<HTMLElement>("[data-row-id]")].filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.bottom > view.top + 1 && rect.top < view.bottom - 1;
    });
    // The row in view nearest the end that gives way goes once the last of its items does.
    const id = (direction === "before" ? shown.at(-1) : shown[0])?.dataset.rowId;
    const row = rows.find(candidate => candidate.id === id);
    if (!row) return false;
    const members = row.type === "work-group" || row.type === "tool-run" ? row.items : [row.type === "work-row" ? row.item : row];
    const index = items.indexOf(direction === "before" ? members[0] : members.at(-1)!);
    return index >= 0 && (direction === "before" ? index >= items.length - giveWay : index < giveWay);
  };
  /** A page is due `distance` ahead of its edge. One that would take lines out of view waits for
   * the edge itself, where the reader has nothing left to read on the way. */
  const reaches = (direction: "before" | "after", toEdge: number, distance: number) =>
    toEdge <= 1 || (toEdge < distance && !dropsView(direction));

  // A window too short to scroll is filled without waiting for input. It grows from the end the
  // reader is at: heading up keeps its start, anything else (pinned to the newest output, heading
  // down, just opened) keeps its end, so a fill never pushes out what the reader is looking at.
  // `filled` is the window the last fill left unchanged: the cache is full, asking again never ends.
  const filled = useRef("");
  useEffect(() => {
    if (history?.busy || history?.error) return;
    const frame = requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (!thread || !history || !viewport || viewport.scrollHeight > viewport.clientHeight + 2) return;
      const retain = !stickToBottomRef.current && travel.current === "up" ? "start" : "end";
      const { hasBefore, hasAfter } = thread.history ?? {};
      const direction = retain === "start" ? (hasBefore ? "before" : hasAfter ? "after" : null)
        : hasAfter ? "after" : hasBefore ? "before" : null;
      const loaded = [thread.id, thread.items[0]?.id, thread.items.at(-1)?.id, thread.items.length, direction, retain].join("\n");
      if (!direction || filled.current === loaded) return;
      // A page that goes in at the kept end pushes loaded items out at the other. Lines in view only
      // give way to the reader's own scrolling.
      if ((direction === "before") === (retain === "start") && dropsView(direction)) return;
      filled.current = loaded;
      void history.load(direction, { retain }).then(applied => { if (!applied && filled.current === loaded) filled.current = ""; });
    });
    return () => cancelAnimationFrame(frame);
  }, [thread?.id, thread?.items.length, thread?.history?.before, thread?.history?.after, history?.busy, history?.error, bottomInset]);

  const editableTurns = useMemo(() => new Set(thread?.editableTurnIds ?? []), [thread?.editableTurnIds]);
  // A turn's duration sits under its last message. The user message carries it until the reply
  // arrives and may still hold it afterwards; it is shown once, where it ends up.
  const timingOwners = useMemo(() => {
    const owners = new Map<string, string>();
    for (const entry of thread?.items ?? []) if (entry.timing) owners.set(entry.timing.id, entry.id);
    return owners;
  }, [thread?.items]);
  const renderRow = (row: TimelineRow) => {
    let item: TimelineItem | undefined;
    let content: ReactNode;
    // Spinners belong to the live turn only, and pause while it waits on the user.
    const spinning = (items: ProcessItem[]) => live && !waiting && items.some(entry => entry.status === "running")
      && currentTurn.some(block => block.type === "work-group" && block.items.includes(items[0]));
    if (row.type === "work-group") content = <WorkLine kind="summary" depth={0}>
      <WorkSummary variant="turn" items={row.items} expanded={isOpen(row.id)}
        onToggle={() => toggle(row.id, !isOpen(row.id))} active={spinning(row.items)} /></WorkLine>;
    else if (row.type === "tool-run") content = <WorkLine kind="summary" depth={Number(row.inFold)} end={row.end}>
      <WorkSummary variant="tools" items={row.items} expanded={isOpen(row.id)}
        onToggle={() => toggle(row.id, !isOpen(row.id))} active={spinning(row.items)} /></WorkLine>;
    else if (row.type === "work-row") {
      item = row.item;
      content = <WorkLine kind={row.item.type} depth={Number(row.inFold) + Number(row.inRun)} end={row.end}>
        {row.item.type === "thought"
          ? <ThoughtEntry item={row.item} projectPath={project?.path ?? null} onOpenPath={onOpenPath} />
          : <ToolProcess tool={row.item} active={spinning([row.item])}
            open={expansion[stateKey(row.id)]} onToggle={open => toggle(row.id, open)} />}</WorkLine>;
    } else { item = row; content = <TimelineEntry item={row} projectPath={project?.path ?? null} onOpenPath={onOpenPath}
      threadId={thread?.id ?? ""} activeTurnId={running ? thread?.currentTiming?.turnId : null}
      showTiming={!row.timing || timingOwners.get(row.timing.id) === row.id}
      editable={!running && !waitingForAnswer && Boolean(onEditMessage) && editableTurns.has(row.id)}
      onEditMessage={onEditMessage} onRevealPath={onRevealPath}
      onShowWorkflow={onShowWorkflow} savedWorkflows={workflows} onAddWorkflow={onAddWorkflow} onOpenWorkflow={onOpenWorkflow}
      // Only the latest run can be resumed, and not while the conversation is busy.
      onRetryWorkflow={!running && row.type === "workflow" && row.id === timelineItems.findLast(item => item.type === "workflow")?.id
        ? () => onThreadCommand("/workflow retry") : undefined}
      steeringBusy={steeringBusy} onRetrySteer={onRetrySteer} onRestoreSteer={onRestoreSteer} />; }
    return <>{content}{item?.more && Object.keys(item.more).filter(field => field === "output" || field === "command").map(field =>
      <button className="history-content-link" key={field} onClick={() => void readContent(item!, field)}>
        {field === "output" ? tr("conversation.expand_output") : tr("conversation.expand_command")}</button>)}</>;
  };

  return (
    <main className="conversation-shell" data-testid="conversation" data-cache-count={thread?.items.length ?? 0} data-cache-first={thread?.items[0]?.id ?? ""} data-cache-last={thread?.items.at(-1)?.id ?? ""}>
      <div className="conversation-chrome"><ConversationHeader
        thread={thread}
        project={project}
        space={space}
        running={running}
        undoing={undoing}
        sidebarCollapsed={sidebarCollapsed}
        inspectorOpen={inspectorOpen}
        onToggleSidebar={onToggleSidebar}
        onToggleInspector={onToggleInspector}
        onOpenCommand={onOpenCommand}
        onShowRun={onShowRun}
        onUndo={onUndo}
        onRevealPath={onRevealPath}
        onThreadCommand={onThreadCommand}
        onRename={onRename}
        onMoveToProject={onMoveToProject}
        projects={projects}
        onOpenSettings={onOpenSettings}
        busy={running || Boolean(sendBlocked)}
        parentThread={parentThread}
        onOpenThread={onOpenThread}
      /></div>

      <div className="conversation-body" style={{ "--composer-clearance": `${bottomInset}px` } as CSSProperties}>
        {history?.error && <div className="history-error" role="alert">{history.error}<button onClick={() => void history.retry()}>{tr("conversation.retry_loading")}</button></div>}
        {history?.busy && <div className="history-loading" data-direction={history.busy} role="status" aria-label={tr("conversation.loading_history")}><LoaderCircle className="spin" size={14} /></div>}
        <div className="conversation-viewport" ref={viewportRef} tabIndex={0} aria-label={tr("conversation.conversation_history")} onWheel={event => {
          // Turning round counts from the input itself, also where the view cannot move any further.
          if (event.deltaY) travel.current = event.deltaY < 0 ? "up" : "down";
          if (event.deltaY < 0) { stickToBottomRef.current = false; history?.follow(false); }
          // Scrolling down against the end is the reader asking to follow the output.
          else if (event.deltaY > 0 && !thread?.history?.hasAfter
              && event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight <= 1) {
            placedTop.current = null; stickToBottomRef.current = true; history?.follow(true);
          }
          if (!history?.busy && !history?.error) {
            const view = event.currentTarget;
            if (event.deltaY < 0 && thread?.history?.hasBefore && reaches("before", view.scrollTop, 160)) void history?.load("before");
            if (event.deltaY > 0 && thread?.history?.hasAfter && reaches("after", view.scrollHeight - view.clientHeight - view.scrollTop, 160)) void history?.load("after");
          }
        }}>
        {thread?.items.length ? (
          <>
            <VirtualTimeline rows={rows} viewport={viewportRef} follow={stickToBottomRef} bottomInset={bottomInset} threadId={thread.id} render={renderRow} onScroll={trackScrollPosition}
              footer={<>{showActivity && <div className="turn-activity" role="status"><LoaderCircle className="spin" size={14} /><span>{tr("conversation.working")}</span></div>}
                <SubtaskList subtasks={subtasks} onOpen={onOpenThread} />
                {/* Who is doing the work shows while the run is live too, next to its subtasks. */}
                <CollaborationLine usage={thread.taskUsage} listed={subtasks} onOpen={onShowContext} />
                {/* The one way from the conversation into review. With the Changes tab open beside
                    it, that tab has the files and the actions; the card stays as a one-line record. */}
                {!running && space === "productivity" && thread.changes.length ? <ChangesCard thread={thread} undoing={undoing} compact={changesVisible}
                  onReview={onShowChanges} onReviewFile={onShowChangeFile} onUndo={thread.canUndo ? onUndo : undefined} /> : null}
                {thread.currentTiming && (running || !thread.items.some(item => item.timing?.id === thread.currentTiming?.id))
                  && <Timing key={thread.currentTiming.id} summary={thread.currentTiming} />}
                <div className="turn-space" ref={turnSpaceRef} aria-hidden="true" /></>} />
          </>
        ) : readOnly ? null : (
          <WelcomeState space={space} onUseSuggestion={onPromptChange} />
        )}
      </div>

      <div className="conversation-bottom" ref={bottomRef}>
      {(thread?.history?.hasAfter || ((history?.unread || (history && !history.following)) && belowFold)) && <button className="history-latest" aria-label={tr("conversation.jump_to_latest")} title={history?.unread ? tr("conversation.new_messages_jump_to_latest") : tr("conversation.jump_to_latest")} data-unread={history?.unread || undefined} onClick={() => {
        placedTop.current = null;
        travel.current = null;
        void history?.load("latest", { beforeApply: () => { stickToBottomRef.current = true; } });
      }}><ArrowDown size={17} aria-hidden="true" /></button>}
      {questionUI}
      <dialog ref={readerDialog} className="history-reader" data-content-kind={reader?.item.type} aria-label={tr("conversation.full_history_content")}
        onKeyDown={handleDialogKeyDown} onCancel={closeReader}>
        {reader && <><header><strong>{tr("conversation.full_content")}</strong><button aria-label={tr("conversation.close_content")} onClick={closeReader}><X size={18} /></button></header>
          <div className="history-reader-content" ref={readerViewport} onScroll={loadReaderEdge} tabIndex={0}>
            {reader.item.type === "message" || reader.item.type === "thought"
              ? <div className="message-copy"><MarkdownContent content={reader.text} projectPath={project?.path ?? null} onOpenPath={onOpenPath} /></div>
              : <pre>{reader.text}</pre>}
          </div>
          {readerLoading && <div className="reader-status" role="status" aria-label={tr("conversation.reading_content")}><LoaderCircle className="spin" size={14} /></div>}
          {readerError && <p className="history-error" role="alert">{readerError}<button onClick={() => void readContent(reader.item, reader.field, reader.next)}>{tr("app.retry")}</button></p>}
        </>}
      </dialog>

      {/* A conversation that is only read has nothing to write in. */}
      {readOnly ? null : <Composer
        key={thread?.id ?? `new:${space}:${project?.id}`}
        prompt={prompt}
        onPromptChange={onPromptChange}
        sendBlocked={sendBlocked}
        sendError={sendError}
        harnessSwitchStatus={harnessSwitchStatus}
        pendingHarnessSwitch={pendingHarnessSwitch}
        space={space}
        drafting={!thread}
        projects={projects}
        activeProjectId={activeProjectId}
        onSelectProject={onSelectProject}
        onChooseWorkspace={onChooseWorkspace}
        choosingWorkspace={choosingWorkspace}
        runtime={runtime}
        runtimeCatalog={runtimeCatalog}
        productivityModels={productivityModels}
        runtimeModelsLoading={runtimeModelsLoading}
        runtimeModelsError={runtimeModelsError}
        running={running}
        onSend={onSend}
        queuedMessages={queuedMessages}
        onSteerQueued={onSteerQueued}
        onSendQueued={onSendQueued}
        onEditQueued={onEditQueued}
        onRemoveQueued={onRemoveQueued}
        steerReady={thread?.steerReady}
        steeringBusy={steeringBusy}
        onCancel={onCancel}
        onSelectNonProductivityProfile={onSelectNonProductivityProfile}
        onLoadProductivityModels={onLoadProductivityModels}
        onSelectProductivityRuntime={onSelectProductivityRuntime}
        onEffortChange={onEffortChange}
        onServiceTierChange={onServiceTierChange}
        onPermissionChange={onPermissionChange}
        attachments={attachments}
        onPickAttachments={onPickAttachments}
        onPrepareAttachments={onPrepareAttachments}
        onRemoveAttachment={onRemoveAttachment}
        worktree={thread ? undefined : worktree}
        onListFiles={onListFiles}
        fileListKey={project?.path ?? ""}
        onSteerDraft={onSteerDraft}
        usage={thread?.usage}
        commands={commands}
        skills={skills ?? thread?.skills ?? []}
        workflows={space === "productivity" ? workflows : []}
        approvalRequest={approvalRequest}
        approvalPending={approvalPending}
        approvalError={approvalError}
        onResolveApproval={onResolveApproval}
        computerThreadId={thread?.id ?? null}
      />}
      </div>
      </div>
    </main>
  );
}

function ConversationHeader({
  thread,
  project,
  space,
  running,
  undoing,
  sidebarCollapsed,
  inspectorOpen,
  onToggleSidebar,
  onToggleInspector,
  onOpenCommand,
  onShowRun,
  onUndo,
  onRevealPath,
  onThreadCommand,
  onRename,
  onMoveToProject,
  projects,
  onOpenSettings,
  busy,
  parentThread,
  onOpenThread,
}: Pick<
  ConversationProps,
  | "parentThread"
  | "onOpenThread"
  | "thread"
  | "project"
  | "projects"
  | "space"
  | "running"
  | "undoing"
  | "sidebarCollapsed"
  | "inspectorOpen"
  | "onToggleSidebar"
  | "onToggleInspector"
  | "onOpenCommand"
  | "onShowRun"
  | "onUndo"
  | "onRevealPath"
  | "onThreadCommand"
  | "onRename"
  | "onMoveToProject"
  | "onOpenSettings"
> & { busy: boolean }) {
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setThreadMenuOpen(false);
    setRenameOpen(false);
    setMoveOpen(false);
  }, [thread?.id]);
  const moveTargets = thread ? (projects ?? []).filter((candidate) => (candidate.space ?? "chat") === thread.space
    && candidate.id !== thread.projectId) : [];
  useEffect(() => {
    if (!threadMenuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setThreadMenuOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setThreadMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [threadMenuOpen]);
  const runThreadCommand = (command: string) => {
    setThreadMenuOpen(false);
    onThreadCommand(command);
  };
  return (
    <header className="conversation-header">
      <div className="header-left">
        <button
          className={`icon-button ${sidebarCollapsed ? "visible-accent" : ""}`}
          type="button"
          aria-label={sidebarCollapsed ? tr("conversation.expand_sidebar") : tr("conversation.collapse_sidebar")}
          title={sidebarCollapsed ? tr("conversation.expand_sidebar") : tr("conversation.collapse_sidebar")}
          onClick={onToggleSidebar}
        >
          <PanelLeftClose size={17} />
        </button>
        {/* The sidebar holds the settings entry; while it is hidden (narrow windows with the details
            panel open, or collapsed by the user) settings stay one click away here. */}
        {sidebarCollapsed && onOpenSettings ? (
          <button className="icon-button" type="button" aria-label={tr("overlays.settings")} title={tr("overlays.settings")}
            data-testid="header-settings" onClick={onOpenSettings}>
            <Settings2 size={16} />
          </button>
        ) : null}
        <div className="breadcrumb">
          <span className="breadcrumb-project">{(project && projectLabel(project)) || "Cleo"}</span>
          <ChevronRight size={13} />
          {/* A delegated subtask names the conversation that started it, one click away. */}
          {parentThread ? <>
            <button type="button" className="breadcrumb-parent" data-testid="subtask-parent" onClick={() => onOpenThread?.(parentThread.id)}
              title={thread?.workflowSession ? tr("workflows.back_to_workflow") : tr("conversation.back_to_parent_task")}>{parentThread.title}</button>
            <ChevronRight size={13} />
            <small className="breadcrumb-subtask">{thread?.workflowSession ? tr("workflows.node") : tr("conversation.subtask")}</small>
          </> : null}
          <strong>{thread?.title ?? (space === "chat" ? tr("conversation.new_chat") : tr("conversation.new_task"))}</strong>
        </div>
      </div>
      <div className="header-actions">
        {project?.branch ? (
          <button className="branch-button" type="button" onClick={() => onRevealPath(project.path)}
            title={project.dirtyFiles ? tr("threadsidebar.value_value_changed_files", { p0: project.branch, p1: project.dirtyFiles }) : project.branch}>
            <GitBranch size={13} />
            <span>{project.branch}</span>
          </button>
        ) : null}
        <div className="thread-actions-wrap" ref={menuRef}>
          <button className="icon-button" type="button" aria-label={tr("conversation.more")} title={tr("conversation.conversation_actions")} disabled={!thread || busy} aria-expanded={threadMenuOpen} onClick={() => setThreadMenuOpen((open) => !open)}>
            <MoreHorizontal size={17} />
          </button>
          {threadMenuOpen ? (
            <div className="thread-actions-menu surface-popover">
              {space === "productivity" && thread?.canUndo ? <button type="button" disabled={running || undoing}
                onClick={() => { setThreadMenuOpen(false); onUndo(); }}>{tr("inspector.undo_latest_turn")}</button> : null}
              <button type="button" onClick={() => { setThreadMenuOpen(false); onShowRun(); }}>{tr("conversation.view_run_history")}</button>
              <button type="button" onClick={() => {
                setThreadMenuOpen(false);
                setRenameOpen(true);
              }}>{tr("conversation.rename")}</button>
              {onMoveToProject && thread ? <button type="button" data-testid="move-thread" onClick={() => {
                setThreadMenuOpen(false);
                setMoveOpen(true);
              }}>{tr("conversation.move_to_project")}</button> : null}
              {thread?.space === "productivity" ? <>
                <button type="button" onClick={() => runThreadCommand("/fork")}>{tr("conversation.branch_this_task")}</button>
                <button type="button" onClick={() => runThreadCommand("/compact")}>{tr("conversation.compact_context")}</button>
                <button className="danger" type="button" onClick={() => {
                  if (window.confirm(tr("conversation.archive_the_current_task_and_create_a_new_one"))) runThreadCommand("/archive");
                }}>{tr("conversation.archive")}</button>
              </> : null}
            </div>
          ) : null}
        </div>
        <span className="header-divider" />
        <button
          className={`icon-button ${inspectorOpen ? "active" : ""}`}
          type="button"
          aria-label={inspectorOpen ? tr("app.close_inspector") : tr("app.open_inspector")}
          title={inspectorOpen ? tr("app.close_inspector") : tr("app.open_inspector")}
          onClick={onToggleInspector}
        >
          <PanelRightClose size={17} />
        </button>
      </div>
      {renameOpen && thread ? (
        <RenameThreadDialog title={thread.title} onSave={onRename} onClose={() => setRenameOpen(false)} />
      ) : null}
      {moveOpen && thread && onMoveToProject ? (
        <MoveThreadDialog thread={thread} project={project ?? null} projects={moveTargets} running={running}
          onMove={onMoveToProject} onClose={() => setMoveOpen(false)} />
      ) : null}
    </header>
  );
}

type ToolTimelineItem = Extract<TimelineItem, { type: "tool" }>;
type ThoughtTimelineItem = Extract<TimelineItem, { type: "thought" }>;
type ProcessItem = ToolTimelineItem | ThoughtTimelineItem;
/** A stretch of one turn's reasoning and tool calls, in the order they happened. While its turn is
 * live it is written straight into the timeline; afterwards it sits behind a one-line summary. */
type WorkGroupBlock = {
  id: string;
  type: "work-group";
  items: ProcessItem[];
  /** A reply landed after this work in the same turn. */
  answered: boolean;
};
type TimelineBlock = Exclude<TimelineItem, { type: "thought" | "tool" }> | WorkGroupBlock;
/** Two or more tool calls in a row, behind one line. */
type ToolRunRow = { id: string; type: "tool-run"; items: ToolTimelineItem[]; inFold: boolean; end?: boolean };
/** `inFold`/`inRun`: opened from a folded turn / from a tool run. `end`: the last row of an opened list. */
type TimelineRow = TimelineBlock | ToolRunRow
  | { id: string; type: "work-row"; item: ProcessItem; inFold: boolean; inRun: boolean; end?: boolean };

const isProcess = (item: TimelineItem): item is ProcessItem => item.type === "thought" || item.type === "tool";

/** Purpose: Let a group of work keep its id from one pass over the timeline to the next.
 * Input: the item-to-group ids of the previous pass. Output: `id` names a group (the id held by
 * the first of its items that was in a group before, when no other group has taken it; otherwise
 * the given one), and `known` is the same map for this pass.
 */
export function keepWorkIds(previous: Map<string, string>) {
  const known = new Map<string, string>();
  const taken = new Set<string>();
  return {
    known,
    id(own: string, items: { id: string }[]) {
      const kept = items.map(item => previous.get(item.id)).find(id => id !== undefined && !taken.has(id)) ?? own;
      taken.add(kept);
      for (const item of items) known.set(item.id, kept);
      return kept;
    },
  };
}

/** Purpose: Lay a work group out the way it reads: each thought by itself, each uninterrupted
 * series of tool calls together. Input: the group's items in arrival order. Output: thoughts and
 * lone tool calls as items, series of two or more tool calls as arrays.
 */
export function splitToolRuns(items: ProcessItem[]): (ProcessItem | ToolTimelineItem[])[] {
  const parts: (ProcessItem | ToolTimelineItem[])[] = [];
  let run: ToolTimelineItem[] = [];
  const closeRun = () => {
    if (run.length) parts.push(run.length === 1 ? run[0] : run);
    run = [];
  };
  for (const item of items) {
    if (item.type === "tool") { run.push(item); continue; }
    closeRun();
    parts.push(item);
  }
  closeRun();
  return parts;
}

/** Purpose: Fold runs of thoughts and tool calls into chronological work groups.
 * Input: timeline items in arrival order. Output: blocks in arrival order where each uninterrupted
 * run of process items becomes one work group; messages (an answer, or the user steering mid-turn),
 * plans, notices and questions are boundaries, so the order of decisions and actions is kept.
 * A group is `answered` once an assistant reply follows it in the same turn.
 */
export function groupTimelineItems(items: TimelineItem[]): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  let turn: TimelineItem[] = [];
  let turnId = "initial";
  // This turn's groups that no reply has followed yet.
  let unanswered: WorkGroupBlock[] = [];

  const flushTurn = () => {
    if (!turn.length) return;
    // Plans, questions and notices are boundaries: work before and after them stays on its own side.
    // The first group keeps the segment's id (stable while it streams); later groups use their first item.
    let run: ProcessItem[] = [];
    let first = true;
    const closeRun = () => {
      if (!run.length) return;
      const group: WorkGroupBlock = { id: `work-group-${first ? turn[0].id : run[0].id}`, type: "work-group", items: run, answered: false };
      blocks.push(group);
      unanswered.push(group);
      run = [];
      first = false;
    };
    for (const item of turn) {
      if (isProcess(item)) { run.push(item); continue; }
      closeRun();
      blocks.push(item);
    }
    closeRun();
    turn = [];
  };

  for (const item of items) {
    if (item.type === "message") {
      flushTurn();
      // Without turn ids a reply belongs to the work before it and a user message opens a new turn.
      const sameTurn = item.turnId === undefined ? item.role === "assistant" : item.turnId === turnId;
      if (!sameTurn) unanswered = [];
      else if (item.role === "assistant" && item.content.trim()) {
        for (const group of unanswered) group.answered = true;
        unanswered = [];
      }
      blocks.push(item);
      turnId = item.turnId ?? item.id;
      continue;
    }
    const next = item.turnId ?? turnId;
    if (next !== turnId) { flushTurn(); unanswered = []; }
    turnId = next;
    turn.push(item);
  }
  flushTurn();
  return blocks;
}

function TimelineEntry({
  item,
  threadId,
  projectPath,
  onOpenPath,
  steeringBusy,
  onRetrySteer,
  onRestoreSteer,
  activeTurnId,
  showTiming = true,
  editable = false,
  onEditMessage,
  onRevealPath,
  onShowWorkflow,
  onRetryWorkflow,
  savedWorkflows = [],
  onAddWorkflow,
  onOpenWorkflow,
}: {
  item: Exclude<TimelineBlock, WorkGroupBlock>;
  onShowWorkflow?: () => void;
  onRetryWorkflow?: () => void;
  savedWorkflows?: readonly { id: string; name: string }[];
  onAddWorkflow?: (definition: WorkflowDefinition) => Promise<void>;
  onOpenWorkflow?: (definition: WorkflowDefinition) => void;
  /** False when a later message of the turn shows the same duration. */
  showTiming?: boolean;
  threadId: string;
  editable?: boolean;
  onEditMessage?: ConversationProps["onEditMessage"];
  onRevealPath?: ConversationProps["onRevealPath"];
  projectPath: string | null;
  onOpenPath: ConversationProps["onOpenPath"];
  steeringBusy?: boolean;
  onRetrySteer?: ConversationProps["onRetrySteer"];
  onRestoreSteer?: ConversationProps["onRestoreSteer"];
  activeTurnId?: string | null;
}) {
  if (item.type === "plan") return <PlanEntry item={item} />;
  if (item.type === "workflow") return <WorkflowRunCard run={item.run} onOpen={onShowWorkflow} onRetry={onRetryWorkflow} />;
  if (item.type === "workflow-proposal") return <WorkflowProposalCard definition={item.definition}
    added={savedWorkflows.some((saved) => saved.id === item.definition.id)}
    onAdd={onAddWorkflow ? () => onAddWorkflow(item.definition) : undefined} onOpen={onOpenWorkflow ? () => onOpenWorkflow(item.definition) : undefined} />;
  if (item.type === "question") return <section className="question-history" data-testid="question-history">
    <strong>{item.request.status === "answered" ? tr("conversation.agent_question_answered") : item.request.status === "pending" ? tr("conversation.waiting_for_an_answer") : item.request.status === "cancelled" ? tr("conversation.question_cancelled") : tr("conversation.this_question_has_expired_ask_the_agent_to_send_it_again")}</strong>
    {item.request.questions.map(question => <div key={question.id}><p>{question.question}</p>
      {item.request.answers?.[question.id] && <p className="question-history-answer">{question.secret ? tr("conversation.hidden") : item.request.answers[question.id].join("、")}</p>}</div>)}
  </section>;
  if (item.type === "message") {
    const receipt = item.steer && <>
      <span>{({ queued: item.steer.mode === "native" ? tr("conversation.waiting_for_delivery") : tr("conversation.send_after_the_current_reply"),
        sending: tr("conversation.delivering"), received: tr("conversation.received"), failed: tr("conversation.not_delivered"),
        cancelled: tr("conversation.delivery_cancelled"), uncertain: tr("conversation.receipt_not_confirmed") })[item.steer.status]}</span>
      {item.steer.error && <span className="steer-error">{item.steer.error}</span>}
      {item.steer.retryable && onRetrySteer && <button type="button" disabled={steeringBusy}
        onClick={() => onRetrySteer(item.steer!)}>{tr("app.retry")}</button>}
      {["failed", "cancelled", "uncertain"].includes(item.steer.status) && onRestoreSteer
        && <button type="button" onClick={() => {
          onRestoreSteer(item.steer!);
          document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')?.focus();
        }}>{tr("conversation.restore_to_composer")}</button>}
    </>;
    // Text that never reached the model is a status line, not a message; it opens on its content.
    if (item.steer && (item.steer.status === "cancelled" || item.steer.status === "failed")) return (
      <details className="steer-receipt steer-undelivered" data-testid="steer-receipt" data-status={item.steer.status}>
        <summary><ChevronRight className="steer-undelivered-chevron" size={13} aria-hidden="true" />{receipt}</summary>
        <p>{item.content}</p>
      </details>
    );
    return (
      <article className={`message-entry ${item.role}`} aria-label={item.role === "user" ? tr("conversation.your_message") : tr("conversation.cleo_s_reply")}>
        {(item.role === "assistant" || item.time) && <div className="message-meta">
          {item.role === "assistant" && <span>Cleo</span>}
          <time>{item.time}</time>
        </div>}
        <MessageText key={`${threadId}:${item.id}`} item={item} threadId={threadId}
          projectPath={projectPath} onOpenPath={onOpenPath} onEdit={editable ? onEditMessage : undefined}
          onRevealPath={onRevealPath} />
        {item.steer && <div className="steer-receipt" data-testid="steer-receipt" data-status={item.steer.status}>{receipt}</div>}
        {showTiming && (item.timing || item.role === "assistant") && item.turnId !== activeTurnId && <Timing key={item.timing?.id ?? item.id}
          summary={item.timing} error={item.timingError} />}
      </article>
    );
  }
  return (
    <div className={`notice-entry ${item.tone}`}>
      <span className="notice-icon">
        {item.tone === "success" ? <Check size={15} /> : <Sparkles size={15} />}
      </span>
      <div>
        <strong>{item.title}</strong>
        {item.detail ? <p>{item.detail}</p> : null}
      </div>
    </div>
  );
}

type MessageItem = Extract<TimelineItem, { type: "message" }>;
interface MessageSource { threadId: string; item: MessageItem; request?: Promise<string> }

/** Purpose: Read the complete persisted message without silently accepting an incomplete page.
 * Input: Session identity and preview item. Output: Full text, or a recoverable read error.
 */
async function fullMessageText(threadId: string, item: MessageItem) {
  if (!item.more?.content) return item.content;
  let text = "";
  for (let offset = 0; ;) {
    const page = await cleoClient.readTimelineContent(threadId, item.id, "content", offset);
    if (page.offset !== offset || !Number.isSafeInteger(page.next) || page.next <= offset
      || page.next > page.total || !page.text) throw new Error("正文未完整读取，请重试。");
    text += page.text;
    offset = page.next;
    if (offset >= page.total) return text;
  }
}

/** Purpose: Share one full-text read between automatic rendering, copying and editing.
 * Input: A message revision bound to its session. Output: Cached complete text; failures can retry.
 */
function readMessageText(source: MessageSource): Promise<string> {
  return source.request ??= fullMessageText(source.threadId, source.item).catch(reason => {
    source.request = undefined;
    throw reason;
  });
}

/** Purpose: Render complete messages inline, with reusable full-text copy and editing.
 * Input: Session-bound preview and optional rewind handler. Output: Full message or inline retry.
 */
function MessageText({ item, threadId, projectPath, onOpenPath, onEdit, onRevealPath }: {
  item: MessageItem;
  threadId: string;
  projectPath: string | null;
  onOpenPath: ConversationProps["onOpenPath"];
  onEdit?: ConversationProps["onEditMessage"];
  onRevealPath?: ConversationProps["onRevealPath"];
}) {
  const article = useRef<HTMLDivElement>(null);
  const copiedTimer = useRef<number | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const source = useMemo<MessageSource>(() => ({ threadId, item }), [threadId, item.id, item.content, item.more?.content]);
  const [fullText, setFullText] = useState<{ source: typeof source; text: string } | null>(null);
  const [contentError, setContentError] = useState<{ source: typeof source; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const text = fullText?.source === source ? fullText.text : item.content;
  const loading = Boolean(item.more?.content) && fullText?.source !== source;
  const readError = contentError?.source === source ? contentError.message : "";
  useEffect(() => {
    if (!source.item.more?.content) return;
    let active = true;
    setContentError(null);
    void readMessageText(source).then(value => {
      if (active) setFullText({ source, text: value });
    }).catch(reason => {
      if (active) setContentError({ source, message: reason instanceof Error ? reason.message : "正文读取失败" });
    });
    return () => { active = false; };
  }, [source, retry]);
  useEffect(() => () => { if (copiedTimer.current) window.clearTimeout(copiedTimer.current); }, []);

  const copy = async () => {
    const selection = window.getSelection();
    const selected = selection && !selection.isCollapsed && article.current?.contains(selection.anchorNode)
      && article.current?.contains(selection.focusNode) ? selection.toString() : "";
    try {
      await cleoClient.copyText(selected || await readMessageText(source));
      setError("");
      setCopied(true);
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch { setError(tr("conversation.copy_failed")); }
  };
  const startEdit = async () => {
    try { setDraft(await readMessageText(source)); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : tr("conversation.could_not_read_the_message")); }
  };
  const submit = async () => {
    if (!onEdit || !draft?.trim() || busy) return;
    setBusy(true);
    setError("");
    try { await onEdit(item.id, draft); setDraft(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : tr("conversation.could_not_edit_this_message")); }
    finally { setBusy(false); }
  };

  return <div className="message-text" ref={article}>
    {draft === null ? <div className="message-copy"><MarkdownContent content={text} projectPath={projectPath} onOpenPath={onOpenPath} /></div>
      : <div className="message-edit"><textarea aria-label={tr("conversation.edit_message")} autoFocus value={draft} disabled={busy}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === "Escape") { event.preventDefault(); if (!busy) setDraft(null); }
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
          }} />
        <div>
          <button type="button" disabled={busy} onClick={() => setDraft(null)}>{tr("computerpanel.cancel")}</button>
          <button type="button" className="primary" disabled={busy || !draft.trim()} onClick={() => void submit()}>{busy ? tr("conversation.sending") : tr("conversation.send")}</button>
        </div>
      </div>}
    {item.role === "user" && item.attachments?.length ? <AttachmentChips attachments={item.attachments}
      className="message-attachments" testId="message-attachments" onReveal={onRevealPath ?? (path => void cleoClient.revealPath(path))} /> : null}
    {item.role === "user" && item.memoryContext?.count ? <MemoryContextNote context={item.memoryContext} /> : null}
    {draft === null && <div className="message-actions">
      <button type="button" aria-label={tr("conversation.copy")} title={copied ? tr("conversation.copied") : tr("conversation.copy")} onClick={() => void copy()}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      {onEdit && <button type="button" aria-label={tr("conversation.edit")} title={tr("conversation.edit")} onClick={() => void startEdit()}><Pencil size={14} /></button>}
    </div>}
    {loading && !readError && <p className="message-content-status" role="status">正在加载完整正文…</p>}
    {readError && <p className="message-edit-error" role="alert">{readError}<button type="button"
      className="message-content-retry" onClick={() => setRetry(value => value + 1)}>重试</button></p>}
    {error && <p className="message-edit-error" role="alert">{error}</p>}
  </div>;
}

function MarkdownContent({
  content,
  projectPath,
  onOpenPath,
}: {
  content: string;
  projectPath: string | null;
  onOpenPath: ConversationProps["onOpenPath"];
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore", errorColor: "#c96b63" }]]}
      skipHtml
      urlTransform={markdownUrlTransform}
      components={{
        img: ({ node: _node, ...props }) => <img {...props} loading="lazy" decoding="async" className="timeline-image" />,
        a: ({ node: _node, href, children, ...props }) => {
          if (!href) return <span>{children}</span>;
          if (/^(https?:|mailto:)/i.test(href)) {
            return (
              <a {...props} className="markdown-link external-link" href={href} target="_blank" rel="noreferrer">
                <span>{children}</span>
                <ExternalLink aria-hidden="true" size={11} />
              </a>
            );
          }
          if (href.startsWith("#")) return <a {...props} href={href}>{children}</a>;
          const hasUnsupportedScheme = /^[a-z][a-z\d+.-]*:/i.test(href)
            && !/^[a-z]:[\\/]/i.test(href)
            && !/^file:/i.test(href);
          const absolutePath = /^(?:[a-z]:[\\/]|[\\/]|file:)/i.test(href);
          if (hasUnsupportedScheme || (!projectPath && !absolutePath)) {
            return (
              <span
                className="markdown-link local-file-link disabled"
                title={hasUnsupportedScheme ? tr("conversation.this_link_type_is_not_supported") : tr("conversation.this_task_has_no_working_directory")}
              >
                <span>{children}</span>
                <FileCode2 aria-hidden="true" size={11} />
              </span>
            );
          }
          return (
            <a
              {...props}
              className="markdown-link local-file-link"
              href={href}
              title={tr("conversation.open_in_the_default_application_value", { p0: href })}
              onClick={(event) => {
                event.preventDefault();
                onOpenPath(href, projectPath || "");
              }}
            >
              <span>{children}</span>
              <FileCode2 aria-hidden="true" size={11} />
            </a>
          );
        },
      }}
    >
      {normalizeMath(content)}
    </ReactMarkdown>
  );
}

function markdownUrlTransform(value: string, key: string): string {
  if (key === "href" && (/^[a-z]:[\\/]/i.test(value) || /^file:/i.test(value))) {
    return value;
  }
  return defaultUrlTransform(value);
}

const TOOL_KINDS = ["run", "edit", "read", "memory", "web", "agent", "other"] as const;
type ToolKind = typeof TOOL_KINDS[number];

/** Purpose: Name what a tool call did, so a turn summary can say "ran 2 commands · edited 3" instead
 * of counting opaque tool names. Input: the harness's tool name. Output: one coarse kind. Cleo's own
 * memory tools (searching long-term memory, reading an earlier conversation) are their own kind:
 * they are the turns' real, visible uses of memory. */
export function toolKind(name: string, command = false): ToolKind {
  const value = name.toLowerCase();
  // A harness that reports a command without naming its tool (the backend's "tool" placeholder) ran it.
  if (value === "tool" && command) return "run";
  if (/(cleo_memory|long_term_memory|memory_|_memory|read_thread)/.test(value)) return "memory";
  if (/(edit|write|patch|apply|create_file|str_replace|notebook)/.test(value)) return "edit";
  if (/(^read|view|grep|glob|search|^ls$|list|find|open_file)/.test(value)) return "read";
  if (/(bash|shell|exec|command|terminal|powershell|workspace|^run)/.test(value)) return "run";
  if (/(browser|web|fetch|computer|navigate|click|screenshot)/.test(value)) return "web";
  if (/(task|agent|delegate|spawn)/.test(value)) return "agent";
  return "other";
}

/** A call whose harness did not name its tool arrives as "tool"; its command says what it was. */
const toolLabel = (tool: ToolTimelineItem) => tool.name === "tool" && tool.command ? "" : tool.name;

const workCount = (kind: ToolKind | "thoughts", count: number) => tr(`conversation.work_${kind}`, { p0: count });

/** Purpose: One line that stands for work the reader can open: a finished stretch of a turn, or a
 * run of tool calls (live or done).
 * Input: the items it stands for, which of the two it is, whether its rows are shown, and whether
 * it is running in the live turn. Output: a quiet row ("已处理 · 运行 2 条命令 · 1 段思考" for a
 * turn, "运行 2 条命令 · 读取 1 次" for a tool run, with the running command beside it); opening it
 * lists what it stands for as rows beneath.
 */
function WorkSummary({ items, variant, expanded, onToggle, active }: {
  items: ProcessItem[];
  variant: "turn" | "tools";
  expanded: boolean;
  onToggle: () => void;
  active: boolean;
}) {
  const tools = items.filter((entry): entry is ToolTimelineItem => entry.type === "tool");
  const thoughts = items.length - tools.length;
  const errors = tools.filter((tool) => toolFailed(tool) && !tool.approvalAudit).length;
  // Commands that reported how long they ran add up to the turn's command time.
  const commandTime = tools.reduce((total, tool) => total + (tool.durationMs ?? 0), 0);
  const current = active ? tools.findLast((tool) => tool.status === "running") : undefined;
  const live = current && !expanded ? liveLine([toolLabel(current), current.command].filter(Boolean).join(" · ")) : "";
  const counts = new Map<ToolKind, number>();
  for (const tool of tools) {
    const kind = toolKind(tool.name, Boolean(tool.command));
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const parts = [
    ...TOOL_KINDS.filter((kind) => counts.get(kind)).map((kind) => workCount(kind, counts.get(kind)!)),
    thoughts ? workCount("thoughts", thoughts) : "",
    commandTime && !active ? tr("conversation.work_command_time", { p0: formatDuration(commandTime) }) : "",
  ].filter(Boolean);
  // A tool run is named by what it did; a folded turn by the fact that it is over.
  const title = variant === "turn" ? (active ? tr("conversation.working") : tr("conversation.work_done"))
    : (parts.shift() ?? "").replace(/^[a-z]/, (letter) => letter.toUpperCase());
  const status = active ? "running" : errors ? "error" : "done";
  return (
    <section className={`work-group ${variant} ${status}`} data-testid={variant === "turn" ? "work-group" : "tool-run"}>
      <button type="button" aria-expanded={expanded} onClick={onToggle}>
        <span className="work-group-icon" aria-hidden="true">
          {active ? <LoaderCircle className="spin" size={13} /> : errors ? <CircleAlert size={13} /> : <Check size={13} />}
        </span>
        <strong>{title}</strong>
        {parts.length ? <small>{parts.join(" · ")}</small> : null}
        {errors ? <small className="work-group-errors">{tr("conversation.work_failed", { p0: errors })}</small> : null}
        {live ? <span className="work-group-live" aria-live="polite">{live}</span> : null}
        <ChevronRight className={`work-group-chevron ${expanded ? "rotated" : ""}`} size={13} />
      </button>
    </section>
  );
}

/** Purpose: One row of a turn's work, placed by where it was opened from.
 * Input: what the row is, how many summary lines it sits under (0 = written straight into the
 * timeline), and whether it is the last row of an opened list. Output: the row, hanging off one
 * hairline per summary above it.
 */
function WorkLine({ kind, depth, end, children }: { kind: "summary" | "thought" | "tool"; depth: number; end?: boolean; children: ReactNode }) {
  let content = children;
  for (let level = 0; level < depth; level++) content = <div className="work-indent">{content}</div>;
  return <div className={`work-line${end ? " end" : ""}`} data-kind={kind} data-depth={depth}>{content}</div>;
}

/** Purpose: The agent's own words between its steps, set as running prose like a reply — only
 * quieter, so the final answer still reads as the answer. */
function ThoughtEntry({
  item,
  projectPath,
  onOpenPath,
}: {
  item: ThoughtTimelineItem;
  projectPath: string | null;
  onOpenPath: ConversationProps["onOpenPath"];
}) {
  return (
    <div className={`thought-entry ${item.status}`}>
      <div className="thought-copy message-copy">
        <MarkdownContent content={item.content} projectPath={projectPath} onOpenPath={onOpenPath} />
      </div>
    </div>
  );
}

function PlanEntry({ item }: { item: Extract<TimelineItem, { type: "plan" }> }) {
  const done = item.steps.filter((step) => step.status === "done").length;
  const complete = item.steps.length > 0 && done === item.steps.length;
  // A finished plan folds to one line (also the moment its last step completes); it reopens on demand.
  const [open, setOpen] = useState(!complete);
  useEffect(() => { setOpen(!complete); }, [complete]);
  if (complete && !open) {
    return (
      <section className="plan-entry collapsed">
        <button type="button" className="plan-collapsed" aria-expanded={false} onClick={() => setOpen(true)}>
          <CircleCheck size={13} />
          <strong>{item.title}</strong>
          <small>{tr("conversation.plan_complete_value", { p0: item.steps.length })}</small>
          <ChevronRight size={13} />
        </button>
      </section>
    );
  }
  return (
    <section className="plan-entry">
      <div className="timeline-section-heading">
        <span>{tr("conversation.plan")}</span>
        <small>
          {done}/{item.steps.length}
        </small>
        {complete ? <button type="button" className="plan-fold" aria-expanded={true} onClick={() => setOpen(false)}
          aria-label={tr("conversation.collapse_plan")} title={tr("conversation.collapse_plan")}><ChevronDown size={13} /></button> : null}
      </div>
      <strong className="plan-title">{item.title}</strong>
      <ol>
        {item.steps.map((step) => (
          <li key={step.label} data-status={step.status}>
            {step.status === "done" ? (
              <CircleCheck size={15} />
            ) : (
              <Circle size={15} />
            )}
            <span>{step.label}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Purpose: One quiet line of what the harness is doing right now, without markdown or line breaks. */
function liveLine(content: string | undefined) {
  if (!content) return "";
  const line = content
    .split(/\r?\n/)
    .map((part) => part.replace(/^[#>*\-\s`]+/, "").replace(/[*_`]+/g, "").trim())
    .find(Boolean) ?? "";
  return line.length > 72 ? `${line.slice(0, 72)}…` : line;
}

/** Purpose: A short duration for tool rows and summaries ("850 ms", "3.2 秒", "2 分 05 秒"). */
export function formatDuration(ms: number) {
  if (ms < 1000) return tr("conversation.duration_ms", { p0: Math.round(ms) });
  const seconds = ms / 1000;
  if (seconds < 60) return tr("conversation.duration_seconds", { p0: seconds < 10 ? seconds.toFixed(1) : Math.round(seconds) });
  const minutes = Math.floor(seconds / 60);
  return tr("conversation.duration_minutes", { p0: minutes, p1: String(Math.round(seconds % 60)).padStart(2, "0") });
}

function ToolProcess({ tool, active = false, open, onToggle }: {
  tool: ToolTimelineItem;
  /** Running in the live turn: its icon spins. */
  active?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
}) {
  // Details stay folded until the reader opens them, whatever the command printed or returned.
  return (
    <details className={`tool-process ${toolFailed(tool) ? "error" : tool.status}`} data-testid="tool-process" open={open ?? false}
      onToggle={event => onToggle?.(event.currentTarget.open)}>
      <summary>
        {/* Same columns as a summary line: state, what ran, then its outcome at the row's end. */}
        <span className="tool-status" role={tool.approvalAudit ? undefined : "img"} aria-hidden={tool.approvalAudit || undefined}
          aria-label={tool.approvalAudit ? undefined : tool.status === "running" ? tr("conversation.running") : toolFailed(tool) ? tr("conversation.failed") : tr("conversation.done")}>
          {active ? <LoaderCircle className="spin" size={13} /> : tool.status === "running" ? <Circle size={13} />
            : toolFailed(tool) ? <CircleAlert size={13} /> : <Check size={13} />}
        </span>
        <span className="tool-main">
          {toolLabel(tool) ? <strong>{toolLabel(tool)}</strong> : null}
          {(tool.command || !tool.approvalAudit) && <code>{tool.command || tr("conversation.waiting_for_tool_input")}</code>}
        </span>
        {/* A command's own outcome, when the harness reports it: exit code and how long it took. */}
        {typeof tool.exitCode === "number" || typeof tool.durationMs === "number" ? <span className="tool-meta">
          {typeof tool.exitCode === "number" ? <small className={`tool-exit ${tool.exitCode ? "failed" : ""}`} data-testid="tool-exit">
            {tr("conversation.exit_code_value", { p0: tool.exitCode })}</small> : null}
          {typeof tool.durationMs === "number" ? <small className="tool-duration">{formatDuration(tool.durationMs)}</small> : null}
        </span> : null}
        {tool.output || tool.permission ? <ChevronRight className="tool-process-chevron" size={13} /> : null}
      </summary>
      {tool.permission && <p className="tool-permission">{tool.permission.source} · {approvalLabel(tool.permission.policy)} {tr("conversation.execution_allowed")}</p>}
      {tool.output ? <pre>{tool.output}</pre> : null}
    </details>
  );
}

/** Purpose: Close a turn with what it left in the working tree, the way a reviewer wants to see it.
 * Input: the thread (its current workspace changes) and review/undo actions. Output: a compact card
 * listing the changed files with line counts, a Review action that opens the Changes tab and, when
 * the latest reply can be reverted, Undo.
 */
function ChangesCard({ thread, undoing, compact = false, onReview, onReviewFile, onUndo }: {
  thread: Thread;
  undoing?: boolean;
  /** The Changes tab is open: only the count line, without the file list and actions it already has. */
  compact?: boolean;
  onReview?: () => void;
  /** Each listed file opens its own diff in the Changes tab. */
  onReviewFile?: (path: string) => void;
  onUndo?: () => void;
}) {
  const files = thread.changes;
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const shown = compact ? [] : files.slice(0, 4);
  if (compact) return (
    <section className="changes-card compact" data-testid="changes-card" aria-label={tr("conversation.workspace_changes")}>
      <header>
        <FileDiff size={14} />
        <strong>{tr("conversation.value_files_changed", { p0: files.length })}</strong>
        <ins>+{additions}</ins><del>-{deletions}</del>
      </header>
    </section>
  );
  return (
    <section className="changes-card" data-testid="changes-card" aria-label={tr("conversation.workspace_changes")}>
      <header>
        <FileDiff size={14} />
        <strong>{tr("conversation.value_files_changed", { p0: files.length })}</strong>
        <ins>+{additions}</ins><del>-{deletions}</del>
        <span className="changes-card-actions">
          {onUndo ? <button type="button" disabled={undoing} onClick={onUndo}>
            <RotateCcw className={undoing ? "spin" : ""} size={13} />{undoing ? tr("conversation.reverting") : tr("inspector.undo_latest_turn")}</button> : null}
          {onReview ? <button type="button" className="primary" onClick={onReview}>{tr("conversation.review_changes")}</button> : null}
        </span>
      </header>
      <ul>
        {shown.map(file => (
          <li key={file.path}>
            <small className={`change-status ${file.status}`}>{file.status.slice(0, 1).toUpperCase()}</small>
            {onReviewFile
              ? <button type="button" className="changes-card-file" title={tr("conversation.open_file_diff", { p0: file.path })}
                  data-testid="changes-card-file" onClick={() => onReviewFile(file.path)}>{file.path}</button>
              : <span title={file.path}>{file.path}</span>}
            <ins>+{file.additions}</ins><del>-{file.deletions}</del>
          </li>
        ))}
        {files.length > shown.length ? <li className="changes-card-more">{tr("conversation.and_value_more_files", { p0: files.length - shown.length })}</li> : null}
      </ul>
    </section>
  );
}

/** Purpose: Show, in the conversation itself, which harnesses and models did this task's work:
 * the main session, subtasks the router delegated, and the evaluator that judged them. Built from
 * the task usage ledger the backend records per task; hidden when one model did everything.
 */
/** Purpose: Which saved preferences this message's turn was given, as Cleo recorded them before the
 * run: a quiet line under the message that unfolds to the entries. */
function MemoryContextNote({ context }: { context: NonNullable<Extract<TimelineItem, { type: "message" }>["memoryContext"]> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="memory-context-note" data-testid="memory-context">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Brain size={12} />
        <span>{tr("conversation.memory_context_value", { p0: context.count })}</span>
        <ChevronRight size={12} className={open ? "rotated" : ""} />
      </button>
      {open ? (
        <ul>
          {context.entries.map((entry) => <li key={entry.id || entry.content}>{entry.content}</li>)}
          {context.count > context.entries.length ? <li className="more">{tr("conversation.memory_context_more", { p0: context.count - context.entries.length })}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

/** The ledger records the task-boundary classifier as an evaluator in every mode; it judges where a
 * task starts, not the work, so it is not shown as a reviewer. */
const BOUNDARY_PART = "任务边界判断";

/** Purpose: Who did this task's work, from the backend's per-task usage ledger: the main session,
 * each delegated job (named by its ledger part) and the reviewer, each with its model. Rows wrap
 * instead of truncating, so every model stays readable; the line opens the usage table. */
function CollaborationLine({ usage, listed = [], onOpen }: {
  usage?: Thread["taskUsage"];
  /** Subtasks already listed right above with their harness and model; they are not named again. */
  listed?: Thread[];
  onOpen: () => void;
}) {
  const parts = usage?.scope === "task" ? usage.breakdown ?? [] : [];
  const titles = new Set(listed.map((subtask) => subtask.title));
  const workers = parts.filter((part) => part.role === "worker" && !titles.has(part.part ?? ""));
  const evaluators = parts.filter((part) => part.role === "evaluator" && part.part !== BOUNDARY_PART);
  if (!workers.length && !evaluators.length) return null;
  const main = parts.find((part) => part.role === "main");
  type Part = (typeof parts)[number];
  // One entry per job and model: a retried job on the same model is one contributor, not two.
  const unique = (rows: Part[], role: string) => [...new Map(rows.map((row) => [
    `${row.part ?? ""}|${row.provider ?? ""}|${row.model ?? ""}`, { role: row.part || role, row },
  ])).values()];
  const entries = [
    ...(main ? [{ role: tr("conversation.collab_role_main"), row: main }] : []),
    ...unique(workers, tr("conversation.collab_role_worker")),
    ...unique(evaluators, tr("conversation.collab_role_evaluator")).map((entry) => ({ ...entry, role: tr("conversation.collab_role_evaluator") })),
  ];
  return (
    <button type="button" className="collaboration-line" data-testid="collaboration-line" onClick={onOpen}>
      <Users size={13} />
      <span>{tr("conversation.collaboration")}</span>
      {entries.map(({ role, row }, index) => (
        <small key={`${role}|${row.provider}|${row.model}`} title={[row.provider, row.model].filter(Boolean).join(" · ")}>
          <em>{role}</em>{row.model || row.provider}
          {/* The arrow travels with the last name, so a wrap never leaves it alone on a line. */}
          {index === entries.length - 1 ? <ChevronRight size={13} /> : null}
        </small>
      ))}
    </button>
  );
}

/** Purpose: The subtasks that subtask routing delegated from this conversation, each with its state
 * and model; a row opens that subtask's own conversation. */
function SubtaskList({ subtasks, onOpen }: { subtasks: Thread[]; onOpen?: (threadId: string) => void }) {
  if (!subtasks.length) return null;
  const stateOf = (thread: Thread) => thread.waitingFor === "approval" ? tr("threadsidebar.awaiting_approval")
    : thread.waitingFor === "question" ? tr("conversation.waiting_for_an_answer")
      : thread.status === "running" ? tr("conversation.running")
        : thread.status === "attention" ? tr("threadsidebar.needs_attention")
          : thread.status === "completed" ? tr("conversation.subtask_completed") : tr("conversation.subtask_not_started");
  return (
    <section className="subtask-list" data-testid="subtask-list" aria-label={tr("conversation.subtasks")}>
      <header><GitFork size={13} /><span>{tr("conversation.subtasks")}</span><small>{subtasks.length}</small></header>
      {subtasks.map((subtask) => (
        <button type="button" className="subtask-row" key={subtask.id} data-status={subtask.waitingFor ? "attention" : subtask.status}
          onClick={() => onOpen?.(subtask.id)} title={subtask.summary}>
          {subtask.status === "running" && !subtask.waitingFor ? <LoaderCircle className="spin" size={13} />
            : subtask.status === "attention" || subtask.waitingFor ? <CircleAlert size={13} />
              : subtask.status === "completed" ? <CircleCheck size={13} /> : <Circle size={13} />}
          <strong>{subtask.title}</strong>
          <small>{[subtask.runtime?.provider, subtask.runtime?.model].filter(Boolean).join(" · ")}</small>
          <em>{stateOf(subtask)}</em>
          <ChevronRight size={13} />
        </button>
      ))}
    </section>
  );
}

/** Purpose: Keep the shared composer welcome focused on the current task. Input: space. Output: relevant example requests. */
function WelcomeState({ space, onUseSuggestion }: { space: ThreadSpace; onUseSuggestion: (prompt: string) => void }) {
  const prompts = suggestions[space];
  return (
    <div className="welcome-state">
      <div className="welcome-mark" aria-hidden="true"><span>C</span></div>
      <h2>{space === "chat" ? tr("conversation.what_would_you_like_to_talk_about") : tr("conversation.start_a_new_task")}</h2>
      <div className="suggestion-list">
        {prompts.map((suggestion) => (
          <button type="button" key={suggestion} onClick={() => {
            onUseSuggestion(suggestion);
            document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')?.focus();
          }}>
            <span>{suggestion}</span>
            <ArrowUp size={14} />
          </button>
        ))}
      </div>
    </div>
  );
}

function Composer({
  prompt,
  drafting = false,
  worktree,
  usage,
  projects = [],
  activeProjectId = "",
  onSelectProject,
  onChooseWorkspace,
  choosingWorkspace = false,
  onPromptChange: setPrompt,
  sendBlocked,
  sendError,
  harnessSwitchStatus,
  pendingHarnessSwitch,
  space,
  runtime,
  runtimeCatalog,
  productivityModels,
  runtimeModelsLoading,
  runtimeModelsError,
  running,
  onSend,
  queuedMessages = [],
  onSteerQueued,
  onSendQueued,
  onEditQueued,
  onRemoveQueued,
  steerReady,
  steeringBusy,
  onCancel,
  onSelectNonProductivityProfile,
  onLoadProductivityModels,
  onSelectProductivityRuntime,
  onEffortChange,
  onServiceTierChange,
  onPermissionChange,
  attachments,
  onPickAttachments,
  onPrepareAttachments,
  onRemoveAttachment,
  commands,
  skills = [],
  workflows = [],
  approvalRequest,
  approvalPending,
  approvalError,
  onResolveApproval,
  onListFiles,
  fileListKey = "",
  onSteerDraft,
  computerThreadId = null,
}: Pick<
  ConversationProps,
  | "prompt"
  | "onPromptChange"
  | "sendBlocked"
  | "sendError"
  | "harnessSwitchStatus"
  | "pendingHarnessSwitch"
  | "runtime"
  | "space"
  | "runtimeCatalog"
  | "productivityModels"
  | "runtimeModelsLoading"
  | "runtimeModelsError"
  | "running"
  | "onSend"
  | "queuedMessages"
  | "onSteerQueued"
  | "onSendQueued"
  | "onEditQueued"
  | "onRemoveQueued"
  | "steeringBusy"
  | "onCancel"
  | "onSelectNonProductivityProfile"
  | "onLoadProductivityModels"
  | "onSelectProductivityRuntime"
  | "onEffortChange"
  | "onServiceTierChange"
  | "onPermissionChange"
  | "attachments"
  | "onPickAttachments"
  | "onPrepareAttachments"
  | "onRemoveAttachment"
  | "commands"
  | "skills"
  | "workflows"
  | "approvalRequest"
  | "approvalPending"
  | "approvalError"
  | "onResolveApproval"
  | "projects"
  | "activeProjectId"
  | "onSelectProject"
  | "onChooseWorkspace"
  | "choosingWorkspace"
> & { steerReady?: boolean; drafting?: boolean; worktree?: ConversationProps["worktree"]; usage?: Usage;
  onListFiles?: ConversationProps["onListFiles"]; fileListKey?: string; onSteerDraft?: ConversationProps["onSteerDraft"];
  computerThreadId?: string | null }) {
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  // @-mentions: the caret position, the project's file list (read once per project) and the menu.
  const [caret, setCaret] = useState(0);
  const [fileIndex, setFileIndex] = useState<{ key: string; files: string[]; at: number; failed?: boolean } | null>(null);
  const [fileIndexRequest, setFileIndexRequest] = useState(0);
  const [selectedFile, setSelectedFile] = useState(0);
  const [dismissedMention, setDismissedMention] = useState<string | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [selectedCommand, setSelectedCommand] = useState(0);
  const [dismissedPrefix, setDismissedPrefix] = useState<string | null>(null);
  const effortProviderRequest = useRef<string | null>(null);
  const dragDepth = useRef(0);
  const selectedModel = productivityModels[runtime.provider]?.models.find(
    (model) => model.id === runtime.model,
  );
  const supportedEfforts = selectedModel?.supportedEfforts ?? [];
  const selectedEffort = runtime.effort && supportedEfforts.includes(runtime.effort)
    ? runtime.effort
    : selectedModel?.defaultEffort ?? "";

  useEffect(() => {
    if (
      space !== "productivity"
      || effortProviderRequest.current === runtime.provider
    ) return;
    effortProviderRequest.current = runtime.provider;
    void onLoadProductivityModels(runtime.provider).catch(() => undefined);
  }, [onLoadProductivityModels, productivityModels, runtime.provider, space]);

  const submit = () => {
    const content = prompt.trim() || (attachments.length ? tr("conversation.please_analyze_these_attachments") : "");
    // A workflow is started with a task: the chip alone is not sent.
    if (!content || sendBlocked || (/^\/workflow \S+$/.test(content) && workflows.length)) return;
    onSend(content);
  };
  const boundarySteer = runtime.steerMode === "boundary";
  const steerLabel = boundarySteer ? tr("conversation.send_next_turn") : tr("conversation.steer_now");
  const canSteer = running && Boolean(runtime.steerMode) && Boolean(steerReady);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (mentionOpen && !event.shiftKey && (fileMatches.length || event.key === "Escape")) {
      if (event.key === "Escape") { event.preventDefault(); setDismissedMention(mentionId); return; }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedFile((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + fileMatches.length) % fileMatches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault(); chooseFile(fileMatches[selectedFile % fileMatches.length]); return;
      }
    }
    if (candidates.length && !event.shiftKey) {
      if (event.key === "Escape") { event.preventDefault(); setDismissedPrefix(prompt); return; }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedCommand((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault(); chooseCommand(candidates[selectedCommand % candidates.length]); return;
      }
    }
    // Esc in an empty composer stops the run, as in other coding agents; with text it does nothing.
    if (event.key === "Escape" && running && !prompt.trim() && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      onCancel();
      return;
    }
    // Ctrl/Cmd+Enter submits through the active harness’s delivery mode.
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && canSteer && onSteerDraft) {
      event.preventDefault();
      if (prompt.trim() && !attachments.length && !steeringBusy) onSteerDraft(composerText);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };
  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    setAttachmentError(null);
    try {
      await onPrepareAttachments(files);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : tr("conversation.could_not_add_the_attachment"));
    }
  };
  const pickFiles = async () => {
    setAttachmentError(null);
    try {
      await onPickAttachments();
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : tr("conversation.could_not_add_the_attachment"));
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  };
  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files") || running) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDraggingFiles(true);
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files") || running) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (dragDepth.current === 0) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDraggingFiles(false);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files") || running) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDraggingFiles(false);
    void addFiles(Array.from(event.dataTransfer.files));
  };
  const showCommands = /^\/[^\s]*$/.test(prompt) && dismissedPrefix !== prompt;
  const computerUseSelected = prompt.startsWith("/computeruse ");
  // A workflow chosen from the menu rides in front of the text, like Computer Use: the composer
  // shows it as a chip and the text that follows is the task it is started with.
  const workflowPrefix = /^\/workflow (\S+) /.exec(prompt);
  const chosenWorkflow = workflowPrefix ? workflows.find((workflow) => workflow.id === workflowPrefix[1]) : undefined;
  const prefix = computerUseSelected ? "/computeruse " : chosenWorkflow ? workflowPrefix![0] : "";
  const composerText = prompt.slice(prefix.length);
  const matchingCommands = showCommands
    ? commands.filter((command) => command.startsWith(prompt))
    : [];
  const matchingWorkflows = showCommands && "/workflow".startsWith(prompt.toLowerCase()) ? workflows : [];

  const matchingSkills = showCommands
    ? skills.filter((skill) => skill.command.startsWith(prompt) || `/${skill.name}`.startsWith(prompt))
    : [];
  const candidates = [...matchingSkills.map((skill) => skill.command), ...matchingCommands, ...matchingWorkflows.map((workflow) => `/workflow ${workflow.id}`)];
  const candidateKey = candidates.join("\n");
  useEffect(() => { setSelectedCommand(0); }, [prompt, candidateKey, runtime.provider]);
  useEffect(() => { setDismissedPrefix(null); }, [runtime.provider]);
  useEffect(() => {
    document.getElementById(`slash-option-${selectedCommand}`)?.scrollIntoView({ block: "nearest" });
  }, [selectedCommand]);
  /** Insert the selected command without sending; arguments remain editable. */
  const chooseCommand = (command: string) => {
    if (composing.current) return;
    setPrompt(`${command} `);
    inputRef.current?.focus();
  };

  // "@" opens the project's files; the list is read once per project when first needed.
  const mention = onListFiles && !showCommands ? mentionAt(composerText, caret) : null;
  const mentionId = mention ? `${mention.start}:${mention.query}` : "";
  const mentionOpen = Boolean(mention) && dismissedMention !== mentionId;
  const filesReady = fileIndex?.key === fileListKey && !fileIndex.failed;
  // Opening the list re-reads the files when the copy is older than 20 s (the agent may have
  // created or renamed files); a failed read is shown with Retry, never as "no files".
  const mentionStarted = mentionOpen ? (mention?.start ?? -1) : -1;
  useEffect(() => {
    if (!mentionOpen || !onListFiles) return;
    if (fileIndex?.key === fileListKey && !fileIndex.failed && Date.now() - fileIndex.at < 20_000) return;
    let cancelled = false;
    void onListFiles().then((files) => { if (!cancelled) setFileIndex({ key: fileListKey, files, at: Date.now() }); },
      () => { if (!cancelled) setFileIndex({ key: fileListKey, files: [], at: Date.now(), failed: true }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionStarted, fileListKey, fileIndexRequest]);
  const filesFailed = Boolean(fileIndex?.key === fileListKey && fileIndex.failed);
  const fileMatches = useMemo(() => mentionOpen && mention && filesReady ? rankFiles(fileIndex!.files, mention.query, 8) : [],
    [mentionOpen, mentionId, filesReady, fileIndex]);
  useEffect(() => { setSelectedFile(0); }, [mentionId, fileMatches.length]);
  useEffect(() => {
    if (fileMatches.length) document.getElementById(`mention-option-${selectedFile}`)?.scrollIntoView({ block: "nearest" });
  }, [selectedFile, fileMatches.length]);
  /** Replace the typed "@query" with the chosen path and put the caret after it. */
  const chooseFile = (path: string) => {
    if (!mention || composing.current) return;
    const insert = mentionText(path);
    const next = composerText.slice(0, mention.start) + insert + composerText.slice(caret);
    const position = mention.start + insert.length;
    setPrompt(prefix + next);
    setCaret(position);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(position, position); });
  };

  return (
    <div className="composer-dock">
      <ApprovalPrompt
        request={space === "productivity" ? approvalRequest : null}
        pending={approvalPending}
        error={approvalError}
        onResolve={onResolveApproval}
      />
      <ComputerApprovals threadId={computerThreadId} />
      <div
        className={`composer ${running ? "running" : ""} ${draggingFiles ? "dragging-files" : ""}`}
        data-testid="composer"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {sendBlocked && sendBlocked !== harnessSwitchStatus && <p className="composer-status" role="status">{sendBlocked}</p>}
        {draggingFiles ? (
          <div className="composer-drop-overlay" aria-hidden="true">
            <Paperclip size={18} />
            <span>{tr("conversation.drop_to_add_files")}</span>
          </div>
        ) : null}
        {matchingCommands.length || matchingSkills.length || matchingWorkflows.length ? (
          <div className="slash-menu surface-popover" data-testid="slash-menu" id="slash-options" role="listbox" aria-label={tr("conversation.current_harness_skills_and_commands")}>
            <span>{tr("conversation.commands_and_skills")}</span>
            {matchingSkills.map((skill, index) => (
              <button type="button" role="option" aria-selected={selectedCommand === index} id={`slash-option-${index}`} key={skill.command} title={skill.path} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseCommand(skill.command)}>
                <code>/{skill.name}</code><small>{skill.source}{skill.command !== `/${skill.name}` ? ` · ${skill.command}` : ""}</small>
              </button>
            ))}
            {matchingCommands.map((command, index) => (
              <button type="button" role="option" aria-selected={selectedCommand === matchingSkills.length + index} id={`slash-option-${matchingSkills.length + index}`} key={command} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseCommand(command)}>
                <code>{command}</code>
              </button>
            ))}
            {matchingWorkflows.map((workflow, index) => {
              const position = matchingSkills.length + matchingCommands.length + index;
              return (
                <button type="button" role="option" aria-selected={selectedCommand === position} id={`slash-option-${position}`} key={workflow.id} data-testid="slash-workflow"
                  onMouseDown={(event) => event.preventDefault()} onClick={() => chooseCommand(`/workflow ${workflow.id}`)}>
                  <code>/workflow</code><small>{workflow.name}</small>
                </button>
              );
            })}
          </div>
        ) : showCommands ? (
          <div className="slash-menu surface-popover slash-empty" data-testid="slash-menu" role="status">
            <span>{tr("conversation.commands_and_skills")}</span>
            <p>{commands.length || skills.length ? tr("conversation.no_matching_commands") : tr("conversation.no_commands_for_this_harness")}</p>
          </div>
        ) : mentionOpen && fileMatches.length ? (
          <div className="slash-menu mention-menu surface-popover" data-testid="mention-menu" id="mention-options" role="listbox" aria-label={tr("conversation.project_files")}>
            <span>{tr("conversation.project_files")}</span>
            {fileMatches.map((path, index) => (
              <button type="button" role="option" aria-selected={selectedFile === index} id={`mention-option-${index}`} key={path} title={path}
                onMouseDown={(event) => event.preventDefault()} onClick={() => chooseFile(path)}>
                <code>{path.split("/").at(-1)}</code><small>{path.split("/").slice(0, -1).join("/")}</small>
              </button>
            ))}
          </div>
        ) : mentionOpen ? (
          <div className="slash-menu mention-menu surface-popover slash-empty" data-testid="mention-menu" role="status">
            <span>{tr("conversation.project_files")}</span>
            {filesFailed ? (
              <p>{tr("conversation.project_files_failed")}
                <button type="button" className="mention-retry" onMouseDown={(event) => event.preventDefault()}
                  onClick={() => { setFileIndex(null); setFileIndexRequest((value) => value + 1); }}>{tr("app.retry")}</button></p>
            ) : <p>{!filesReady ? tr("conversation.reading_project_files") : fileIndex?.files.length ? tr("conversation.no_matching_files") : tr("conversation.no_project_files")}</p>}
          </div>
        ) : null}
        {attachments.length ? <AttachmentChips attachments={attachments} onRemove={onRemoveAttachment} testId="composer-attachments" /> : null}
        {queuedMessages.length ? <ul className="queued-messages" aria-label={tr("conversation.queued_messages")} data-testid="queued-messages">
          {queuedMessages.map(message => <li key={message.id} className="queued-message">
            <span className="queued-text" title={message.text}>{message.text || message.attachments.map(item => item.name).join("、")}</span>
            {message.attachments.length ? <span className="queued-attachments" title={message.attachments.map(item => item.name).join("\n")}>
              {message.attachments.filter(item => item.thumbnail).slice(0, 3).map(item => <img key={item.path} src={item.thumbnail} alt="" />)}
              <Paperclip size={12} />{message.attachments.length}</span> : null}
            {canSteer && !message.attachments.length && onSteerQueued && <button type="button" className="queued-steer"
              title={boundarySteer ? steerLabel : tr("conversation.insert_into_the_current_run_now")} disabled={steeringBusy} onClick={() => onSteerQueued(message.id)} data-testid="steer-queued">
              <CornerDownRight size={13} />{steerLabel}</button>}
            {!running && onSendQueued && <button type="button" aria-label={tr("conversation.send")} title={tr("conversation.send")} disabled={Boolean(sendBlocked)}
              onClick={() => onSendQueued(message.id)}><ArrowUp size={13} /></button>}
            {onEditQueued && <button type="button" aria-label={tr("conversation.edit")} title={tr("conversation.edit")} onClick={() => { onEditQueued(message.id); inputRef.current?.focus(); }}>
              <Pencil size={13} /></button>}
            {onRemoveQueued && <button type="button" aria-label={tr("conversation.remove")} title={tr("conversation.remove")} onClick={() => onRemoveQueued(message.id)}><X size={13} /></button>}
          </li>)}
        </ul> : null}
        {attachmentError ? <div className="attachment-error" role="alert">{attachmentError}</div> : null}
        {harnessSwitchStatus ? <div className="harness-switch-status" role="status">{harnessSwitchStatus}</div> : null}
        {!harnessSwitchStatus && runtime?.handoffStatus === "submitted" ? <div className="harness-switch-status" role="status">{tr("conversation.the_handoff_was_submitted_but_its_first_turn_is_incomplete_check_the_actions_already_")}</div> : null}
        {sendError ? <div className="attachment-error" role="alert">{sendError}</div> : null}
        {chosenWorkflow && <div className="attachment-row"><span className="attachment-chip computer-use-chip" data-testid="workflow-chip">
          <Workflow size={12} /><span>{chosenWorkflow.name}</span>
          <button type="button" aria-label={tr("workflows.remove_from_task")} onClick={() => { setPrompt(composerText); inputRef.current?.focus(); }}><X size={12} /></button>
        </span></div>}
        {computerUseSelected && <div className="attachment-row"><span className="attachment-chip computer-use-chip">
          <span>Computer Use</span>
          <button type="button" aria-label={tr("conversation.remove_computer_use")} onClick={() => { setPrompt(composerText); inputRef.current?.focus(); }}><X size={12} /></button>
        </span></div>}
        <textarea
          ref={inputRef}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={Boolean(candidates.length || fileMatches.length)}
          aria-controls={candidates.length ? "slash-options" : fileMatches.length ? "mention-options" : undefined}
          aria-activedescendant={candidates.length ? `slash-option-${selectedCommand % candidates.length}`
            : fileMatches.length ? `mention-option-${selectedFile % fileMatches.length}` : undefined}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          value={composerText}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onChange={(event) => {
            setDismissedPrefix(null);
            setCaret(event.target.selectionStart);
            setPrompt(prefix + event.target.value);
          }}
          onKeyDown={(event) => {
            if (prefix && !composerText && event.key === "Backspace" && !composing.current) {
              event.preventDefault(); setPrompt(""); return;
            }
            onKeyDown(event);
          }}
          onPaste={onPaste}
          rows={1}
          aria-label={space === "chat" ? tr("conversation.message") : tr("conversation.task_description")}
          placeholder={running ? tr("conversation.queue_the_next_message") : space === "chat" ? tr("conversation.send_a_message_to_cleo") : tr("conversation.describe_what_you_want_to_accomplish")}
          data-testid="composer-input"
        />
        <div className="composer-footer">
          <div className="composer-tools">
            {drafting && onSelectProject && onChooseWorkspace && projects.length ? (
              <>
                <ProjectTarget
                  space={space}
                  projects={projects}
                  activeProjectId={activeProjectId}
                  disabled={running || Boolean(harnessSwitchStatus)}
                  choosing={choosingWorkspace}
                  onSelect={onSelectProject}
                  onChooseWorkspace={onChooseWorkspace}
                />
                {worktree ? (
                  <button type="button" className={`worktree-toggle ${worktree.enabled ? "active" : ""}`} aria-pressed={worktree.enabled}
                    data-testid="worktree-toggle" onClick={worktree.onToggle}>
                    <GitBranchPlus size={14} />
                    <span>{worktree.enabled ? tr("conversation.new_worktree") : tr("conversation.current_folder")}</span>
                  </button>
                ) : null}
                <span className="composer-divider" />
              </>
            ) : null}
            <button type="button" aria-label={tr("conversation.add_attachment")} title={tr("conversation.add_pdfs_office_documents_images_or_code_files")} onClick={() => void pickFiles()}>
              <Paperclip size={16} />
            </button>
            <span className="composer-divider" />
            {space === "productivity" ? <RuntimePicker
              runtime={runtime}
              catalog={runtimeCatalog}
              productivityModels={productivityModels}
              running={running}
              switching={Boolean(harnessSwitchStatus)}
              pendingSwitch={Boolean(pendingHarnessSwitch)}
              onLoadModels={onLoadProductivityModels}
              onSelectProductivityRuntime={onSelectProductivityRuntime}
              effort={selectedEffort}
              supportedEfforts={supportedEfforts}
              defaultEffort={selectedModel?.defaultEffort ?? null}
              onEffortChange={onEffortChange}
              serviceTier={runtime.serviceTier ?? null}
              supportsFastMode={Boolean(runtime.supportsFastMode)}
              serviceTiers={selectedModel?.serviceTiers}
              onServiceTierChange={onServiceTierChange}
            /> : <ChatModelSelector runtime={runtime} catalog={runtimeCatalog} running={running}
              onSelectProfile={onSelectNonProductivityProfile} />}
            {space === "productivity" && <PermissionSelector key={runtime.provider} runtime={runtime}
              onChange={onPermissionChange} disabled={Boolean(harnessSwitchStatus) || Boolean(pendingHarnessSwitch)} />}
          </div>
          <div className="composer-send-actions">
          <ContextMeter usage={usage} provider={space === "productivity" ? runtime.provider : undefined}
            onLoadUsage={(provider) => cleoClient.getHarnessUsage(provider)} />
          {canSteer && onSteerDraft ? (
            <button className="steer-button" type="button" data-testid="steer-now"
              disabled={steeringBusy || !prompt.trim() || attachments.length > 0}
              title={attachments.length ? undefined : tr(boundarySteer ? "conversation.send_next_turn_hint" : "conversation.steer_now_hint", { p0: modifierKey })}
              onClick={() => onSteerDraft(composerText)}>
              <CornerDownRight size={13} />{steerLabel}
            </button>
          ) : null}
          {running && (
            <button className="send-button stop" type="button" aria-label={tr("computerpanel.stop")} title={tr("conversation.stop_hint")} onClick={onCancel} data-testid="stop-button">
              <Square size={13} fill="currentColor" />
            </button>
          )}
          <button
            className="send-button"
            type="button"
            aria-label={running ? tr("conversation.add_to_queue") : tr("conversation.send")}
            title={sendBlocked || (running ? tr("conversation.add_to_queue_enter") : tr("conversation.send_enter"))}
            disabled={Boolean(sendBlocked) || (!prompt.trim() && attachments.length === 0)}
            onClick={submit}
            data-testid={running ? "queue-button" : "send-button"}
          >
            <ArrowUp size={16} />
          </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatAttachmentSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Purpose: Claude Code-style attachment chips: a small thumbnail for images, an icon for other files.
 * Input: attachments, plus a remove handler (composer) or a reveal handler (sent messages). Output: one
 * chip per file; with `onReveal` each chip is a button that locates the file and its title is the full path.
 */
function AttachmentChips({ attachments, onRemove, onReveal, className = "attachment-row", testId }: {
  attachments: Attachment[];
  onRemove?: (path: string) => void;
  onReveal?: (path: string) => void;
  className?: string;
  testId?: string;
}) {
  return <div className={className} data-testid={testId}>
    {attachments.map((attachment) => {
      const AttachmentIcon = attachment.mimeType.startsWith("image/") ? FileImage : FileText;
      const body = <>
        {attachment.thumbnail ? <img src={attachment.thumbnail} alt="" /> : <AttachmentIcon size={12} />}
        <span>{attachment.name}</span>
        <small>{formatAttachmentSize(attachment.size)}</small>
      </>;
      if (onReveal) return <button type="button" className="attachment-chip attachment-link" key={attachment.path}
        title={attachment.path} onClick={() => onReveal(attachment.path)}>{body}</button>;
      return <span className="attachment-chip" key={attachment.path} title={`${attachment.name} · ${formatAttachmentSize(attachment.size)}`}>
        {body}
        {onRemove && <button type="button" aria-label={tr("conversation.remove_value", { p0: attachment.name })} onClick={() => onRemove(attachment.path)}><X size={12} /></button>}
      </span>;
    })}
  </div>;
}

/** Purpose: The chat composer's model chip: which saved model connection answers.
 * Input: the chat model profiles and the one in use. Output: a chip naming the model, with a menu
 * of the profiles; picking one switches the chat to it.
 */
function ChatModelSelector({ runtime, catalog, running, onSelectProfile }: {
  runtime: RuntimeProfile;
  catalog: RuntimeCatalog | null;
  running: boolean;
  onSelectProfile: (profileId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    // Opening moves the keyboard into the menu, so Enter and Esc act on it, not on the composer.
    const frame = requestAnimationFrame(() => {
      const menu = wrapRef.current?.querySelector<HTMLElement>(".runtime-menu");
      if (menu && !menu.contains(document.activeElement)) {
        (menu.querySelector<HTMLElement>("[aria-pressed='true']") ?? menu.querySelector<HTMLElement>("button"))?.focus();
      }
    });
    const closeOutside = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const inside = wrapRef.current?.contains(document.activeElement);
      setOpen(false);
      if (inside) { event.preventDefault(); event.stopPropagation(); triggerRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  const profiles = catalog?.nonProductivityProfiles ?? [];
  return (
    <div className="model-menu-wrap runtime-selector" ref={wrapRef}>
      <button ref={triggerRef} className="text-control runtime-selector-trigger" type="button" disabled={running || !catalog}
        aria-label={tr("conversation.choose_chat_model")} aria-expanded={open} onClick={() => setOpen((current) => !current)}
        data-testid="runtime-selector">
        <span>{runtime.model}</span>
        <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="model-menu runtime-menu surface-popover" data-testid="runtime-menu">
          <div className="runtime-menu-heading">
            <span>{tr("conversation.model_configuration")}</span>
          </div>
          <div className="runtime-menu-list">
            {profiles.map((profile) => (
              <button className="runtime-menu-row" type="button" key={profile.id} aria-pressed={runtime.profileId === profile.id}
                onClick={() => { onSelectProfile(profile.id); setOpen(false); }}>
                <span className="runtime-menu-copy">
                  <strong>{profile.model}</strong>
                  <small>{profile.label ? `${profile.label} · ` : ""}{profile.provider}</small>
                </span>
                {runtime.profileId === profile.id ? <Check size={14} /> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
