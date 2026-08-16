import { useMemo, useState } from "react";
import {
  ArchiveX,
  Brain,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  Cpu,
  Database,
  Fingerprint,
  FolderGit2,
  LoaderCircle,
  MoonStar,
  Search,
  ShieldCheck,
} from "lucide-react";
import type {
  MemoryOverview,
  MemoryOverviewEntry,
  MemoryReviewAction,
  MemoryReviewDetails,
  MemoryReviewSource,
  MemoryViewMode,
} from "../types";

interface MemoryViewProps {
  overview: MemoryOverview;
  mode: MemoryViewMode;
  onLoadReviewDetails: (source: MemoryReviewSource) => Promise<MemoryReviewDetails>;
  onReviewSource: (
    source: MemoryReviewSource,
    action: MemoryReviewAction,
  ) => Promise<unknown>;
}

const viewCopy = {
  all: {
    eyebrow: "DURABLE CONTEXT",
    title: "记忆",
    description: "可追溯、按作用域隔离，并由 DreamAgent 在后台整理。",
    section: "最近更新",
  },
  projects: {
    eyebrow: "PROJECT LEDGER",
    title: "项目记忆",
    description: "只显示项目事实、决策与约束；每条都可以回到原始 session 证据。",
    section: "项目条目",
  },
  pending: {
    eyebrow: "REVIEW QUEUE",
    title: "待确认",
    description: "检查等待整理或整理失败的 session 来源，再决定交给 DreamAgent 或忽略本次。",
    section: "待处理来源",
  },
} as const;

