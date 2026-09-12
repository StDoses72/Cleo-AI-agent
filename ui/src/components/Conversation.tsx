import { modifierKey } from "../platform";
import { VirtualTimeline } from "./VirtualTimeline";
import { cleoClient } from "../services/cleoClient";
import type { useTimelineHistory } from "../useTimelineHistory";
import "./timeline.css";
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
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  Command,
  ExternalLink,
  FileCode2,
  FileImage,
  FileText,
  GitBranch,
  LoaderCircle,
  MoreHorizontal,
  Paperclip,
  PanelLeftClose,
  PanelRightClose,
  RotateCcw,
  Sparkles,
  Square,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type {
  Attachment,
  ProductivityModelCatalog,
  Project,
  RuntimeCatalog,
  RuntimeProfile,
  Thread,
  ThreadSpace,
  TimelineItem,
  ApprovalDecision,
  ApprovalRequest,
} from "../types";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { RenameThreadDialog } from "./Overlays";

interface ConversationProps {
  history?: ReturnType<typeof useTimelineHistory>;
  questionUI?: ReactNode;
  preparation?: ReactNode;
  improvement?: ReactNode;
  header?: ReactNode;
  thread: Thread | null;
  project: Project | null;
  space: ThreadSpace;
  runtime: RuntimeProfile;
  runtimeCatalog: RuntimeCatalog | null;
  productivityModels: Record<string, ProductivityModelCatalog>;
  runtimeModelsLoading: string | null;
  runtimeModelsError: string | null;
  running: boolean;
  sendBlocked: string | null;
  sendError?: string;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onRename: (name: string) => Promise<void>;
  undoing: boolean;
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onOpenCommand: () => void;
  onSend: (prompt: string) => void;
  onCancel: () => void;
  onUndo: () => void;
  onSelectNonProductivityProfile: (profileId: string) => void;
  onLoadProductivityModels: (provider: string, refresh?: boolean) => Promise<ProductivityModelCatalog>;
  onSelectProductivityRuntime: (provider: string, model: string) => void;
  onEffortChange: (effort: NonNullable<RuntimeProfile["effort"]>) => void;
  attachments: Attachment[];
  onPickAttachments: () => Promise<void>;
  onPrepareAttachments: (files: File[]) => Promise<void>;
  onRemoveAttachment: (path: string) => void;
  onShowRun: () => void;
  onShowContext: () => void;
  onRevealPath: (path: string) => void;
  onOpenPath: (href: string, workspacePath: string) => void;
  onThreadCommand: (command: string) => void;
  commands: string[];
  approvalRequest: ApprovalRequest | null;
  approvalPending: boolean;
  approvalError: string | null;
  onResolveApproval: (decision: ApprovalDecision) => void;
}

const suggestions = {
  chat: ["帮我想一个轻松有趣的周末计划", "把一个复杂概念讲得简单易懂", "帮我把零散想法整理成清晰的文字"],
  productivity: ["检查当前改动并给出下一步", "为这个仓库做一次聚焦的代码审查", "解释这个项目的结构和运行方式"],
};

