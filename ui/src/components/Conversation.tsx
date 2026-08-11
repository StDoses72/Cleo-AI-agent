import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  Command,
  GitBranch,
  LoaderCircle,
  MoreHorizontal,
  Paperclip,
  PanelLeftClose,
  PanelRightClose,
  Sparkles,
  Square,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type { Attachment, Project, RuntimeProfile, Thread, TimelineItem } from "../types";

interface ConversationProps {
  thread: Thread | null;
  project: Project | null;
  runtime: RuntimeProfile;
  running: boolean;
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onOpenCommand: () => void;
  onSend: (prompt: string) => void;
  onCancel: () => void;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: RuntimeProfile["effort"]) => void;
  attachments: Attachment[];
  onPickAttachments: () => void;
  onRemoveAttachment: (path: string) => void;
  onShowRun: () => void;
  onShowContext: () => void;
  onRevealPath: (path: string) => void;
  onThreadCommand: (command: string) => void;
  commands: string[];
}

const suggestions = [
  "检查当前改动并给出下一步",
  "为这个仓库做一次聚焦的代码审查",
  "解释 session 与 memory 的数据流",
];

export function Conversation({
  thread,
  project,
  runtime,
  running,
  sidebarCollapsed,
  inspectorOpen,
  onToggleSidebar,
  onToggleInspector,
  onOpenCommand,
  onSend,
  onCancel,
  onModelChange,
  onEffortChange,
  attachments,
  onPickAttachments,
  onRemoveAttachment,
  onShowRun,
  onShowContext,
  onRevealPath,
  onThreadCommand,
  commands,
}: ConversationProps) {
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  }, [thread?.items.length, thread?.id]);

  return (
    <main className="conversation-shell" data-testid="conversation">
      <ConversationHeader
        thread={thread}
        project={project}
        sidebarCollapsed={sidebarCollapsed}
        inspectorOpen={inspectorOpen}
        onToggleSidebar={onToggleSidebar}
        onToggleInspector={onToggleInspector}
        onOpenCommand={onOpenCommand}
        onShowRun={onShowRun}
        onRevealPath={onRevealPath}
        onThreadCommand={onThreadCommand}
      />

      <div className="conversation-viewport" ref={viewportRef}>
        {thread?.items.length ? (
          <div className="timeline" key={thread.id} data-testid="timeline">
            {thread.items.map((item) => (
              <TimelineEntry key={item.id} item={item} />
            ))}
            {running ? (
              <div className="streaming-indicator" aria-label="Cleo 正在工作">
                <span />
                <span />
                <span />
              </div>
            ) : null}
          </div>
        ) : (
          <WelcomeState project={project} onUseSuggestion={onSend} />
        )}
      </div>

      <Composer
        runtime={runtime}
        running={running}
        onSend={onSend}
        onCancel={onCancel}
        onModelChange={onModelChange}
        onEffortChange={onEffortChange}
        attachments={attachments}
        onPickAttachments={onPickAttachments}
        onRemoveAttachment={onRemoveAttachment}
        onShowContext={onShowContext}
        commands={commands}
      />
    </main>
  );
}