export function MemoryView({
  overview,
  mode,
  onLoadReviewDetails,
  onReviewSource,
}: MemoryViewProps) {
  const { summary, gate, dream_agent: dreamAgent } = overview;
  const [query, setQuery] = useState("");
  const [projectKey, setProjectKey] = useState("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [expandedReviewId, setExpandedReviewId] = useState<string | null>(null);
  const [reviewDetails, setReviewDetails] = useState<Record<string, MemoryReviewDetails>>({});
  const [reviewDetailsLoadingId, setReviewDetailsLoadingId] = useState<string | null>(null);
  const [reviewDetailsErrors, setReviewDetailsErrors] = useState<Record<string, string>>({});
  const copy = viewCopy[mode];
  const normalizedQuery = query.trim().toLocaleLowerCase();

  const visibleEntries = useMemo(() => {
    const entries = mode === "projects"
      ? overview.entries.filter((entry) => entry.scope === "project")
      : overview.entries;
    return entries.filter((entry) => {
      const key = entry.space && entry.project ? `${entry.space}:${entry.project}` : "persona";
      if (mode === "projects" && projectKey !== "all" && key !== projectKey) return false;
      return !normalizedQuery || [entry.title, entry.content, entry.category, entry.project, ...entry.tags]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [mode, normalizedQuery, overview.entries, projectKey]);

  const visibleReviewSources = useMemo(
    () => overview.review_sources.filter((source) =>
      !normalizedQuery || [source.project, source.session_id, source.last_error, spaceLabel(source.space)]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(normalizedQuery)),
    ),
    [normalizedQuery, overview.review_sources],
  );

  const review = async (source: MemoryReviewSource, action: MemoryReviewAction) => {
    setReviewError(null);
    setReviewingId(source.id);
    try {
      await onReviewSource(source, action);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "无法处理这个记忆来源");
    } finally {
      setReviewingId(null);
    }
  };

  const toggleReviewSource = async (source: MemoryReviewSource) => {
    if (expandedReviewId === source.id) {
      setExpandedReviewId(null);
      return;
    }
    setExpandedReviewId(source.id);
    if (reviewDetails[source.id] || reviewDetailsLoadingId === source.id) return;
    setReviewDetailsLoadingId(source.id);
    setReviewDetailsErrors((current) => ({ ...current, [source.id]: "" }));
    try {
      const details = await onLoadReviewDetails(source);
      setReviewDetails((current) => ({ ...current, [source.id]: details }));
    } catch (error) {
      setReviewDetailsErrors((current) => ({
        ...current,
        [source.id]: error instanceof Error ? error.message : "无法读取这个 session 的内容",
      }));
    } finally {
      setReviewDetailsLoadingId((current) => current === source.id ? null : current);
    }
  };

  const dreamStatus =
    dreamAgent.status === "attention"
      ? "需要留意"
      : dreamAgent.status === "running"
        ? "正在整理"
        : "运行正常";

  return (
    <main className="memory-view" data-testid="memory-view" data-mode={mode}>
      <header className="memory-view-header">
        <div>
          <span className="eyebrow">{copy.eyebrow}</span>
          <h2>{copy.title}</h2>
          <p>{copy.description}</p>
        </div>
        <label className="memory-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={mode === "pending" ? "搜索项目或 session" : "搜索记忆"}
            aria-label={mode === "pending" ? "搜索待确认来源" : "搜索记忆"}
          />
        </label>
      </header>

      <div className="memory-overview">
        <div><Database size={17} /><span><strong>{summary.active_memories}</strong><small>活跃记忆</small></span></div>
        <div><ShieldCheck size={17} /><span><strong>{summary.project_scopes}</strong><small>项目作用域</small></span></div>
        <div><Fingerprint size={17} /><span><strong>{summary.persona_traits}</strong><small>人格倾向</small></span></div>
        <div><Clock3 size={17} /><span><strong>{formatRelativeTime(dreamAgent.last_processed_at)}</strong><small>上次整理</small></span></div>
      </div>

      <section className="memory-model-line" aria-label="语义记忆筛选模型">
        <span className="memory-model-icon"><Cpu size={16} /></span>
        <div><small>SEMANTIC MEMORY GATE</small><strong>Sentence Transformer</strong></div>
        <code>{gate.model}</code>
        <span className={gate.enabled ? "status-good" : "status-muted"}>{gate.enabled ? "已启用" : "未启用"}</span>
      </section>

      {mode === "projects" ? (
        <nav className="memory-project-filter" aria-label="筛选记忆项目">
          <button
            type="button"
            className={projectKey === "all" ? "active" : ""}
            onClick={() => setProjectKey("all")}
          >
            <span>全部项目</span><small>{summary.project_memories}</small>
          </button>
          {overview.project_summaries.map((project) => {
            const key = `${project.space}:${project.project}`;
            return (
              <button
                type="button"
                key={key}
                className={projectKey === key ? "active" : ""}
                onClick={() => setProjectKey(key)}
              >
                <span>{project.project}</span>
                <small>{spaceLabel(project.space)} · {project.memory_count}</small>
              </button>
            );
          })}
        </nav>
      ) : null}

      {mode === "pending" ? (
        <ReviewQueue
          sources={visibleReviewSources}
          reviewingId={reviewingId}
          error={reviewError}
          expandedId={expandedReviewId}
          details={reviewDetails}
          detailsLoadingId={reviewDetailsLoadingId}
          detailsErrors={reviewDetailsErrors}
          onToggle={(source) => void toggleReviewSource(source)}
          onReview={review}
        />
      ) : (
        <MemoryLedger
          entries={visibleEntries}
          title={copy.section}
          expandedId={expandedId}
          onToggle={(id) => setExpandedId((current) => current === id ? null : id)}
        />
      )}

      <aside className="dream-strip">
        <span className="dream-visual"><MoonStar size={18} /></span>
        <div>
          <strong>{dreamAgent.status === "running" ? "DreamAgent 正在整理记忆" : "DreamAgent 已完成最近一次整理"}</strong>
          <p>{dreamAgent.failed_count ? `${dreamAgent.failed_count} 个来源整理失败，需要检查。` : dreamAgent.pending_count ? `${dreamAgent.pending_count} 个来源等待确认。` : "当前没有等待处理的记忆来源。"}</p>
        </div>
        <small data-status={dreamAgent.status}>{dreamStatus}</small>
      </aside>
    </main>
  );
}

function MemoryLedger({
  entries,
  title,
  expandedId,
  onToggle,
}: {
  entries: MemoryOverviewEntry[];
  title: string;
  expandedId: string | null;
  onToggle: (id: string) => void;
}) {
  return (
    <section className="memory-list-section">
      <div className="memory-list-heading"><div><Brain size={16} /><span>{title}</span></div><small>{entries.length} 条</small></div>
      <div className="memory-list" data-testid="memory-ledger">
        {entries.length ? entries.map((memory) => {
          const expanded = memory.id === expandedId;
          return (
            <article key={memory.id} className={expanded ? "expanded" : ""}>
              <div className={`memory-scope ${memory.scope}`}>
                {memory.scope === "persona" ? "人格" : categoryLabel(memory.category)}
              </div>
              <div className="memory-copy">
                <button type="button" className="memory-entry-toggle" onClick={() => onToggle(memory.id)} aria-expanded={expanded}>
                  <span><h3>{memory.title}</h3><p>{memory.content}</p></span>
                  <ChevronDown size={15} />
                </button>
                <footer>
                  <span>{memory.scope === "persona" ? "PERSONA.md" : `${spaceLabel(memory.space)} / ${memory.project}`}</span>
                  <time>{formatRelativeTime(memory.updated_at)}</time>
                </footer>
                {expanded ? <MemoryDetails memory={memory} /> : null}
              </div>
            </article>
          );
        }) : <EmptyMemoryState icon="memory" />}
      </div>
    </section>
  );
}

function MemoryDetails({ memory }: { memory: MemoryOverviewEntry }) {
  return (
    <div className="memory-entry-details">
      <dl>
        <div><dt>置信度</dt><dd>{Math.round(memory.confidence * 100)}%</dd></div>
        <div><dt>重要性</dt><dd>{memory.importance} / 5</dd></div>
        <div><dt>证据</dt><dd>{memory.evidence_count} 条</dd></div>
      </dl>
      {memory.tags.length ? <div className="memory-tags">{memory.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
      {memory.scope === "project" ? (
        <div className="memory-evidence-list">
          <small>原始证据</small>
          {memory.evidence.length ? memory.evidence.map((evidence) => (
            <div key={`${evidence.session_id}:${evidence.event_id}`}>
              <code>{evidence.event_id}</code>
              <span>{evidence.session_id}</span>
              <time>{formatDateTime(evidence.observed_at)}</time>
            </div>
          )) : <p>这条旧记忆没有可显示的证据索引。</p>}
        </div>
      ) : null}
    </div>
  );
}

function ReviewQueue({
  sources,
  reviewingId,
  error,
  expandedId,
  details,
  detailsLoadingId,
  detailsErrors,
  onToggle,
  onReview,
}: {
  sources: MemoryReviewSource[];
  reviewingId: string | null;
  error: string | null;
  expandedId: string | null;
  details: Record<string, MemoryReviewDetails>;
  detailsLoadingId: string | null;
  detailsErrors: Record<string, string>;
  onToggle: (source: MemoryReviewSource) => void;
  onReview: (source: MemoryReviewSource, action: MemoryReviewAction) => Promise<void>;
}) {
  return (
    <section className="memory-list-section memory-review-section">
      <div className="memory-list-heading"><div><CircleAlert size={16} /><span>待处理来源</span></div><small>{sources.length} 个</small></div>
      {error ? <div className="memory-review-error" role="alert"><CircleAlert size={14} />{error}</div> : null}
      <div className="memory-review-list" data-testid="memory-review-list">
        {sources.length ? sources.map((source) => {
          const busy = reviewingId === source.id;
          const expanded = expandedId === source.id;
          return (
            <article key={source.id} data-status={source.status} className={expanded ? "expanded" : ""}>
              <span className="memory-review-icon">{source.status === "failed" ? <CircleAlert size={16} /> : <FolderGit2 size={16} />}</span>
              <div className="memory-review-copy">
                <button type="button" className="memory-review-toggle" onClick={() => onToggle(source)} aria-expanded={expanded}>
                  <span className="memory-review-summary">
                    <span className="memory-review-title"><strong>{source.project}</strong><span>{source.status === "failed" ? "整理失败" : "等待确认"}</span></span>
                    <p>{source.status === "failed" && source.last_error ? source.last_error : `Session 已更新至第 ${source.source_version} 版，共 ${source.last_event_seq} 个事件。`}</p>
                    <footer><code>{source.session_id}</code><span>{spaceLabel(source.space)}</span><time>{formatRelativeTime(source.updated_at)}</time></footer>
                  </span>
                  <ChevronDown size={15} />
                </button>
              </div>
              <div className="memory-review-actions">
                <button type="button" className="secondary" disabled={busy || reviewingId !== null} onClick={() => void onReview(source, "skip")}>
                  <ArchiveX size={14} />忽略本次
                </button>
                <button type="button" className="primary" disabled={busy || reviewingId !== null} onClick={() => void onReview(source, "consolidate")} data-testid="memory-review-confirm">
                  <CheckCircle2 size={14} />{busy ? "正在整理…" : source.status === "failed" ? "重新整理" : "确认并整理"}
                </button>
              </div>
              {expanded ? (
                <MemoryReviewDetailsPanel
                  details={details[source.id]}
                  loading={detailsLoadingId === source.id}
                  error={detailsErrors[source.id]}
                />
              ) : null}
            </article>
          );
        }) : <EmptyMemoryState icon="review" />}
      </div>
    </section>
  );
}

function MemoryReviewDetailsPanel({
  details,
  loading,
  error,
}: {
  details?: MemoryReviewDetails;
  loading: boolean;
  error?: string;
}) {
  if (loading) {
    return <div className="memory-review-details-status"><LoaderCircle className="spin" size={14} />正在读取 session 内容…</div>;
  }
  if (error) {
    return <div className="memory-review-details-status error"><CircleAlert size={14} />{error}</div>;
  }
  if (!details) return null;
  return (
    <div className="memory-review-details">
      <header>
        <strong>DreamAgent 输入预览</strong>
        <span>第 {details.source_version} 版 · 源事件 {details.event_count} 个 · 整理内容 {details.events.length} 项</span>
      </header>
      <div className="memory-review-events">
        {details.events.length ? details.events.map((event) => {
          const content = formatReviewValue(event.content);
          const metadata = Object.keys(event.metadata).length
            ? formatReviewValue(event.metadata)
            : "";
          return (
            <div className="memory-review-event" key={event.id}>
              <header>
                <strong>{reviewEventLabel(event.type, event.metadata)}</strong>
                <code>{event.type}</code>
                {event.created_at ? <time>{formatDateTime(event.created_at)}</time> : null}
              </header>
              {content ? <pre>{content}</pre> : null}
              {metadata ? <pre className="metadata">{metadata}</pre> : null}
            </div>
          );
        }) : <p>这次来源没有可供 DreamAgent 读取的内容事件。</p>}
      </div>
      {details.omitted_events.length ? (
        <div className="memory-review-omitted">
          <small>未进入整理内容的生命周期事件</small>
          {details.omitted_events.map((event) => (
            <div key={event.id}>
              <code>#{event.seq}</code>
              <strong>{event.type}</strong>
              <span>{event.actor}</span>
              {event.created_at ? <time>{formatDateTime(event.created_at)}</time> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EmptyMemoryState({ icon }: { icon: "memory" | "review" }) {
  return (
    <div className="memory-empty-state">
      {icon === "review" ? <CheckCircle2 size={20} /> : <Database size={20} />}
      <strong>{icon === "review" ? "没有待确认来源" : "没有匹配的记忆"}</strong>
      <span>{icon === "review" ? "DreamAgent 的整理队列目前是干净的。" : "试试其他关键词或项目。"}</span>
    </div>
  );
}

function categoryLabel(category: string) {
  return {
    fact: "事实",
    decision: "决策",
    constraint: "约束",
    correction: "修正",
    preference: "偏好",
    action: "行动",
    pattern: "模式",
    artifact: "产物",
    question: "问题",
  }[category] ?? "项目";
}

function reviewEventLabel(type: string, metadata: Record<string, unknown>) {
  if (type === "human") return "用户消息";
  if (type === "ai") return "助手消息";
  if (type === "tool_event") {
    const name = typeof metadata.name === "string" ? metadata.name : "工具调用";
    return `工具 · ${name}`;
  }
  return type.replaceAll("_", " ");
}

function formatReviewValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function spaceLabel(space: MemoryOverviewEntry["space"] | MemoryReviewSource["space"]) {
  return space === "productivity" ? "开发空间" : space === "non_productivity" ? "对话空间" : "全局";
}

function formatRelativeTime(value: string | null) {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "—";
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "刚刚";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  return `${Math.floor(elapsedHours / 24)}d`;
}

function formatDateTime(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}