export function Conversation({
  history,
  questionUI,
  preparation,
  improvement,
  header,
  thread,
  project,
  space,
  runtime,
  runtimeCatalog,
  productivityModels,
  runtimeModelsLoading,
  runtimeModelsError,
  running,
  sendBlocked,
  sendError,
  prompt,
  onPromptChange,
  onRename,
  undoing,
  sidebarCollapsed,
  inspectorOpen,
  onToggleSidebar,
  onToggleInspector,
  onOpenCommand,
  onSend,
  onCancel,
  onUndo,
  onSelectNonProductivityProfile,
  onLoadProductivityModels,
  onSelectProductivityRuntime,
  onEffortChange,
  attachments,
  onPickAttachments,
  onPrepareAttachments,
  onRemoveAttachment,
  onShowRun,
  onShowContext,
  onRevealPath,
  onOpenPath,
  onThreadCommand,
  commands,
  approvalRequest,
  approvalPending,
  approvalError,
  onResolveApproval,
}: ConversationProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [bottomInset, setBottomInset] = useState(140);
  const stickToBottomRef = useRef(true);
  useLayoutEffect(() => { stickToBottomRef.current = true; }, [thread?.id]);
  useLayoutEffect(() => {
    const bottom = bottomRef.current;
    if (!bottom) return;
    const measure = () => setBottomInset(Math.ceil(bottom.getBoundingClientRect().height) + 12);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bottom);
    return () => observer.disconnect();
  }, []);
  const timelineItems = useMemo(
    () => groupTimelineItems(thread?.items ?? []),
    [thread?.items],
  );

  const [expansion, setExpansion] = useState<Record<string, { open: boolean; answered: boolean }>>({});
  const stateKey = (id: string) => `${thread?.id}:${id}`;
  const isOpen = (block: TimelineBlock) => {
    const saved = expansion[stateKey(block.id)];
    if (block.type === "thought-group") return block.hasAnswer && !saved?.answered ? false : saved?.open ?? !block.hasAnswer;
    return saved?.open ?? false;
  };
  const toggle = (id: string, open: boolean, answered = false) => setExpansion(current => {
    if (current[stateKey(id)]?.open === open && current[stateKey(id)]?.answered === answered) return current;
    const next = { ...current, [stateKey(id)]: { open, answered } };
    return Object.fromEntries(Object.entries(next).slice(-1000));
  });
  useLayoutEffect(() => {
    const changed = timelineItems.filter((block): block is ThoughtGroupBlock => block.type === "thought-group" && block.hasAnswer && !expansion[stateKey(block.id)]?.answered);
    if (!changed.length) return;
    setExpansion(current => Object.fromEntries(Object.entries({ ...current, ...Object.fromEntries(changed.map(block => [stateKey(block.id), { open: false, answered: true }])) }).slice(-1000)));
  }, [timelineItems, thread?.id, expansion]);
  const rows: TimelineRow[] = [];
  for (const block of timelineItems) {
    rows.push(block);
    if (!isOpen(block)) continue;
    if (block.type === "thought-group") rows.push(...block.thoughts.map(item => ({ id: item.id, type: "thought-row" as const, item })));
    if (block.type === "tool-group") rows.push(...block.tools.map((item, index) => ({ id: item.id, type: "tool-row" as const, item, index })));
  }
  const [reader, setReader] = useState<{ item: TimelineItem; field: string; offset: number; text: string; next: number; total: number } | null>(null);
  const [readerError, setReaderError] = useState("");
  const readerDialog = useRef<HTMLDialogElement>(null);
  const readerGeneration = useRef(0);
  useEffect(() => { readerGeneration.current++; setReader(null); }, [thread?.id]);
  useEffect(() => { if (reader) readerDialog.current?.showModal(); else readerDialog.current?.close(); }, [Boolean(reader)]);
  const readContent = async (item: TimelineItem, field: string, offset = 0) => {
    if (!thread) return;
    const generation = ++readerGeneration.current;
    setReaderError("");
    try {
      const content = await cleoClient.readTimelineContent(thread.id, item.id, field, offset);
      if (generation === readerGeneration.current) setReader({ item, field, ...content });
    } catch (error) { if (generation === readerGeneration.current) setReaderError(error instanceof Error ? error.message : "正文读取失败"); }
  };

  const trackScrollPosition = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 96 && !thread?.history?.hasAfter;
    history?.follow(stickToBottomRef.current);
    if (history?.busy || history?.error) return;
    if (viewport.scrollTop < 160 && thread?.history?.hasBefore) void history?.load("before");
    else if (distanceFromBottom < 160 && thread?.history?.hasAfter) void history?.load("after");
  };

  const renderRow = (row: TimelineRow) => {
    let item: TimelineItem | undefined;
    let content: ReactNode;
    if (row.type === "thought-group") content = <ThoughtGroupEntry item={row} projectPath={project?.path ?? null} onOpenPath={onOpenPath}
      expanded={isOpen(row)} onToggle={() => toggle(row.id, !isOpen(row), row.hasAnswer)} headerOnly />;
    else if (row.type === "tool-group") content = <ToolGroupEntry item={row} expanded={isOpen(row)} onToggle={() => toggle(row.id, !isOpen(row))} headerOnly />;
    else if (row.type === "thought-row") {
      item = row.item;
      content = <div className="thought-process-list virtual-process-row"><ThoughtEntry item={row.item} projectPath={project?.path ?? null} onOpenPath={onOpenPath} /></div>;
    } else if (row.type === "tool-row") {
      item = row.item;
      content = <div className="tool-process-list virtual-process-row"><ToolProcess tool={row.item} index={row.index}
        open={expansion[stateKey(row.id)]?.open ?? false} onToggle={open => toggle(row.id, open)} /></div>;
    } else { item = row; content = <TimelineEntry item={row} projectPath={project?.path ?? null} onOpenPath={onOpenPath} />; }
    return <>{content}{item?.more && Object.keys(item.more).map(field => <button className="history-content-link" key={field}
      onClick={() => void readContent(item!, field)}>查看完整{field === "output" ? "输出" : "正文"}（{item!.more![field]} 字符）</button>)}</>;
  };

  return (
    <main className="conversation-shell" data-testid="conversation" data-cache-count={thread?.items.length ?? 0} data-cache-first={thread?.items[0]?.id ?? ""}>
      <div className="conversation-chrome">{header ?? <ConversationHeader
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
        busy={running || Boolean(sendBlocked)}
      />}{improvement}</div>

      <div className="conversation-body" style={{ "--composer-clearance": `${bottomInset}px` } as CSSProperties}>
        <div className="conversation-viewport" ref={viewportRef} tabIndex={0} aria-label="对话历史" onWheel={event => {
          if (event.deltaY < 0) { stickToBottomRef.current = false; history?.follow(false); }
          if (!history?.busy && !history?.error) {
            const view = event.currentTarget;
            if (event.deltaY < 0 && view.scrollTop < 160 && thread?.history?.hasBefore) void history?.load("before");
            if (event.deltaY > 0 && view.scrollHeight - view.clientHeight - view.scrollTop < 160 && thread?.history?.hasAfter) void history?.load("after");
          }
        }}>
          {preparation}
        {thread?.history?.hasBefore && <button className="history-page-control" disabled={Boolean(history?.busy)} onClick={() => {
          stickToBottomRef.current = false; history?.follow(false); void history?.load("before");
        }}>加载更早历史</button>}
        {history?.error && <div className="history-error" role="alert">{history.error}<button onClick={() => void history.retry()}>重试加载</button></div>}
        {history?.busy && <div className="history-loading" role="status">正在加载历史…</div>}
        {thread?.items.length ? (
          <>
            <VirtualTimeline rows={rows} viewport={viewportRef} follow={stickToBottomRef} bottomInset={bottomInset} threadId={thread.id} render={renderRow} onScroll={trackScrollPosition} />
            {running ? (
              <div className="streaming-indicator" aria-label="Cleo 正在工作">
                <span />
                <span />
                <span />
              </div>
            ) : null}
          </>
        ) : (
          <WelcomeState project={project} space={space} onUseSuggestion={onPromptChange} />
        )}
        {thread?.history?.hasAfter && <button className="history-page-control" disabled={Boolean(history?.busy)} onClick={() => void history?.load("after")}>加载较新历史</button>}
      </div>

      <div className="conversation-bottom" ref={bottomRef}>
      {(history?.unread || thread?.history?.hasAfter || (history && !history.following)) && <button className="history-latest" aria-label="回到最新" title={history?.unread ? "有新消息 · 回到最新" : "回到最新"} data-unread={history?.unread || undefined} onClick={() => {
        void history?.load("latest", () => { stickToBottomRef.current = true; });
      }}><ArrowDown size={17} aria-hidden="true" /></button>}
      {questionUI}
      {readerError && <p className="history-error" role="alert">{readerError}</p>}
      <dialog ref={readerDialog} className="history-reader" data-content-kind={reader?.item.type} aria-label="完整历史正文"
        onKeyDown={event => event.stopPropagation()} onCancel={() => { readerGeneration.current++; setReader(null); }}>
        {reader && <><header><strong>完整历史正文</strong><button onClick={() => { readerGeneration.current++; setReader(null); }}>关闭正文</button></header>
          <p>{reader.offset + 1}–{reader.next} / {reader.total} 字符</p><pre>{reader.text}</pre>
          <footer><button disabled={!reader.offset} onClick={() => void readContent(reader.item, reader.field, Math.max(0, reader.offset - 16384))}>上一段</button>
            <button disabled={reader.next >= reader.total} onClick={() => void readContent(reader.item, reader.field, reader.next)}>下一段</button></footer></>}
      </dialog>

      <Composer
        key={thread?.id ?? `new:${space}:${project?.id}`}
        prompt={prompt}
        onPromptChange={onPromptChange}
        sendBlocked={sendBlocked}
        sendError={sendError}
        space={space}
        runtime={runtime}
        runtimeCatalog={runtimeCatalog}
        productivityModels={productivityModels}
        runtimeModelsLoading={runtimeModelsLoading}
        runtimeModelsError={runtimeModelsError}
        running={running}
        onSend={onSend}
        onCancel={onCancel}
        onSelectNonProductivityProfile={onSelectNonProductivityProfile}
        onLoadProductivityModels={onLoadProductivityModels}
        onSelectProductivityRuntime={onSelectProductivityRuntime}
        onEffortChange={onEffortChange}
        attachments={attachments}
        onPickAttachments={onPickAttachments}
        onPrepareAttachments={onPrepareAttachments}
        onRemoveAttachment={onRemoveAttachment}
        onShowContext={onShowContext}
        commands={commands}
        approvalRequest={approvalRequest}
        approvalPending={approvalPending}
        approvalError={approvalError}
        onResolveApproval={onResolveApproval}
      />
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
  busy,
}: Pick<
  ConversationProps,
  | "thread"
  | "project"
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
> & { busy: boolean }) {
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setThreadMenuOpen(false);
    setRenameOpen(false);
  }, [thread?.id]);
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
          aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
          title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
          onClick={onToggleSidebar}
        >
          <PanelLeftClose size={17} />
        </button>
        <div className="breadcrumb">
          <span className="breadcrumb-project">{project?.name ?? "Cleo"}</span>
          <ChevronRight size={13} />
          <strong>{thread?.title ?? (space === "chat" ? "新对话" : "新任务")}</strong>
        </div>
      </div>
      <div className="header-actions">
        {space === "productivity" ? (
          <button
            className="undo-button"
            type="button"
            disabled={!thread || running || undoing}
            aria-label="回退 Git 改动"
            title="回退最近一次回答产生的 Git 改动"
            onClick={onUndo}
          >
            <RotateCcw className={undoing ? "spin" : ""} size={14} />
            <span>{undoing ? "回退中" : "Undo"}</span>
          </button>
        ) : null}
        {project?.branch ? (
          <button className="branch-button" type="button" onClick={() => onRevealPath(project.path)}> 
            <GitBranch size={14} />
            <span>{project.branch}</span>
            {project.dirtyFiles ? <small>{project.dirtyFiles}</small> : null}
          </button>
        ) : null}
        <button className="icon-button" type="button" aria-label="运行记录" title="查看运行记录" onClick={onShowRun}>
          <Terminal size={16} />
        </button>
        <button className="icon-button" type="button" aria-label="命令面板" title={`命令面板 · ${modifierKey} K`} onClick={onOpenCommand}>
          <Command size={16} />
        </button>
        <div className="thread-actions-wrap" ref={menuRef}>
          <button className="icon-button" type="button" aria-label="更多" title="会话操作" disabled={!thread || busy} aria-expanded={threadMenuOpen} onClick={() => setThreadMenuOpen((open) => !open)}>
            <MoreHorizontal size={17} />
          </button>
          {threadMenuOpen ? (
            <div className="thread-actions-menu surface-popover">
              <button type="button" onClick={() => {
                setThreadMenuOpen(false);
                setRenameOpen(true);
              }}>重命名</button>
              {thread?.space === "productivity" ? <>
                <button type="button" onClick={() => runThreadCommand("/fork")}>Fork thread</button>
                <button type="button" onClick={() => runThreadCommand("/compact")}>压缩上下文</button>
                <button className="danger" type="button" onClick={() => {
                  if (window.confirm("归档当前 thread 并创建一个新任务？")) runThreadCommand("/archive");
                }}>归档</button>
              </> : null}
            </div>
          ) : null}
        </div>
        <span className="header-divider" />
        <button
          className={`icon-button ${inspectorOpen ? "active" : ""}`}
          type="button"
          aria-label={inspectorOpen ? "关闭检查器" : "打开检查器"}
          title={inspectorOpen ? "关闭检查器" : "打开检查器"}
          onClick={onToggleInspector}
        >
          <PanelRightClose size={17} />
        </button>
      </div>
      {renameOpen && thread ? (
        <RenameThreadDialog title={thread.title} onSave={onRename} onClose={() => setRenameOpen(false)} />
      ) : null}
    </header>
  );
}

