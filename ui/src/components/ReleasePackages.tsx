import { useEffect, useRef, useState } from "react";
import { RefreshCw, Upload } from "lucide-react";

interface BuildRun { id: string; url: string; createdAt: string }
interface PackageStatus { status: string; workflowUrl: string; releaseUrl?: string }
const labels: Record<string, string> = {
  submitted: "发布请求已提交，等待工作流创建运行记录。",
  running: "安装包发布中。",
  completed: "安装包发布完成：工作流成功，四个平台安装包、清单和校验文件齐全。",
  failed: "安装包发布失败。请查看工作流错误，修复后使用相同标签和构建重试。",
  unknown: "尚未找到对应运行记录。请求可能仍在处理，请稍后刷新。",
  incomplete: "工作流曾成功，但远端文件或发布信息不完整，不能确认安装包可用。请查看工作流及 Release。",
};

export function ReleasePackages({ params, disabled, onAction, onBusy }: {
  params: Record<string, unknown>;
  disabled: boolean;
  onAction: (action: string, params?: Record<string, unknown>) => void | Promise<unknown>;
  onBusy?: (busy: boolean) => void;
}) {
  const [builds, setBuilds] = useState<BuildRun[] | null>(null);
  const [runId, setRunId] = useState("");
  const [status, setStatus] = useState<PackageStatus | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => { setStatus(null); setError(""); }, [params.tag, params.title, params.body, params.prerelease, runId]);
  const run = async (action: string) => {
    if (disabled || inFlight.current) return;
    inFlight.current = true; setPending(true); onBusy?.(true); setError("");
    try {
      const value = await onAction(action, { ...params, runId });
      if (action === "releaseBuilds" && Array.isArray(value)) {
        setBuilds(value); setRunId(value[0]?.id || ""); setStatus(null);
      } else if (value && typeof value === "object" && "status" in value) setStatus(value as PackageStatus);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { inFlight.current = false; setPending(false); onBusy?.(false); }
  };
  const locked = disabled || pending;
  return <section aria-label="发布安装包">
    <h4>安装包</h4>
    {!status && <p role="status">安装包尚未确认发布。</p>}
    <button disabled={locked} onClick={() => void run("releaseBuilds")}><RefreshCw size={14} />查找匹配构建</button>
    {builds?.length === 0 && <p role="status">没有该提交的完整构建。需要成功的 Desktop platforms 手动构建及四个平台未过期的产物；PR 检查不包含完整 Windows 安装包。
      <a href="https://github.com/StDoses72/Cleo-AI-agent/actions/workflows/desktop-platforms.yml" target="_blank" rel="noreferrer">查看 Desktop platforms</a></p>}
    {!!builds?.length && <label>成功构建<select aria-label="成功构建" value={runId} disabled={locked} onChange={event => setRunId(event.target.value)}>
      {builds.map(build => <option key={build.id} value={build.id}>#{build.id} · {build.createdAt}</option>)}
    </select></label>}
    <label>构建 Run ID<input aria-label="构建 Run ID" inputMode="numeric" pattern="[0-9]+" value={runId} disabled={locked} onChange={event => setRunId(event.target.value)} /></label>
    {builds?.find(build => build.id === runId) && <p><a href={builds.find(build => build.id === runId)!.url} target="_blank" rel="noreferrer">查看构建</a></p>}
    <button disabled={locked || !/^\d+$/.test(runId) || !params.tag || !params.title || status?.status === "running" || status?.status === "submitted" || status?.status === "completed"}
      onClick={() => void run("publishReleasePackages")}><Upload size={14} />发布安装包</button>
    <button disabled={locked || !/^\d+$/.test(runId) || !params.tag} onClick={() => void run("releasePackageStatus")}><RefreshCw size={14} />刷新安装包状态</button>
    {status && <p role="status">{labels[status.status] || "安装包状态待确认。"} <a href={status.workflowUrl} target="_blank" rel="noreferrer">查看发布工作流</a>
      {status.releaseUrl && <> · <a href={status.releaseUrl} target="_blank" rel="noreferrer">查看安装包</a></>}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
