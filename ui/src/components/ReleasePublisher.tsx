import { useRef, useState } from "react";
import { RefreshCw, Upload } from "lucide-react";
import type { EvolutionState } from "../evolution-types";
import { ReleasePackages } from "./ReleasePackages";

interface ReleasePreview {
  repository: string;
  url: string;
  buildId: string;
  targetBranch: string;
  commit: string;
  login: string;
}
interface ReleaseResult { releaseUrl: string; prerelease: boolean; tag: string }
interface Props {
  state: EvolutionState | null;
  busy: boolean;
  initialUrl?: string;
  buildId?: string;
  onAction: (action: string, params?: Record<string, unknown>) => void | Promise<unknown>;
  onBusy?: (busy: boolean) => void;
}

export function ReleasePublisher({ state, busy, initialUrl = "", buildId, onAction, onBusy }: Props) {
  const [url, setUrl] = useState(initialUrl);
  const [tag, setTag] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [prerelease, setPrerelease] = useState(true);
  const [preview, setPreview] = useState<ReleasePreview | null>(null);
  const [result, setResult] = useState<ReleaseResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const access = state?.githubAuth?.repositoryAccess;
  const history = [...(state?.pullRequests || []), ...(state?.pullRequest ? [state.pullRequest] : [])]
    .filter((pr, index, all) => (!buildId || pr.buildId === buildId) && all.findIndex(item => item.url === pr.url) === index);
  const receipt = history.find(pr => pr.url === url);
  const build = state?.builds.find(item => item.id === receipt?.buildId);
  const prepared = Boolean(state?.prepared && !state.draftDirty && build?.sourceHash
    && build.sourceHash === receipt?.sourceHash && [state.active, state.candidate].includes(build.id));
  const locked = busy || pending;
  const allowed = state?.githubAuth?.status === "connected" && access?.status === "checked" && access.canRelease;
  const blocker = !url ? "请选择要发布的 PR。" : !build ? "该 PR 对应的本地版本已不在保留列表中，无法核验源码。请选择仍保留的版本对应的 PR。"
    : state?.draftDirty ? "当前源码有未处理改动。请先通过桌面控件完成本次迭代或放弃改动，再核对发布提交。"
    : ![state?.active, state?.candidate].includes(build.id) ? "请先通过版本控件切换到该 PR 对应的本地版本。"
    : !prepared ? "请先准备并核验该版本源码；所选版本的源码必须与 PR 提交记录一致。" : "";
  const recover = async (action: string) => {
    if (inFlight.current || locked) return;
    inFlight.current = true; setPending(true); onBusy?.(true); setError("");
    try { await onAction(action); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { inFlight.current = false; setPending(false); onBusy?.(false); }
  };
  const run = async (publish: boolean) => {
    if (inFlight.current || locked) return;
    inFlight.current = true; setPending(true); onBusy?.(true); setError("");
    try {
      if (publish && preview) {
        const value = await onAction("publishRelease", { ...preview, tag: tag.trim(), title, body, prerelease });
        if (value && typeof value === "object" && "releaseUrl" in value) setResult(value as ReleaseResult);
      } else {
        setPreview(null); setResult(null);
        const value = await onAction("previewRelease", { url });
        if (value && typeof value === "object" && "commit" in value) setPreview(value as ReleasePreview);
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { inFlight.current = false; setPending(false); onBusy?.(false); }
  };
  return <section className="release-publisher" aria-label="创建 GitHub Release">
    <h3>创建 GitHub Release</h3>
    <p>仓库：StDoses72/Cleo-AI-agent</p>
    {!allowed && <p role="status">{access?.message || "请先连接 GitHub 并确认仓库发布权限。"}</p>}
    <button disabled={locked} onClick={() => void recover("releasePermission")}><RefreshCw size={14} />重新检查发布权限</button>
    <label>发布来源 PR<select aria-label="发布来源 PR" disabled={locked} value={url} onChange={event => {
      setUrl(event.target.value); setPreview(null); setResult(null); setError("");
    }}>
      <option value="">请选择已合并的 PR</option>
      {history.map(pr => <option key={pr.url} value={pr.url}>#{pr.number || pr.url.split("/").at(-1)} · {pr.targetBranch} · {pr.merged ? "已合并" : "待核对合并状态"}</option>)}
    </select></label>
    {url && <p><a href={url} target="_blank" rel="noreferrer">查看 PR</a></p>}
    {blocker && <p role="status">{blocker}</p>}
    {!prepared && build?.id === state?.active && !state?.draftDirty && <button disabled={locked} onClick={() => void recover("prepare")}><RefreshCw size={14} />准备当前版本源码</button>}
    <button disabled={locked || !allowed || !url || !prepared} onClick={() => void run(false)}><RefreshCw size={14} />核对发布提交</button>
    {preview && <form onSubmit={event => { event.preventDefault(); void run(true); }}>
      <p>目标分支：<strong>{preview.targetBranch}</strong></p>
      <p>发布提交：<code className="release-commit">{preview.commit}</code></p>
      {preview.login !== access?.login && <p role="status">GitHub 账号已变化，请重新核对发布提交。</p>}
      <label>版本标签<input aria-label="版本标签" value={tag} disabled={locked || !!result} required maxLength={100} placeholder="v0.5.0-beta.1" onChange={event => setTag(event.target.value)} /></label>
      <label>发布类型<select aria-label="发布类型" value={prerelease ? "pre" : "stable"} disabled={locked || !!result} onChange={event => setPrerelease(event.target.value === "pre")}>
        <option value="pre">预发布版（pre-release）</option><option value="stable">正式版（release）</option>
      </select></label>
      <label>发布标题<input aria-label="发布标题" value={title} disabled={locked || !!result} required maxLength={200} onChange={event => setTitle(event.target.value)} /></label>
      <label>发布说明<textarea aria-label="发布说明" value={body} disabled={locked || !!result} maxLength={20000} onChange={event => setBody(event.target.value)} /></label>
      <p>本次创建{prerelease ? "预发布版" : "正式版"}：{tag || "尚未填写标签"}。可安装状态取决于该 Release 是否已有当前平台的安装包。</p>
      <button className="evolution-primary" disabled={locked || !allowed || !prepared || !!result || !tag.trim() || !title.trim() || preview.login !== access?.login}><Upload size={14} />{pending ? "正在发布…" : "确认创建 Release"}</button>
    </form>}
    {error && <p role="alert">{error}</p>}
    {result && <p role="status">{result.prerelease ? "预发布版" : "正式版"} {result.tag} 的 Release 已创建。<a href={result.releaseUrl} target="_blank" rel="noreferrer">查看 GitHub Release</a></p>}
    {preview && <ReleasePackages key={`${preview.url}:${preview.commit}:${preview.login}`} params={{ ...preview, tag: tag.trim(), title, body, prerelease }}
      disabled={locked || !allowed || !prepared || preview.login !== access?.login} onAction={onAction} onBusy={onBusy} />}
  </section>;
}
