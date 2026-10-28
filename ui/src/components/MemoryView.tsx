import { getLanguage, relativeTime } from "../../electron/i18n.mjs";
import { t as tr } from "../../electron/i18n.mjs";
import { useEffect, useMemo, useRef, useState } from "react";
import { dreamStatusLabel } from "../memoryStatus";
import { Timing } from "./Timing";
import {
  ArchiveX,
  Brain,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Database,
  FolderGit2,
  LoaderCircle,
  Search,
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
  refreshError?: string | null;
  refreshing?: boolean;
  onRetryRefresh?: () => void;
  onLoadReviewDetails: (source: MemoryReviewSource) => Promise<MemoryReviewDetails>;
  onReviewSource: (
    source: MemoryReviewSource,
    action: MemoryReviewAction,
  ) => Promise<unknown>;
}

const viewCopy = {
  get all() { return {
    title: tr("app.memory"),
    section: tr("memoryview.recently_updated"),
  }; },
  get projects() { return {
    title: tr("memoryview.project_memories"),
    section: tr("memoryview.project_entries"),
  }; },
  get pending() { return {
    title: tr("evolutioncases.pending_confirmation"),
    section: tr("memoryview.pending_sources"),
  }; },
} as const;

export function MemoryView({
  overview,
  mode,
  refreshError,
  refreshing,
  onRetryRefresh,
  onLoadReviewDetails,
  onReviewSource,
}: MemoryViewProps) {
  const { summary, dream_agent: dreamAgent } = overview;
  const [query, setQuery] = useState("");
  const [projectKey, setProjectKey] = useState("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [expandedReviewId, setExpandedReviewId] = useState<string | null>(null);
  const [reviewDetails, setReviewDetails] = useState<Record<string, MemoryReviewDetails>>({});
  const [reviewDetailsLoadingId, setReviewDetailsLoadingId] = useState<string | null>(null);
  const [reviewDetailsErrors, setReviewDetailsErrors] = useState<Record<string, string>>({});
  const [detailsRetry, setDetailsRetry] = useState(0);
  const reviewingRef = useRef<string | null>(null);
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
      !normalizedQuery || [source.title, source.project, source.session_id, source.last_error, spaceLabel(source.space)]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(normalizedQuery)),
    ),
    [normalizedQuery, overview.review_sources],
  );

  const review = async (source: MemoryReviewSource, action: MemoryReviewAction) => {
    if (reviewingRef.current !== null) return;
    reviewingRef.current = source.id;
    setReviewError(null);
    setReviewingId(source.id);
    setExpandedReviewId((current) => current === source.id ? null : current);
    try {
      await onReviewSource(source, action);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : tr("memoryview.could_not_process_this_memory_source"));
    } finally {
      reviewingRef.current = null;
      setReviewingId((current) => current === source.id ? null : current);
    }
  };

  const toggleReviewSource = (source: MemoryReviewSource) => {
    if (reviewingRef.current === source.id) return;
    setExpandedReviewId(current => current === source.id ? null : source.id);
  };
  const expandedSource = overview.review_sources.find(source => source.id === expandedReviewId);
  useEffect(() => {
    const source = expandedSource;
    if (!source || (reviewDetails[source.id]?.source_version ?? -1) >= source.source_version) return;
    let current = true;
    setReviewDetailsLoadingId(source.id);
    setReviewDetailsErrors((current) => ({ ...current, [source.id]: "" }));
    void onLoadReviewDetails(source).then(details => {
      if (current) setReviewDetails(saved => ({ ...saved, [source.id]: details }));
    }).catch(error => {
      if (current) setReviewDetailsErrors(saved => ({ ...saved,
        [source.id]: error instanceof Error ? error.message : tr("memoryview.could_not_read_the_conversation") }));
    }).finally(() => {
      if (current) setReviewDetailsLoadingId(saved => saved === source.id ? null : saved);
    });
    return () => {
      current = false;
      setReviewDetailsLoadingId((current) => current === source.id ? null : current);
    };
  }, [expandedSource?.id, expandedSource?.source_version, detailsRetry]);

  const dreamStatus = reviewingId ? tr("memoryview.consolidating")
    : reviewError ? tr("memoryview.consolidation_failed") : dreamStatusLabel(dreamAgent);

  return (
    <main className="memory-view" data-testid="memory-view" data-mode={mode}>
      <header className="memory-view-header">
        <div>
          <h2>{copy.title}</h2>
        </div>
        <label className="memory-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={mode === "pending" ? tr("memoryview.search_conversations_or_projects") : tr("memoryview.search_memories")}
            aria-label={mode === "pending" ? tr("memoryview.search_sources_awaiting_confirmation") : tr("memoryview.search_memories")}
          />
        </label>
      </header>

      {refreshError && <div className="memory-review-error" role="alert"><span>{refreshError}</span>
        <button disabled={refreshing} onClick={onRetryRefresh}>{tr("app.retry")}</button></div>}

      {overview.issues?.map((issue) => (
        <p role="status" key={`${issue.space}:${issue.project}`}>
          {issue.project}{tr("punctuation.colon")}{issue.questions?.join(" ") || issue.error}
        </p>
      ))}

      <div className="memory-summary" role="status">
        <span>{tr("memoryview.memory_consolidation")}{dreamStatus}</span>
        {dreamAgent.last_processed_at && <span>{tr("memoryview.last_consolidated")}{formatRelativeTime(dreamAgent.last_processed_at)}</span>}
      </div>

      {(overview.timingError || Boolean(overview.timings?.length)) && <details className="memory-timing-history">
        <summary>{tr("memoryview.consolidation_duration")}</summary>
        {overview.timingError ? <p role="alert">{overview.timingError}</p>
          : overview.timings?.map(timing => <div key={timing.id}>
            <span>{timing.title || timing.sessionId} · {timing.project} · {new Date(timing.createdAt).toLocaleString(getLanguage())}</span>
            <Timing summary={timing} />
          </div>)}
      </details>}

      {mode === "projects" ? (
        <nav className="memory-project-filter" aria-label={tr("memoryview.filter_memory_projects")}>
          <button
            type="button"
            className={projectKey === "all" ? "active" : ""}
            onClick={() => setProjectKey("all")}
          >
            <span>{tr("memoryview.all_projects")}</span><small>{summary.project_memories}</small>
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
          filtered={Boolean(normalizedQuery)}
          reviewingId={reviewingId}
          error={reviewError}
          expandedId={expandedReviewId}
          details={reviewDetails}
          detailsLoadingId={reviewDetailsLoadingId}
          detailsErrors={reviewDetailsErrors}
          onToggle={(source) => void toggleReviewSource(source)}
          onRetryDetails={() => setDetailsRetry(value => value + 1)}
          onReview={review}
        />
      ) : (
        <MemoryLedger
          entries={visibleEntries}
          filtered={Boolean(normalizedQuery) || (mode === "projects" && projectKey !== "all")}
          title={copy.section}
          expandedId={expandedId}
          onToggle={(id) => setExpandedId((current) => current === id ? null : id)}
        />
      )}

    </main>
  );
}

