import { t as tr } from "../../electron/i18n.mjs";
import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { HarnessUsage, HarnessUsageWindow, Usage } from "../types";
import { useDismiss } from "./useDismiss";
import "./context-meter.css";

type Reported = Usage & { used: number };

const reported = (usage?: Usage): usage is Reported => usage != null && usage.used != null && usage.limit > 0;

/** 41818 reads "41.8k"; a window in the millions reads "1.00M". */
const compact = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M`
  : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);

const filled = (usage: Reported) => Math.max(0, Math.min(1, usage.used / usage.limit));

/** Each harness's latest reading, shown at once the next time a panel opens while a fresh one is read. */
const lastRead = new Map<string, HarnessUsageWindow[]>();

const two = (value: number) => String(value).padStart(2, "0");

/** A usage window's name from its length: "5 小时", "本周", "30 天"; a narrower window adds what it is for. */
function windowLabel(window: HarnessUsageWindow) {
  const minutes = window.minutes ?? 0;
  const length = minutes === 10_080 ? tr("contextmeter.week")
    : minutes >= 1440 && minutes % 1440 === 0 ? tr("contextmeter.days", { p0: minutes / 1440 })
      : tr("contextmeter.hours", { p0: Math.round(minutes / 6) / 10 });
  return window.scope ? `${length} · ${window.scope}` : length;
}

/** When a window starts over: the time today, the date and time otherwise. */
function resetTime(resetsAt: number, now: number) {
  const at = new Date(resetsAt * 1000);
  const time = `${two(at.getHours())}:${two(at.getMinutes())}`;
  return at.toDateString() === new Date(now).toDateString() ? time : `${at.getMonth() + 1}/${at.getDate()} ${time}`;
}

/** Purpose: What the ring opens: the context window, then how much of its plan the harness's account has used.
 * Input: the latest reported occupancy and the account's usage windows. Output: used against capacity, and one
 * row per window that has a known length and has not reset yet; no usage section without such a row. */
export function ContextPanel({ usage, windows = [], reading = false, now = Date.now() }: {
  usage: Reported;
  windows?: HarnessUsageWindow[];
  reading?: boolean;
  now?: number;
}) {
  const rows = windows.filter((window) => window.minutes != null && window.minutes > 0
    && (window.resetsAt == null || window.resetsAt * 1000 > now));
  return (
    <>
      <div className="context-meter-head">
        <strong>{tr("inspector.context")}</strong>
        <span>{compact(usage.used)} / {compact(usage.limit)}</span>
      </div>
      <div className="context-meter-track"><span style={{ width: `${filled(usage) * 100}%` }} /></div>
      {rows.length || reading ? (
        <div className="context-meter-section" data-testid="context-usage" aria-busy={reading && !rows.length}>
          <strong>{tr("contextmeter.usage")}{reading && !rows.length ? <LoaderCircle className="spin" size={12} /> : null}</strong>
          <dl className="context-meter-rows">
            {rows.map((window, index) => (
              <div key={`${window.minutes}:${window.scope ?? ""}:${index}`}>
                <dt>{windowLabel(window)}</dt>
                <dd>
                  {window.resetsAt != null ? <small>{tr("contextmeter.resets", { p0: resetTime(window.resetsAt, now) })}</small> : null}
                  <span>{window.percent}%</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </>
  );
}

/** Purpose: How full the model's context window is: a ring beside the send button that opens its own panel.
 * Input: the task's latest reported occupancy; for a development task, its harness and how to read that
 * harness's account usage, asked each time the panel opens. Output: the ring and, while open, the panel;
 * nothing when the harness reported no occupancy or the capacity is unknown. */
export function ContextMeter({ usage, provider, onLoadUsage }: {
  usage?: Usage;
  provider?: string;
  onLoadUsage?: (provider: string) => Promise<HarnessUsage>;
}) {
  const [open, setOpen] = useState(false);
  // What the open panel lists, and whether a first reading has been pending long enough to say so.
  const [read, setRead] = useState<{ provider: string; windows: HarnessUsageWindow[] } | null>(null);
  const [reading, setReading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const loadRef = useRef(onLoadUsage);
  loadRef.current = onLoadUsage;
  const shown = reported(usage);
  useDismiss(open, () => setOpen(false), wrapRef, triggerRef);
  // A ring that comes back after its numbers went away starts closed.
  useEffect(() => { if (!shown) setOpen(false); }, [shown]);
  useEffect(() => {
    if (!open || !provider || !loadRef.current) return;
    let current = true;
    const known = lastRead.get(provider);
    setRead(known ? { provider, windows: known } : null);
    // A harness without a reading answers at once; only a real wait is shown as one.
    const waiting = known ? null : window.setTimeout(() => { if (current) setReading(true); }, 400);
    const settle = (windows: HarnessUsageWindow[]) => {
      if (waiting != null) window.clearTimeout(waiting);
      if (!current) return;
      lastRead.set(provider, windows);
      setRead({ provider, windows });
      setReading(false);
    };
    loadRef.current(provider).then((result) => settle(result?.windows ?? []), () => settle(known ?? []));
    return () => {
      current = false;
      if (waiting != null) window.clearTimeout(waiting);
      setReading(false);
    };
  }, [open, provider]);
  if (!shown) return null;
  const ratio = filled(usage);
  const percent = Math.round(ratio * 100);
  const circumference = 2 * Math.PI * 7;
  const label = tr("conversation.context_used_value", { p0: percent });
  return (
    <div className={`context-meter ${percent >= 85 ? "high" : ""}`} ref={wrapRef}>
      <button ref={triggerRef} type="button" className="context-ring" data-testid="context-ring"
        aria-haspopup="dialog" aria-expanded={open} aria-label={label} title={open ? undefined : label}
        onClick={() => setOpen((value) => !value)}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r="7" fill="none" strokeWidth="2" className="context-ring-track" />
          <circle cx="9" cy="9" r="7" fill="none" strokeWidth="2" className="context-ring-value"
            strokeDasharray={`${circumference * ratio} ${circumference}`} transform="rotate(-90 9 9)" strokeLinecap="round" />
        </svg>
        <span>{percent}%</span>
      </button>
      {open ? (
        <div className="context-meter-panel surface-popover" role="dialog" aria-label={tr("inspector.context")} data-testid="context-panel">
          <ContextPanel usage={usage} windows={read && read.provider === provider ? read.windows : []} reading={reading} />
        </div>
      ) : null}
    </div>
  );
}
