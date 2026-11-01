import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { localConfigClient, type TaskUsagePreview } from "../services/localConfigClient";
import { TaskTokenUsage } from "./TaskTokenUsage";

/** Read existing task counters only; this preview has no inference or conversation actions. */
export function LocalTaskUsagePreview() {
  const [data, setData] = useState<TaskUsagePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const reload = async (sessionId?: string) => {
    const current = ++request.current;
    setBusy(true); setError("");
    try {
      const result = await localConfigClient.getTaskUsagePreview(sessionId);
      if (current === request.current) setData(result);
    } catch {
      if (current === request.current) setError("任务用量读取失败，请重新读取。");
    } finally {
      if (current === request.current) setBusy(false);
    }
  };
  useEffect(() => { void reload(); return () => { request.current++; }; }, []);
  return <section className="local-task-usage" aria-label="本地当前任务用量">
    <div className="local-task-toolbar">
      <label>会话<select aria-label="选择本地会话" value={data?.sessionId ?? ""} disabled={busy || !data?.sessions.length}
        onChange={event => void reload(event.target.value)}>
        {!data?.sessions.length && <option value="">暂无任务记录</option>}
        {data?.sessions.map(session => <option key={session.id} value={session.id}>{session.label}</option>)}
      </select></label>
      <button className="settings-action" disabled={busy} onClick={() => void reload(data?.sessionId ?? undefined)}>
        <RefreshCw size={14} />{busy ? "读取中…" : "重新读取"}</button>
    </div>
    {error && <p className="settings-error" role="alert">{error}</p>}
    {data?.usage ? <TaskTokenUsage usage={data.usage} /> : !busy && !error
      ? <p className="muted">暂无已记录的当前任务。请在本地客户端发送需求。</p> : null}
  </section>;
}