function MemoryLedger({
  entries,
  filtered,
  title,
  expandedId,
  onToggle,
}: {
  entries: MemoryOverviewEntry[];
  filtered: boolean;
  title: string;
  expandedId: string | null;
  onToggle: (id: string) => void;
}) {
  return (
    <section className="memory-list-section">
      <div className="memory-list-heading"><div><Brain size={16} /><span>{title}</span></div><small>{entries.length} {tr("memoryview.entries")}</small></div>
      <div className="memory-list" data-testid="memory-ledger">
        {entries.length ? entries.map((memory) => {
          const expanded = memory.id === expandedId;
          return (
            <article key={memory.id} className={expanded ? "expanded" : ""}>
              <div className={`memory-scope ${memory.scope}`}>
                {memory.scope === "persona" ? tr("memoryview.persona") : categoryLabel(memory.category)}
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
        }) : <EmptyMemoryState icon="memory" filtered={filtered} />}
      </div>
    </section>
  );
}

function MemoryDetails({ memory }: { memory: MemoryOverviewEntry }) {
  if (memory.scope === "project") {
    return (
      <div className="memory-entry-details">
        <small>{tr("memoryview.recent_changes")}</small>
        {memory.history?.length ? memory.history.map((entry) => (
          <p key={entry.commit}>
            <code>{entry.commit.slice(0, 8)}</code> {entry.summary}
            <time>{formatDateTime(entry.created_at)}</time>
          </p>
        )) : <p>{tr("memoryview.no_committed_memory_changes_yet")}</p>}
      </div>
    );
  }
  return (
    <div className="memory-entry-details">
      <dl>
        <div><dt>{tr("memoryview.confidence")}</dt><dd>{Math.round(memory.confidence * 100)}%</dd></div>
        <div><dt>{tr("memoryview.importance")}</dt><dd>{memory.importance} / 5</dd></div>
        <div><dt>{tr("memoryview.evidence")}</dt><dd>{memory.evidence_count} {tr("memoryview.entries")}</dd></div>
      </dl>
      {memory.tags.length ? <div className="memory-tags">{memory.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
    </div>
  );
}

function ReviewQueue({
  sources,
  filtered,
  reviewingId,
  error,
  expandedId,
  details,
  detailsLoadingId,
  detailsErrors,
  onToggle,
  onReview,
  onRetryDetails,
}: {
  sources: MemoryReviewSource[];
  filtered: boolean;
  reviewingId: string | null;
  error: string | null;
  expandedId: string | null;
  details: Record<string, MemoryReviewDetails>;
  detailsLoadingId: string | null;
  detailsErrors: Record<string, string>;
  onToggle: (source: MemoryReviewSource) => void;
  onReview: (source: MemoryReviewSource, action: MemoryReviewAction) => Promise<void>;
  onRetryDetails: () => void;
}) {
  return (
    <section className="memory-list-section memory-review-section">
      <div className="memory-list-heading"><div><CircleAlert size={16} /><span>{tr("memoryview.pending_sources")}</span></div><small>{sources.length} {tr("memoryview.items")}</small></div>
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
                    <span className="memory-review-title"><strong>{source.title || tr("memoryview.conversations_in_value", { p0: source.project })}</strong><span>{source.status === "failed" ? tr("memoryview.consolidation_failed") : tr("memoryview.awaiting_consolidation")}</span></span>
                    {source.status === "failed" && source.last_error && <p>{source.last_error}</p>}
                    <footer><span>{source.project} · {spaceLabel(source.space)}</span><time>{formatRelativeTime(source.updated_at)}</time></footer>
                  </span>
                  <ChevronDown size={15} />
                </button>
              </div>
              <div className="memory-review-actions">
                <button type="button" className="secondary" disabled={busy || reviewingId !== null} onClick={() => void onReview(source, "skip")}>
                  <ArchiveX size={14} />{tr("memoryview.ignore_this_time")}</button>
                <button type="button" className="primary" disabled={busy || reviewingId !== null} onClick={() => void onReview(source, "consolidate")} data-testid="memory-review-confirm">
                  <CheckCircle2 size={14} />{busy ? tr("memoryview.consolidating_2") : source.status === "failed" ? tr("memoryview.continue_consolidation") : tr("memoryview.confirm_and_consolidate")}
                </button>
              </div>
              {expanded ? (
                <MemoryReviewDetailsPanel
                  details={(details[source.id]?.source_version ?? -1) >= source.source_version ? details[source.id] : undefined}
                  loading={detailsLoadingId === source.id}
                  error={detailsErrors[source.id]}
                  onRetry={onRetryDetails}
                />
              ) : null}
            </article>
          );
        }) : <EmptyMemoryState icon="review" filtered={filtered} />}
      </div>
    </section>
  );
}

