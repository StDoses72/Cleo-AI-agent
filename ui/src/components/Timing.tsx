import { getLanguage } from "../../electron/i18n.mjs";
import { t as tr } from "../../electron/i18n.mjs";
import { useState } from "react";
import { cleoClient } from "../services/cleoClient";
import type { TimingSummary } from "../types";
import { useAutomaticRead } from "../useAutomaticRead";

export function duration(ms: number) {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return tr("timing.value_s", { p0: seconds < 10 ? seconds.toFixed(1) : Math.round(seconds) });
  return tr("timing.value_min_value_s", { p0: Math.floor(seconds / 60), p1: Math.floor(seconds % 60) });
}

const statusText: Record<TimingSummary["status"], string> = {
  get running() { return tr("computerpanel.in_progress"); }, get completed() { return tr("timing.completed"); }, get failed() { return tr("conversation.failed"); }, get cancelled() { return tr("timing.cancelled"); },
  get unconfirmed() { return tr("timing.record_not_updated"); }, get skipped() { return tr("timing.no_consolidation_needed"); }, get needs_clarification() { return tr("timing.needs_clarification"); }, get pending() { return tr("timing.new_content_awaiting_consolidation"); },
};

export function Timing({ summary, error }: { summary?: TimingSummary | null; error?: string | null }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const identifier = selected ?? summary?.id ?? "";
  const running = summary?.status === "running";
  const read = useAutomaticRead(`${identifier}:${summary?.status}`, open && Boolean(identifier),
    () => cleoClient.getTiming(identifier), running ? 2000 : 60000);
  const details = read.data;
  const parentIds = new Set(details?.spans.map(span => span.parentId));
  const slowest = details?.spans.filter(span => !parentIds.has(span.id))
    .reduce<(typeof details.spans)[number] | undefined>((best, span) =>
      !best || span.elapsedMs > best.elapsedMs ? span : best, undefined);
  if (!summary) return error ? <span className="timing-unrecorded">{error}</span> : null;
  return <details className="timing" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{running ? `${summary.phase || tr("timing.processing")} · ` : tr("timing.duration")}{duration(summary.elapsedMs)}
      {summary.status !== "completed" && !running && <span> · {statusText[summary.status]}</span>}
    </summary>
    <section ref={read.root} className="timing-detail">
      {read.error && <p role="alert">{read.error} <button onClick={() => void read.retry()}>{tr("app.retry")}</button></p>}
      {!details && read.pending && <p role="status">{tr("overlays.loading")}</p>}
      {details && <>
        {details.attempts.length > 1 && <label className="timing-attempt">{tr("timing.view_attempts")}<select aria-label={tr("timing.view_timing_attempts")} value={identifier} onChange={event => setSelected(event.target.value)}>
            {details.attempts.map((attempt, index) => <option value={attempt.id} key={attempt.id}>
              {tr("timing.attempt")}{index + 1} {tr("timing.label")}{new Date(attempt.createdAt).toLocaleString(getLanguage())} · {statusText[attempt.status]}
            </option>)}
          </select>
        </label>}
        <p className="timing-total">{tr("timing.this_attempt")}{duration(details.elapsedMs)} · {statusText[details.status]}</p>
        <ol className="timing-stages">
          {details.spans.map(span => <li key={span.id} data-nested={Boolean(span.parentId)}>
            <span>{span.label}{span.id === slowest?.id && <small>{tr("timing.slowest")}</small>}</span>
            <span>{duration(span.elapsedMs)}{span.status !== "completed" && ` · ${statusText[span.status]}`}</span>
          </li>)}
        </ol>
        {details.unavailable.length > 0 && <p>{details.unavailable.join("、")}{tr("timing.unavailable")}</p>}
        {details.attempts.length > 1 && <p>{tr("timing.total")}{duration(details.accumulatedMs)}</p>}
      </>}
      {summary.persistenceError && <p role="alert">{summary.persistenceError}</p>}
    </section>
  </details>;
}
