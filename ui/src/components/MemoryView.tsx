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
  MoonStar,
  Search,
  ShieldCheck,
} from "lucide-react";
import type {
  MemoryOverview,
  MemoryOverviewEntry,
  MemoryReviewAction,
  MemoryReviewSource,
  MemoryViewMode,
} from "../types";

interface MemoryViewProps {
  overview: MemoryOverview;
  mode: MemoryViewMode;
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

export function MemoryView({ overview, mode, onReviewSource }: MemoryViewProps) {
  const { summary, gate, dream_agent: dreamAgent } = overview;
  const [query, setQuery] = useState("");
  const [projectKey, setProjectKey] = useState("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
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
  onReview,
}: {
  sources: MemoryReviewSource[];
  reviewingId: string | null;
  error: string | null;
  onReview: (source: MemoryReviewSource, action: MemoryReviewAction) => Promise<void>;
}) {
  return (
    <section className="memory-list-section memory-review-section">
      <div className="memory-list-heading"><div><CircleAlert size={16} /><span>待处理来源</span></div><small>{sources.length} 个</small></div>
      {error ? <div className="memory-review-error" role="alert"><CircleAlert size={14} />{error}</div> : null}
      <div className="memory-review-list" data-testid="memory-review-list">
        {sources.length ? sources.map((source) => {
          const busy = reviewingId === source.id;
          return (
            <article key={source.id} data-status={source.status}>
              <span className="memory-review-icon">{source.status === "failed" ? <CircleAlert size={16} /> : <FolderGit2 size={16} />}</span>
              <div className="memory-review-copy">
                <div><strong>{source.project}</strong><span>{source.status === "failed" ? "整理失败" : "等待确认"}</span></div>
                <p>{source.status === "failed" && source.last_error ? source.last_error : `Session 已更新至第 ${source.source_version} 版，共 ${source.last_event_seq} 个事件。`}</p>
                <footer><code>{source.session_id}</code><span>{spaceLabel(source.space)}</span><time>{formatRelativeTime(source.updated_at)}</time></footer>
              </div>
              <div className="memory-review-actions">
                <button type="button" className="secondary" disabled={busy || reviewingId !== null} onClick={() => void onReview(source, "skip")}>
                  <ArchiveX size={14} />忽略本次
                </button>
                <button type="button" className="primary" disabled={busy || reviewingId !== null} onClick={() => void onReview(source, "consolidate")} data-testid="memory-review-confirm">
                  <CheckCircle2 size={14} />{busy ? "正在整理…" : source.status === "failed" ? "重新整理" : "确认并整理"}
                </button>
              </div>
            </article>
          );
        }) : <EmptyMemoryState icon="review" />}
      </div>
    </section>
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
