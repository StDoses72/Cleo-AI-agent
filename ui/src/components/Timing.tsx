import { useState } from "react";
import { cleoClient } from "../services/cleoClient";
import type { TimingSummary } from "../types";
import { useAutomaticRead } from "../useAutomaticRead";

export function duration(ms: number) {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`;
}

const statusText: Record<TimingSummary["status"], string> = {
  running: "进行中", completed: "已完成", failed: "失败", cancelled: "已取消",
  unconfirmed: "记录未更新", skipped: "无需整理", needs_clarification: "待澄清", pending: "有新内容待整理",
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
  if (!summary) return <span className="timing-unrecorded">{error || "耗时未记录"}</span>;
  return <details className="timing" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{running ? `${summary.phase || "正在处理"} · ` : "耗时 "}{duration(summary.elapsedMs)}
      {summary.status !== "completed" && !running && <span> · {statusText[summary.status]}</span>}
    </summary>
    <section ref={read.root} className="timing-detail">
      {read.error && <p role="alert">{read.error} <button onClick={() => void read.retry()}>重试</button></p>}
      {!details && read.pending && <p role="status">正在读取…</p>}
      {details && <>
        {details.attempts.length > 1 && <label className="timing-attempt">查看尝试
          <select aria-label="查看计时尝试" value={identifier} onChange={event => setSelected(event.target.value)}>
            {details.attempts.map((attempt, index) => <option value={attempt.id} key={attempt.id}>
              第 {index + 1} 次 · {new Date(attempt.createdAt).toLocaleString()} · {statusText[attempt.status]}
            </option>)}
          </select>
        </label>}
        <p className="timing-total">本次 {duration(details.elapsedMs)} · {statusText[details.status]}</p>
        <ol className="timing-stages">
          {details.spans.map(span => <li key={span.id} data-nested={Boolean(span.parentId)}>
            <span>{span.label}{span.id === slowest?.id && <small>最慢</small>}</span>
            <span>{duration(span.elapsedMs)}{span.status !== "completed" && ` · ${statusText[span.status]}`}</span>
          </li>)}
        </ol>
        <p>阶段可能重叠，总时长独立计量。{details.unavailable.length > 0 && `${details.unavailable.join("、")}不可用。`}</p>
        {details.attempts.length > 1 && <p>{details.kind === "dream" ? "此会话各次整理" : "此回复各次尝试"}
          耗时之和 {duration(details.accumulatedMs)}，不含尝试之间的暂停时间。</p>}
        {details.status === "unconfirmed" && <p>显示最后一次实测值，未计入失联或应用关闭期间。</p>}
      </>}
      {summary.persistenceError && <p role="alert">{summary.persistenceError}</p>}
    </section>
  </details>;
}