function MemoryReviewDetailsPanel({
  details,
  loading,
  error,
  onRetry,
}: {
  details?: MemoryReviewDetails;
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  if (loading) {
    return <div className="memory-review-details-status"><LoaderCircle className="spin" size={14} />{tr("memoryview.loading_conversation")}</div>;
  }
  if (error) {
    return <div className="memory-review-details-status error" role="alert"><CircleAlert size={14} />{error}<button onClick={onRetry}>{tr("app.retry")}</button></div>;
  }
  if (!details) return null;
  return (
    <div className="memory-review-details">
      <header>
        <strong>{tr("memoryview.conversation_content")}</strong>
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
                {event.created_at ? <time>{formatDateTime(event.created_at)}</time> : null}
              </header>
              {content ? typeof event.content === "string" && ["human", "ai"].includes(event.type)
                ? <p className="memory-review-text">{content}</p> : <pre>{content}</pre> : null}
              {metadata ? <details><summary>{tr("memoryview.technical_details")}</summary><pre className="metadata">{metadata}</pre></details> : null}
            </div>
          );
        }) : <p>{tr("memoryview.no_content_available_to_consolidate")}</p>}
      </div>
      {details.omitted_events.length ? (
        <details className="memory-review-omitted">
          <summary>{tr("memoryview.other_records")}</summary>
          {details.omitted_events.map((event) => (
            <div key={event.id}>
              <code>#{event.seq}</code>
              <strong>{event.type}</strong>
              <span>{event.actor}</span>
              {event.created_at ? <time>{formatDateTime(event.created_at)}</time> : null}
            </div>
          ))}
        </details>
      ) : null}
    </div>
  );
}