type ToolTimelineItem = Extract<TimelineItem, { type: "tool" }>;
type ThoughtTimelineItem = Extract<TimelineItem, { type: "thought" }>;
type ToolGroupBlock = {
  id: string;
  type: "tool-group";
  tools: ToolTimelineItem[];
};
type ThoughtGroupBlock = {
  id: string;
  type: "thought-group";
  thoughts: ThoughtTimelineItem[];
  hasAnswer: boolean;
};
type TimelineBlock = Exclude<TimelineItem, { type: "thought" | "tool" }>
  | ThoughtGroupBlock
  | ToolGroupBlock;
type TimelineRow = TimelineBlock | { id: string; type: "thought-row"; item: ThoughtTimelineItem }
  | { id: string; type: "tool-row"; item: ToolTimelineItem; index: number };

function groupTimelineItems(items: TimelineItem[]): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  let turn: TimelineItem[] = [];
  let turnId = "initial";

  const flushTurn = () => {
    if (!turn.length) return;
    const assistants = turn.filter(
      (item): item is Extract<TimelineItem, { type: "message" }> =>
        item.type === "message" && item.role === "assistant",
    );
    const process = turn.filter(
      (item) => item.type !== "message" || item.role !== "assistant",
    );
    const thoughts = process.filter(
      (item): item is ThoughtTimelineItem => item.type === "thought",
    );
    const tools = process.filter(
      (item): item is ToolTimelineItem => item.type === "tool",
    );
    let addedThoughtGroup = false;
    let addedToolGroup = false;

    for (const item of process) {
      if (item.type === "thought" && !addedThoughtGroup) {
        blocks.push({
          id: `thought-group-${turnId}`,
          type: "thought-group",
          thoughts,
          hasAnswer: assistants.some(item => item.content.trim()) || turn.some(item => item.turnHasAnswer),
        });
        addedThoughtGroup = true;
      } else if (item.type === "tool" && !addedToolGroup) {
        blocks.push({
          id: `tool-group-${turnId}`,
          type: "tool-group",
          tools,
        });
        addedToolGroup = true;
      } else if (item.type !== "thought" && item.type !== "tool") {
        blocks.push(item);
      }
    }
    blocks.push(...assistants);
    turn = [];
  };

  for (const item of items) {
    const next = item.turnId ?? (item.type === "message" && item.role === "user" ? item.id : turnId);
    if (next !== turnId && turn.length) flushTurn();
    turnId = next;
    turn.push(item);
  }
  flushTurn();
  return blocks;
}

