import { useState } from "react";

export interface MergeReport {
  url?: string; state?: string; targetBranch: string; headBranch?: string;
  headSha: string; baseSha: string; compatible?: boolean; conflicts?: string[];
  mergeable?: string; mergeStateStatus?: string; canUpdate?: boolean; permissionError?: string; probeError?: string; checkedAt: string;
  checks?: { name?: string; context?: string; status?: string; conclusion?: string; state?: string; detailsUrl?: string }[];
  snapshotFormat?: string; fileCount?: number;
}
interface Props {
  params: Record<string, unknown>; busy: boolean;
  onAction: (action: string, params?: Record<string, unknown>) => void | Promise<unknown>;
}

/** Purpose: Show fresh merge evidence and an explicit repair handoff. Input: PR or selected target. Output: inspect/repair controls. */
export function ContributionMerge({ params, busy, onAction }: Props) {
  const [result, setResult] = useState<MergeReport | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [key, setKey] = useState("");
  const currentKey = JSON.stringify(params);
  const report = key === currentKey ? result : null;
  /** Purpose: Refresh pinned remote facts on every click. Input: none. Output: current report or actionable error. */
  const inspect = async () => {
    setPending(true); setError(""); setResult(null); setKey(currentKey);
    try {
      const value = await onAction(params.url ? "mergeAssistance" : "checkContribution", params);
      if (value && typeof value === "object" && "baseSha" in value) setResult(value as MergeReport);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setPending(false); }
  };
  return <section aria-label={params.url ? "PR 合并辅助" : "提交兼容性"}>
    <button type="button" disabled={busy || pending} onClick={() => void inspect()}>
      {pending ? "正在检查…" : params.url ? "帮助合并 / 刷新状态" : "检查兼容性"}
    </button>
    {error && <p role="alert">{error}</p>}
    {report && <div role="status">
      <p>{report.state && `PR：${report.state} · `}{report.snapshotFormat === "empty-target-snapshot-v1" ? `目标分支为空，可提交完整源码（${report.fileCount} 个文件）` : report.compatible === true ? "当前无文本冲突" : report.compatible === false ? "存在合并冲突" : "本地合并检查未完成"}
        {report.mergeStateStatus && ` · GitHub：${report.mergeStateStatus}`}</p>
      <p>目标：{report.targetBranch} · {report.baseSha}<br />源：{report.headBranch || "选定版本快照"} · {report.headSha}</p>
      <small>检查时间：{new Date(report.checkedAt).toLocaleString()}。目标后续变化需重新检查；无冲突不代表满足全部合并条件。</small>
      {report.probeError && <p role="alert">{report.probeError}</p>}
      {Boolean(report.conflicts?.length) && <ul>{report.conflicts?.map((path) => <li key={path}><code>{path}</code></li>)}</ul>}
      {report.url && <p><a href={`${report.url}/files`} target="_blank" rel="noreferrer">查看具体差异</a> · <a href={`${report.url}/checks`} target="_blank" rel="noreferrer">查看检查详情</a></p>}
      {report.checks && (report.checks.length ? <ul>{report.checks.map((check, index) => <li key={index}>{check.name || check.context || "检查"}：{check.conclusion || check.state || check.status || "未知"}</li>)}</ul> : <p>GitHub 未返回检查记录，不能据此判定 CI 通过。</p>)}
      {report.canUpdate === false && <p>当前账号没有源仓库写权限；需由源分支作者或获授权的维护者更新。</p>}
      {report.url && report.canUpdate === undefined && <p>源仓库写权限尚未验证。{report.permissionError}</p>}
      {report.url && report.state === "OPEN" && <button type="button" disabled={busy || pending}
        onClick={() => { setResult(null); void onAction("repairContribution", params); }}>调查并修复{report.url ? "原 PR" : "冲突"}</button>}
      {report.url && <p>修复将进入 Cleo 对话；需要人工取舍时展示差异。不会自动执行最终合并。处理后请再次刷新这里的状态。</p>}
    </div>}
  </section>;
}