function EmptyMemoryState({ icon, filtered }: { icon: "memory" | "review"; filtered: boolean }) {
  return (
    <div className="memory-empty-state">
      {icon === "review" ? <CheckCircle2 size={20} /> : <Database size={20} />}
      <strong>{icon === "review" ? filtered ? tr("memoryview.no_matching_conversations") : tr("memoryview.no_sources_awaiting_confirmation") : filtered ? tr("memoryview.no_matching_memories") : tr("memoryview.no_memories_yet")}</strong>
    </div>
  );
}

function categoryLabel(category: string) {
  return {
    fact: tr("memoryview.fact"),
    decision: tr("memoryview.decision"),
    constraint: tr("memoryview.constraint"),
    correction: tr("memoryview.correction"),
    preference: tr("memoryview.preference"),
    action: tr("memoryview.action"),
    pattern: tr("memoryview.pattern"),
    artifact: tr("memoryview.artifact"),
    question: tr("memoryview.issue"),
  }[category] ?? tr("memoryview.project");
}

function reviewEventLabel(type: string, metadata: Record<string, unknown>) {
  if (type === "human") return tr("memoryview.user_message");
  if (type === "ai") return tr("memoryview.assistant_message");
  if (type === "tool_event") {
    const name = typeof metadata.name === "string" ? metadata.name : tr("memoryview.tool_call");
    return tr("memoryview.tool_value", { p0: name });
  }
  return type.replaceAll("_", " ");
}

function formatReviewValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function spaceLabel(space: MemoryOverviewEntry["space"] | MemoryReviewSource["space"]) {
  return space === "productivity" ? tr("memoryview.development_space") : space === "non_productivity" ? tr("memoryview.chat_space") : tr("memoryview.global");
}

function formatRelativeTime(value: string | null) {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "—";
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return tr("memoryview.just_now");
  if (elapsedMinutes < 60) return getLanguage() === "en" ? relativeTime(elapsedMinutes, "minute") : tr("memoryview.value_minutes_ago", { p0: elapsedMinutes });
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return getLanguage() === "en" ? relativeTime(elapsedHours, "hour") : tr("memoryview.value_hours_ago", { p0: elapsedHours });
  return getLanguage() === "en" ? relativeTime(Math.floor(elapsedHours / 24), "day") : tr("memoryview.value_days_ago", { p0: Math.floor(elapsedHours / 24) });
}

function formatDateTime(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "—";
  return new Intl.DateTimeFormat(getLanguage(), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}