function TimelineEntry({
  item,
  projectPath,
  onOpenPath,
}: {
  item: TimelineBlock;
  projectPath: string | null;
  onOpenPath: ConversationProps["onOpenPath"];
}) {
  if (item.type === "thought-group") {
    return <ThoughtGroupEntry item={item} projectPath={projectPath} onOpenPath={onOpenPath} />;
  }
  if (item.type === "tool-group") return <ToolGroupEntry item={item} />;
  if (item.type === "plan") return <PlanEntry item={item} />;
  if (item.type === "question") return <section className="question-history" data-testid="question-history">
    <strong>{item.request.status === "answered" ? "已回答 Agent 提问" : item.request.status === "pending" ? "等待回答" : item.request.status === "cancelled" ? "提问已取消" : "旧提问已失效，请让 Agent 重新提问"}</strong>
    {item.request.questions.map(question => <div key={question.id}><p>{question.question}</p>
      {item.request.answers?.[question.id] && <p className="question-history-answer">{question.secret ? "（已隐藏）" : item.request.answers[question.id].join("、")}</p>}</div>)}
  </section>;
  if (item.type === "message") {
    return (
      <article className={`message-entry ${item.role}`}>
        <div className="message-meta">
          <span>{item.role === "user" ? "你" : "Cleo"}</span>
          <time>{item.time}</time>
        </div>
        <div className="message-copy">
          <MarkdownContent
            content={item.content}
            projectPath={projectPath}
            onOpenPath={onOpenPath}
          />
        </div>
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
        <p>{item.detail}</p>
      </div>
    </div>
  );
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
      remarkPlugins={[remarkGfm]}
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
          if (hasUnsupportedScheme || !projectPath) {
            return (
              <span
                className="markdown-link local-file-link disabled"
                title={hasUnsupportedScheme ? "不支持这个链接类型" : "当前任务没有关联工作目录"}
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
              title={`在系统默认应用中打开 · ${href}`}
              onClick={(event) => {
                event.preventDefault();
                onOpenPath(href, projectPath);
              }}
            >
              <span>{children}</span>
              <FileCode2 aria-hidden="true" size={11} />
            </a>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function markdownUrlTransform(value: string, key: string): string {
  if (key === "href" && (/^[a-z]:[\\/]/i.test(value) || /^file:/i.test(value))) {
    return value;
  }
  return defaultUrlTransform(value);
}

function ThoughtGroupEntry({
  item,
  projectPath,
  onOpenPath,
  expanded: controlled,
  onToggle,
  headerOnly = false,
}: {
  item: ThoughtGroupBlock;
  projectPath: string | null;
  onOpenPath: ConversationProps["onOpenPath"];
  expanded?: boolean;
  onToggle?: () => void;
  headerOnly?: boolean;
}) {
  const [localExpanded, setExpanded] = useState(!item.hasAnswer);
  const expanded = controlled ?? localExpanded;
  const running = item.thoughts.some((thought) => thought.status === "running");
  const summary = running
    ? `${item.thoughts.length} 条记录 · 正在更新`
    : `${item.thoughts.length} 条记录 · ${item.hasAnswer ? "已有最终回答" : "尚无最终回答"}`;

  return (
    <section className={`thought-group ${running ? "running" : "done"}`} data-testid="thought-group">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle ?? (() => setExpanded((value) => !value))}
      >
        <span className="thought-icon">
          {running ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
        </span>
        <span className="tool-group-copy">
          <strong>思考过程</strong>
          <small>{summary}</small>
        </span>
        <span className="tool-group-actions">
          {running ? <LoaderCircle className="spin" size={15} /> : null}
          <ChevronDown className={expanded ? "rotated" : ""} size={15} />
        </span>
      </button>
      {expanded && !headerOnly ? (
        <div className="thought-process-list">
          {item.thoughts.map((thought) => (
            <ThoughtEntry
              key={thought.id}
              item={thought}
              projectPath={projectPath}
              onOpenPath={onOpenPath}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

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
      {item.status === "running" ? (
        <LoaderCircle className="spin" size={15} />
      ) : (
        <Sparkles size={15} />
      )}
      <div className="thought-copy">
        <MarkdownContent content={item.content} projectPath={projectPath} onOpenPath={onOpenPath} />
      </div>
    </div>
  );
}

function PlanEntry({ item }: { item: Extract<TimelineItem, { type: "plan" }> }) {
  return (
    <section className="plan-entry">
      <div className="timeline-section-heading">
        <span>计划</span>
        <small>
          {item.steps.filter((step) => step.status === "done").length}/{item.steps.length}
        </small>
      </div>
      <strong className="plan-title">{item.title}</strong>
      <ol>
        {item.steps.map((step) => (
          <li key={step.label} data-status={step.status}>
            {step.status === "done" ? (
              <CircleCheck size={15} />
            ) : step.status === "running" ? (
              <LoaderCircle className="spin" size={15} />
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

function ToolGroupEntry({ item, expanded: controlled, onToggle, headerOnly = false }: { item: ToolGroupBlock; expanded?: boolean; onToggle?: () => void; headerOnly?: boolean }) {
  const [localExpanded, setExpanded] = useState(false);
  const expanded = controlled ?? localExpanded;
  const runningCount = item.tools.filter((tool) => tool.status === "running").length;
  const errorCount = item.tools.filter((tool) => tool.status === "error").length;
  const status = runningCount ? "running" : errorCount ? "error" : "done";
  const summary = runningCount
    ? `${item.tools.length} 次调用 · ${runningCount} 个运行中`
    : errorCount
      ? `${item.tools.length} 次调用 · ${errorCount} 个失败`
      : `${item.tools.length} 次调用 · 已完成`;
  return (
    <section className={`tool-group ${status}`} data-testid="tool-group">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle ?? (() => setExpanded((value) => !value))}
      >
        <span className="tool-icon"><Wrench size={14} /></span>
        <span className="tool-group-copy">
          <strong>工具过程</strong>
          <small>{summary}</small>
        </span>
        <span className="tool-group-actions">
          {status === "running" ? <LoaderCircle className="spin" size={15} /> : null}
          <ChevronDown className={expanded ? "rotated" : ""} size={15} />
        </span>
      </button>
      {expanded && !headerOnly ? (
        <div className="tool-process-list">
          {item.tools.map((tool, index) => (
            <ToolProcess key={tool.id} tool={tool} index={index} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ToolProcess({ tool, index, open, onToggle }: { tool: ToolTimelineItem; index: number; open?: boolean; onToggle?: (open: boolean) => void }) {
  return (
    <details className={`tool-process ${tool.status}`} data-testid="tool-process" open={open} onToggle={event => onToggle?.(event.currentTarget.open)}>
      <summary>
        <span className="tool-process-index">{String(index + 1).padStart(2, "0")}</span>
        <span className="tool-main">
          <span>
            <strong>{tool.name}</strong>
            <small>{tool.status === "running" ? "运行中" : tool.status === "error" ? "失败" : "完成"}</small>
          </span>
          <code>{tool.command || "等待工具输入"}</code>
        </span>
        {tool.status === "running" ? (
          <LoaderCircle className="spin" size={14} />
        ) : tool.status === "error" ? (
          <X size={14} />
        ) : tool.output ? (
          <ChevronRight className="tool-process-chevron" size={14} />
        ) : (
          <Check size={14} />
        )}
      </summary>
      {tool.output ? <pre>{tool.output}</pre> : null}
    </details>
  );
}

/** Purpose: Keep the shared composer welcome focused on the current task. Input: project/space. Output: relevant example requests. */
function WelcomeState({ project, space, onUseSuggestion }: { project: Project | null; space: ThreadSpace; onUseSuggestion: (prompt: string) => void }) {
  const evolving = project?.id === "productivity:cleo-evolution";
  const prompts = evolving ? ["让 Cleo 的界面更清晰一些", "为 Cleo 增加一个我需要的功能", "帮我改善 Cleo 的使用体验"] : suggestions[space];
  return (
    <div className="welcome-state">
      <div className="welcome-portrait-wrap">
        <img src="./cleo.png" alt="Cleo" />
      </div>
      <span className="eyebrow">{project?.name ?? "CLEO"}</span>
      <h2>{evolving ? "你想让 Cleo 怎样改变？" : space === "chat" ? "今天想聊些什么？" : "从一个清晰的目标开始。"}</h2>
      <p>{evolving ? "直接描述需求，我会完成修改和检查。应用后，你再决定是否保存。" : space === "chat" ? "聊聊想法、学习新知，或一起解决生活中的小问题。" : "我会先理解工作区，再决定需要读取、修改和验证什么。"}</p>
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
  onPromptChange: setPrompt,
  sendBlocked,
  sendError,
  space,
  runtime,
  runtimeCatalog,
  productivityModels,
  runtimeModelsLoading,
  runtimeModelsError,
  running,
  onSend,
  onCancel,
  onSelectNonProductivityProfile,
  onLoadProductivityModels,
  onSelectProductivityRuntime,
  onEffortChange,
  attachments,
  onPickAttachments,
  onPrepareAttachments,
  onRemoveAttachment,
  onShowContext,
  commands,
  approvalRequest,
  approvalPending,
  approvalError,
  onResolveApproval,
}: Pick<
  ConversationProps,
  | "prompt"
  | "onPromptChange"
  | "sendBlocked"
  | "sendError"
  | "runtime"
  | "space"
  | "runtimeCatalog"
  | "productivityModels"
  | "runtimeModelsLoading"
  | "runtimeModelsError"
  | "running"
  | "onSend"
  | "onCancel"
  | "onSelectNonProductivityProfile"
  | "onLoadProductivityModels"
  | "onSelectProductivityRuntime"
  | "onEffortChange"
  | "attachments"
  | "onPickAttachments"
  | "onPrepareAttachments"
  | "onRemoveAttachment"
  | "onShowContext"
  | "commands"
  | "approvalRequest"
  | "approvalPending"
  | "approvalError"
  | "onResolveApproval"
>) {
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
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
    const content = prompt.trim() || (attachments.length ? "请分析这些附件。" : "");
    if (!content || running || sendBlocked) return;
    onSend(content);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };
  const addFiles = async (files: File[]) => {
    if (!files.length || running) return;
    setAttachmentError(null);
    try {
      await onPrepareAttachments(files);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "无法添加附件");
    }
  };
  const pickFiles = async () => {
    setAttachmentError(null);
    try {
      await onPickAttachments();
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "无法添加附件");
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
  const matchingCommands = prompt.startsWith("/")
    ? commands.filter((command) => command.startsWith(prompt.trim())).slice(0, 8)
    : [];

  return (
    <div className="composer-dock">
      <ApprovalPrompt
        request={space === "productivity" ? approvalRequest : null}
        pending={approvalPending}
        error={approvalError}
        onResolve={onResolveApproval}
      />
      <div
        className={`composer ${running ? "running" : ""} ${draggingFiles ? "dragging-files" : ""}`}
        data-testid="composer"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {sendBlocked && <p className="composer-status" role="status">{sendBlocked}</p>}
        {draggingFiles ? (
          <div className="composer-drop-overlay" aria-hidden="true">
            <Paperclip size={18} />
            <span>松开以添加文件</span>
          </div>
        ) : null}
        {matchingCommands.length ? (
          <div className="slash-menu surface-popover" data-testid="slash-menu">
            <span>可用命令</span>
            {matchingCommands.map((command) => (
              <button type="button" key={command} onClick={() => setPrompt(`${command} `)}>
                <code>{command}</code>
              </button>
            ))}
          </div>
        ) : null}
        {attachments.length ? (
          <div className="attachment-row">
            {attachments.map((attachment) => {
              const AttachmentIcon = attachment.mimeType.startsWith("image/") ? FileImage : FileText;
              return (
                <span className="attachment-chip" key={attachment.path} title={`${attachment.name} · ${formatAttachmentSize(attachment.size)}`}>
                  <AttachmentIcon size={12} />
                  <span>{attachment.name}</span>
                  <small>{formatAttachmentSize(attachment.size)}</small>
                  <button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => onRemoveAttachment(attachment.path)}><X size={12} /></button>
                </span>
              );
            })}
          </div>
        ) : null}
        {attachmentError ? <div className="attachment-error" role="alert">{attachmentError}</div> : null}
        {sendError ? <div className="attachment-error" role="alert">{sendError}</div> : null}
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          aria-label={space === "chat" ? "消息" : "任务描述"}
          placeholder={running ? "Cleo 正在回复…" : space === "chat" ? "向 Cleo 发送消息…" : "描述你想完成的事情"}
          disabled={running}
          data-testid="composer-input"
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <button type="button" aria-label="添加附件" title="添加 PDF、Office、图片或代码文件" disabled={running} onClick={() => void pickFiles()}>
              <Paperclip size={16} />
            </button>
            <button type="button" aria-label="添加上下文" title="查看已附加上下文" onClick={onShowContext}> 
              <AtSign size={16} />
            </button>
            <span className="composer-divider" />
            <RuntimeSelector
              space={space}
              runtime={runtime}
              catalog={runtimeCatalog}
              productivityModels={productivityModels}
              loadingProvider={runtimeModelsLoading}
              error={runtimeModelsError}
              running={running}
              onSelectProfile={onSelectNonProductivityProfile}
              onLoadModels={onLoadProductivityModels}
              onSelectProductivityRuntime={onSelectProductivityRuntime}
            />
            {space === "productivity" ? <select
              className="text-control effort-selector"
              value={selectedEffort}
              disabled={running || space !== "productivity" || supportedEfforts.length === 0}
              onChange={(event) => onEffortChange(
                event.target.value as NonNullable<RuntimeProfile["effort"]>,
              )}
              aria-label="思考深度"
              title="选择思考深度"
              data-testid="effort-selector"
            >
              <option value="" disabled>由 harness 管理</option>
              {supportedEfforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
            </select> : null}
          </div>
          {running ? (
            <button className="send-button stop" type="button" aria-label="停止" title="停止" onClick={onCancel} data-testid="stop-button">
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              className="send-button"
              type="button"
              aria-label="发送"
              title="发送 · Enter"
              disabled={Boolean(sendBlocked) || (!prompt.trim() && attachments.length === 0)}
              onClick={submit}
              data-testid="send-button"
            >
              <ArrowUp size={16} />
            </button>
          )}
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

/** Purpose: Share harness/model selection across development and evolution.
 * Input: live catalogs and selection callbacks. Output: accessible picker with retry.
 */
function RuntimeSelector({
  space,
  runtime,
  catalog,
  productivityModels,
  loadingProvider,
  error,
  running,
  onSelectProfile,
  onLoadModels,
  onSelectProductivityRuntime,
}: {
  space: ThreadSpace;
  runtime: RuntimeProfile;
  catalog: RuntimeCatalog | null;
  productivityModels: Record<string, ProductivityModelCatalog>;
  loadingProvider: string | null;
  error: string | null;
  running: boolean;
  onSelectProfile: (profileId: string) => void;
  onLoadModels: (provider: string, refresh?: boolean) => Promise<ProductivityModelCatalog>;
  onSelectProductivityRuntime: (provider: string, model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [providerScreen, setProviderScreen] = useState<string | null>(null);
  const profiles = catalog?.nonProductivityProfiles ?? [];
  const providers = catalog?.productivityProviders ?? [];
  const selectedProfile = profiles.find(
    (profile) => profile.id === runtime.profileId,
  );
  const selectedProvider = providers.find(
    (provider) => provider.id === providerScreen,
  );
  const selectedModels = providerScreen ? productivityModels[providerScreen]?.models : undefined;

  useEffect(() => {
    setOpen(false);
    setProviderScreen(null);
  }, [space]);

  const toggleMenu = () => {
    setOpen((current) => {
      if (current) setProviderScreen(null);
      return !current;
    });
  };
  const openProvider = (provider: string) => {
    setProviderScreen(provider);
    void onLoadModels(provider, true).catch(() => undefined);
  };

  return (
    <div className="model-menu-wrap runtime-selector">
      <button
        className="text-control runtime-selector-trigger"
        type="button"
        disabled={running || !catalog}
        aria-label={space === "productivity" ? "选择 Harness 和模型" : "选择对话模型"}
        aria-expanded={open}
        onClick={toggleMenu}
        data-testid="runtime-selector"
      >
        <span>{space === "productivity" ? `${runtime.provider} · ` : ""}{runtime.model}</span>
        <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="model-menu runtime-menu surface-popover" data-testid="runtime-menu">
          {space === "chat" ? (
            <>
              <div className="runtime-menu-heading">
                <span>模型配置</span>
                <small>cleo.json</small>
              </div>
              <div className="runtime-menu-list">
                {profiles.map((profile) => (
                  <button
                    className="runtime-menu-row"
                    type="button"
                    key={profile.id}
                    onClick={() => {
                      onSelectProfile(profile.id);
                      setOpen(false);
                    }}
                  >
                    <span className="runtime-menu-copy">
                      <strong>{profile.model}</strong>
                      <small>{profile.id} · {profile.provider}</small>
                    </span>
                    {(selectedProfile?.id ?? runtime.profileId) === profile.id ? <Check size={14} /> : null}
                  </button>
                ))}
              </div>
            </>
          ) : providerScreen ? (
            <>
              <div className="runtime-menu-heading runtime-menu-heading-back">
                <button type="button" aria-label="返回 provider 列表" onClick={() => setProviderScreen(null)}>
                  <ArrowLeft size={14} />
                </button>
                <span>{selectedProvider?.id ?? providerScreen}</span>
                <small>{providerTypeLabel(selectedProvider?.type)}</small>
              </div>
              <div className="runtime-menu-list">
                {loadingProvider === providerScreen ? (
                  <div className="runtime-menu-status"><LoaderCircle className="spin" size={14} />正在连接 harness 并读取模型…</div>
                ) : error ? (
                  <div className="runtime-menu-status error" role="alert">
                    <span>{error}</span>
                    <button type="button" onClick={() => openProvider(providerScreen)}>重试读取模型</button>
                  </div>
                ) : (
                  selectedModels?.map((model) => (
                    <button
                      className="runtime-menu-row"
                      type="button"
                      key={model.id}
                      onClick={() => {
                        onSelectProductivityRuntime(providerScreen, model.id);
                        setOpen(false);
                        setProviderScreen(null);
                      }}
                    >
                      <span className="runtime-menu-copy">
                        <strong>{model.label}</strong>
                        {model.description ? <small>{model.description}</small> : null}
                      </span>
                      {runtime.provider === providerScreen && runtime.model === model.id ? <Check size={14} /> : null}
                    </button>
                  ))
                )}
              </div>
            </>
          ) : (
            <>
              <div className="runtime-menu-heading">
                <span>选择 Harness</span>
                <small>新任务生效 · 历史保留</small>
              </div>
              <div className="runtime-menu-list">
                {providers.map((provider) => (
                  <button
                    className="runtime-menu-row"
                    type="button"
                    key={provider.id}
                    onClick={() => openProvider(provider.id)}
                  >
                    <span className="runtime-menu-copy">
                      <strong>{provider.id}</strong>
                      <small>{providerTypeLabel(provider.type)}{provider.defaultModel ? ` · ${provider.defaultModel}` : ""}</small>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function providerTypeLabel(type?: string) {
  if (type === "codex_sdk") return "Codex SDK";
  if (type === "claude_sdk") return "Claude Agent SDK";
  if (type === "acp") return "ACP";
  return "Provider";
}