function ConversationHeader({
  thread,
  project,
  sidebarCollapsed,
  inspectorOpen,
  onToggleSidebar,
  onToggleInspector,
  onOpenCommand,
  onShowRun,
  onRevealPath,
  onThreadCommand,
}: Pick<
  ConversationProps,
  | "thread"
  | "project"
  | "sidebarCollapsed"
  | "inspectorOpen"
  | "onToggleSidebar"
  | "onToggleInspector"
  | "onOpenCommand"
  | "onShowRun"
  | "onRevealPath"
  | "onThreadCommand"
>) {
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
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
          <strong>{thread?.title ?? "新任务"}</strong>
        </div>
      </div>
      <div className="header-actions">
        {project?.branch ? (
          <button className="branch-button" type="button" onClick={() => onRevealPath(project.path)}> 
            <GitBranch size={14} />
            <span>{project.branch}</span>
            {project.dirtyFiles ? <small>{project.dirtyFiles}</small> : null}
          </button>
        ) : null}
        <button className="icon-button" type="button" aria-label="终端" title="终端" onClick={onShowRun}> 
          <Terminal size={16} />
        </button>
        <button className="icon-button" type="button" aria-label="命令面板" title="命令面板 · Ctrl K" onClick={onOpenCommand}>
          <Command size={16} />
        </button>
        <div className="thread-actions-wrap">
          <button className="icon-button" type="button" aria-label="更多" title="Thread 操作" onClick={() => setThreadMenuOpen((open) => !open)}> 
            <MoreHorizontal size={17} />
          </button>
          {threadMenuOpen ? (
            <div className="thread-actions-menu surface-popover">
              <button type="button" onClick={() => {
                const name = window.prompt("新的 thread 名称", thread?.title ?? "");
                if (name?.trim()) runThreadCommand(`/rename ${name.trim()}`);
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
    </header>
  );
}

function TimelineEntry({ item }: { item: TimelineItem }) {
  if (item.type === "message") {
    return (
      <article className={`message-entry ${item.role}`}>
        <div className="message-meta">
          <span>{item.role === "user" ? "你" : "Cleo"}</span>
          <time>{item.time}</time>
        </div>
        <div className="message-copy">
          {item.content.split("\n").map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
      </article>
    );
  }
  if (item.type === "thought") {
    return (
      <div className={`thought-entry ${item.status}`}>
        {item.status === "running" ? (
          <LoaderCircle className="spin" size={15} />
        ) : (
          <Sparkles size={15} />
        )}
        <span>{item.content}</span>
      </div>
    );
  }
  if (item.type === "plan") return <PlanEntry item={item} />;
  if (item.type === "tool") return <ToolEntry item={item} />;
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

function ToolEntry({ item }: { item: Extract<TimelineItem, { type: "tool" }> }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className={`tool-entry ${item.status}`}>
      <button type="button" onClick={() => setExpanded((value) => !value)}>
        <span className="tool-icon"><Wrench size={14} /></span>
        <span className="tool-main">
          <span>
            <strong>{item.name}</strong>
            <small>{item.status === "running" ? "运行中" : item.status === "error" ? "失败" : "完成"}</small>
          </span>
          <code>{item.command}</code>
        </span>
        {item.status === "running" ? <LoaderCircle className="spin" size={15} /> : <ChevronDown className={expanded ? "rotated" : ""} size={15} />}
      </button>
      {expanded && item.output ? <pre>{item.output}</pre> : null}
    </section>
  );
}

function WelcomeState({ project, onUseSuggestion }: { project: Project | null; onUseSuggestion: (prompt: string) => void }) {
  return (
    <div className="welcome-state">
      <div className="welcome-portrait-wrap">
        <img src="./cleo.png" alt="Cleo" />
      </div>
      <span className="eyebrow">{project?.name ?? "CLEO"}</span>
      <h2>从一个清晰的目标开始。</h2>
      <p>我会先理解工作区，再决定需要读取、修改和验证什么。</p>
      <div className="suggestion-list">
        {suggestions.map((suggestion) => (
          <button type="button" key={suggestion} onClick={() => onUseSuggestion(suggestion)}>
            <span>{suggestion}</span>
            <ArrowUp size={14} />
          </button>
        ))}
      </div>
    </div>
  );
}

function Composer({
  runtime,
  running,
  onSend,
  onCancel,
  onModelChange,
  onEffortChange,
  attachments,
  onPickAttachments,
  onRemoveAttachment,
  onShowContext,
  commands,
}: Pick<
  ConversationProps,
  | "runtime"
  | "running"
  | "onSend"
  | "onCancel"
  | "onModelChange"
  | "onEffortChange"
  | "attachments"
  | "onPickAttachments"
  | "onRemoveAttachment"
  | "onShowContext"
  | "commands"
>) {
  const [prompt, setPrompt] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const submit = () => {
    if (!prompt.trim() || running) return;
    onSend(prompt);
    setPrompt("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };
  const cycleEffort = () => {
    const next = runtime.effort === "低" ? "中" : runtime.effort === "中" ? "高" : "低";
    onEffortChange(next);
  };
  const matchingCommands = prompt.startsWith("/")
    ? commands.filter((command) => command.startsWith(prompt.trim())).slice(0, 8)
    : [];

  return (
    <div className="composer-dock">
      <div className={`composer ${running ? "running" : ""}`}>
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
            {attachments.map((attachment) => (
              <span key={attachment.path}><Paperclip size={12} /><span>{attachment.name}</span><button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => onRemoveAttachment(attachment.path)}><X size={12} /></button></span>
            ))}
          </div>
        ) : null}
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={running ? "Cleo 正在执行任务…" : "描述你想完成的事情"}
          disabled={running}
          data-testid="composer-input"
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <button type="button" aria-label="添加附件" title="添加附件" onClick={onPickAttachments}> 
              <Paperclip size={16} />
            </button>
            <button type="button" aria-label="添加上下文" title="查看已附加上下文" onClick={onShowContext}> 
              <AtSign size={16} />
            </button>
            <span className="composer-divider" />
            <div className="model-menu-wrap">
              <button className="text-control" type="button" disabled={runtime.editable === false} onClick={() => setModelMenuOpen((open) => !open)}>
                <span>{runtime.model}</span>
                <ChevronDown size={13} />
              </button>
              {modelMenuOpen ? (
                <div className="model-menu surface-popover">
                  {(runtime.models?.length ? runtime.models : [runtime.model]).map((model) => (
                    <button
                      type="button"
                      key={model}
                      onClick={() => {
                        onModelChange(model);
                        setModelMenuOpen(false);
                      }}
                    >
                      <span>{model}</span>
                      {runtime.model === model ? <Check size={14} /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button className="text-control" type="button" disabled={runtime.editable === false} onClick={cycleEffort} title="切换推理强度">
              {runtime.effort}推理
            </button>
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
              disabled={!prompt.trim()}
              onClick={submit}
              data-testid="send-button"
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="composer-hint">Enter 发送 · Shift Enter 换行 · 内容仅保存在本地</div>
    </div>
  );
}
