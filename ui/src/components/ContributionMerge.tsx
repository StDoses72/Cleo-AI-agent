import { useAutomaticRead } from "../useAutomaticRead";

export interface MergeReport {
  url?: string; state?: string; targetBranch: string; headBranch?: string;
  headSha: string; baseSha: string; compatible?: boolean; conflicts?: string[];
  mergeable?: string; mergeStateStatus?: string; canUpdate?: boolean; permissionError?: string; probeError?: string; checkedAt: string;
  checks?: { name?: string; context?: string; status?: string; conclusion?: string; state?: string; detailsUrl?: string }[];
  snapshotFormat?: string; fileCount?: number;
}
interface Props {
  params: Record<string, unknown>; busy: boolean;
  revision?: string;
  onAction: (action: string, params?: Record<string, unknown>) => void | Promise<unknown>;
}

/** Purpose: Show fresh merge evidence and an explicit repair handoff. Input: PR or selected target. Output: inspect/repair controls. */
export function ContributionMerge({ params, busy, onAction, revision = "" }: Props) {
  const check = useAutomaticRead(JSON.stringify([params, revision]), !busy, async () => {
    const value = await onAction(params.url ? "mergeAssistance" : "checkContribution", params);
    if (!value || typeof value !== "object" || !("baseSha" in value)) throw new Error("未能读取检查结果，请重试。");
    return value as MergeReport;
  });
  const report = check.data;
  const conclusions = report?.checks?.map(item => item.conclusion || item.state || item.status || "UNKNOWN") ?? [];
  const failed = conclusions.some(value => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(value));
  const checking = conclusions.some(value => ["PENDING", "IN_PROGRESS", "QUEUED", "WAITING", "REQUESTED"].includes(value));
  const checksLabel = failed ? "检查未通过" : checking ? "检查进行中" : conclusions.length && conclusions.every(value => value === "SUCCESS") ? "检查通过" : "检查结果待确认";
  const closed = report?.state === "MERGED" || report?.state === "CLOSED";
  const needsRepair = report?.state === "OPEN" && (report.compatible === false || failed || report.probeError);
  return <section ref={check.root} className="contribution-check" aria-label={params.url ? "PR 合并辅助" : "提交兼容性"}>
    {check.pending && !report && <p role="status">正在读取{params.url ? " PR 状态" : "提交条件"}…</p>}
    {check.error && <p role="alert">{check.error} <button type="button" disabled={busy || check.pending} onClick={() => void check.retry()}>重试</button></p>}
    {report && <div role="status">
      <p>{report.state === "MERGED" ? "已合并" : report.state === "CLOSED" ? "已关闭" : report.snapshotFormat === "empty-target-snapshot-v1" ? "可以向此分支提交" : report.compatible === true ? "无文本冲突" : report.compatible === false ? "存在合并冲突" : "合并条件待确认"}
        {report.url && !closed && ` · ${checksLabel}`}</p>
      {report.probeError && <p role="alert">{report.probeError}</p>}
      {Boolean(report.conflicts?.length) && <ul>{report.conflicts?.map((path) => <li key={path}><code>{path}</code></li>)}</ul>}
      {report.url && <p><a href={`${report.url}/files`} target="_blank" rel="noreferrer">查看具体差异</a> · <a href={`${report.url}/checks`} target="_blank" rel="noreferrer">查看检查详情</a></p>}
      {!closed && report.canUpdate === false && <p>没有源仓库写权限，需由作者或维护者更新。</p>}
      {report.url && !closed && report.canUpdate === undefined && <p>写入权限待确认。{report.permissionError}</p>}
      {needsRepair && <button type="button" disabled={busy || check.pending}
        onClick={() => void onAction("repairContribution", params)}>调查并修复原 PR</button>}
      <details><summary>检查详情</summary>
        <p>目标：{report.targetBranch} · {report.baseSha}<br />源：{report.headBranch || "选定版本"} · {report.headSha}</p>
        {report.fileCount !== undefined && <p>提交 {report.fileCount} 个源码文件</p>}
        <small>{new Date(report.checkedAt).toLocaleString()} · 无文本冲突不代表已满足审查要求。</small>
        {report.mergeStateStatus && <p>GitHub 合并状态：{report.mergeStateStatus}</p>}
        {report.checks && (report.checks.length ? <ul>{report.checks.map((item, index) => <li key={index}>{item.name || item.context || "检查"}：{item.conclusion || item.state || item.status || "未知"}</li>)}</ul> : <p>尚无 CI 检查记录。</p>)}
      </details>
    </div>}
  </section>;
}
