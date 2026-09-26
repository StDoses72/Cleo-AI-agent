import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { useAutomaticRead } from "../useAutomaticRead";
import type { EvolutionBuild, EvolutionPullRequest, EvolutionState } from "../evolution-types";

interface Props {
  state: EvolutionState | null;
  busy: boolean;
  initialUrl?: string;
  buildId?: string;
  onAction: (action: string, params?: Record<string, unknown>) => void | Promise<unknown>;
  onBusy?: (busy: boolean) => void;
  onStarted?: () => void;
  onContribute?: (buildId: string) => void;
}

interface ReleaseSource { key: string; build?: EvolutionBuild; pr?: EvolutionPullRequest }

const versionPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Input: a PR and retained builds. Output: a source label that survives local build pruning. */
function sourceLabel(pr: EvolutionPullRequest, builds: EvolutionBuild[]) {
  const build = builds.find(item => item.id === pr.buildId);
  const name = build?.name || pr.title || (pr.buildId ? `本地版本 ${pr.buildId}` : "PR 合并版本");
  const version = build?.version || build?.baseTag;
  return `PR #${pr.number || pr.url.split("/").at(-1)} · ${name}${version ? ` (${version})` : ""} · ${pr.targetBranch || "目标分支待核验"}`;
}

/** Input: a retained local build. Output: the name users gave it, or where it came from. */
function buildLabel(build: EvolutionBuild, state: EvolutionState | null) {
  const saved = build.savedAt && !Number.isNaN(new Date(build.savedAt).getTime())
    ? `本地版 · ${new Date(build.savedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "";
  const name = build.name || saved || (build.id === state?.active ? "当前运行的版本" : build.id === state?.candidate ? "待应用的修改" : `本地版本 ${build.id}`);
  return `${name}${build.version ? ` (${build.version})` : ""}`;
}

/** Input: evolution state. Output: local versions (each with its best PR), then PR versions whose local copy was pruned. */
function releaseSources(state: EvolutionState | null) {
  const history = [...(state?.pullRequests || []), ...(state?.pullRequest ? [state.pullRequest] : [])]
    .filter((pr, index, all) => all.findIndex(item => item.url === pr.url) === index);
  const builds = (state?.builds || []).filter(build => build.kind === "local" && (build.sourceHash || build.importHash)
    && (build.savedAt || build.id === state?.active || build.id === state?.candidate || history.some(pr => pr.buildId === build.id)));
  // Prefer a merged PR, then the most recent submission for the same local version.
  const prFor = (id: string) => history.filter(pr => pr.buildId === id)
    .sort((a, b) => Number(b.merged) - Number(a.merged) || String(b.submittedAt || "").localeCompare(String(a.submittedAt || "")))[0];
  const locals: ReleaseSource[] = builds.map(build => ({ key: `build:${build.id}`, build, pr: prFor(build.id) }));
  const others: ReleaseSource[] = history.filter(pr => !builds.some(build => build.id === pr.buildId)).map(pr => ({ key: `pr:${pr.url}`, pr }));
  return { history, locals, others };
}

const prState = (pr?: EvolutionPullRequest) => !pr ? "未提交 PR" : `PR #${pr.number || pr.url.split("/").at(-1)} ${pr.merged ? "已合并" : "待合并"}`;

/** Input: retained local versions, their PRs and desktop actions. Output: choose a local version, then one-click release. */
export function ReleasePublisher({ state, busy, initialUrl = "", buildId, onAction, onBusy, onStarted, onContribute }: Props) {
  const { history, locals, others } = releaseSources(state);
  const [choice, setChoice] = useState(() => {
    const initial = history.find(pr => pr.url === initialUrl);
    if (initial) return locals.find(source => source.build?.id === initial.buildId)?.key || `pr:${initial.url}`;
    return locals.find(source => source.build?.id === buildId)?.key || "";
  });
  const source = [...locals, ...others].find(item => item.key === choice);
  const [url, setUrl] = useState(() => {
    const initial = history.find(pr => pr.url === initialUrl);
    return initial ? initial.url : source?.pr?.url || "";
  });
  const [tag, setTag] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [prerelease, setPrerelease] = useState(false);
  const [result, setResult] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const access = state?.githubAuth?.repositoryAccess;
  const receipt = history.find(pr => pr.url === url);
  const releasing = Boolean(state?.releaseJob && !["completed", "failed", "cancelled"].includes(state.releaseJob.phase));
  const locked = !!pending || releasing;
  const connected = state?.githubAuth?.status === "connected";
  const knownLogin = useRef(access?.login);
  if (access?.login) knownLogin.current = access.login;
  if (!connected) knownLogin.current = undefined;
  const checkKey = JSON.stringify([connected, url, knownLogin.current]);
  const check = useAutomaticRead(checkKey, connected && !busy && !locked && !result, async () => {
    const value = await onAction(url ? "previewMergedRelease" : "releasePermission", url ? { url } : undefined);
    if (!value || typeof value !== "object") throw new Error("未能确认发布条件，请重试。");
    if (url) {
      if (!("url" in value) || value.url !== url || !("commit" in value) || !("login" in value)) throw new Error("未能核验所选 PR，请重试。");
    } else if (!("status" in value) || value.status !== "checked" || !("canRelease" in value) || !value.canRelease) {
      throw new Error("message" in value ? String(value.message) : "未能确认发布权限，请重试。");
    }
    return { login: "login" in value ? String(value.login) : undefined };
  });
  const checked = check.data;
  const accessError = connected && access && access.status !== "checking" && !access.canRelease ? access.message : "";
  const canPublish = checked && !check.pending && !check.error && access?.canRelease !== false && (!access?.login || access.login === checked.login);
  const validVersion = versionPattern.test(tag.trim()) && !tag.includes("+") && tag.trim().length <= 100;
  const publish = async () => {
    if (inFlight.current || locked || busy || !canPublish || !receipt) return;
    if (!validVersion) {
      setError("请输入合法版本号，例如 v1.2.3 或 v1.2.3-beta.1。"); return;
    }
    inFlight.current = true; setPending("startRelease"); onBusy?.(true); setError("");
    try {
      const value = await onAction("startRelease", { url, tag: tag.trim(), title: title.trim() || tag.trim(), body, prerelease, login: checked?.login });
      if (!value || typeof value !== "object" || !("id" in value)) throw new Error("未收到发布任务，请重试核对。");
      setResult(true);
      onBusy?.(false);
      onStarted?.();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { inFlight.current = false; setPending(null); onBusy?.(false); }
  };
  return <section ref={check.root} className="release-publisher" aria-label="创建 GitHub Release">
    <p>自动构建各平台安装包，失败时尝试修复，完成后发布到 GitHub。</p>
    <label>发布本地版本<select aria-label="发布本地版本" disabled={locked} value={choice} onChange={event => {
      const next = [...locals, ...others].find(item => item.key === event.target.value);
      setChoice(event.target.value); setUrl(next?.pr?.url || ""); setResult(false); setError("");
    }}>
      <option value="">请选择要发布的本地版本</option>
      {locals.length > 0 && <optgroup label="本地版本">
        {locals.map(item => <option key={item.key} value={item.key}>{buildLabel(item.build!, state)} · {prState(item.pr)}</option>)}
      </optgroup>}
      {others.length > 0 && <optgroup label="其他 PR 版本（本地副本已清理）">
        {others.map(item => <option key={item.key} value={item.key}>{sourceLabel(item.pr!, state?.builds || [])} · {item.pr!.merged ? "已合并" : "合并状态待核验"}</option>)}
      </optgroup>}
    </select></label>
    {!locals.length && !others.length && <p role="status">暂无可发布的本地版本，请先保存版本并通过 PR 合并。</p>}
    {source?.build && !source.pr && <p role="status" className="release-needs-pr">此版本还没有 PR。Release 只发布已合并到 GitHub 仓库的源码，请先为它提交 PR，合并后再发布。
      {onContribute && <button type="button" disabled={locked} onClick={() => onContribute(source.build!.id)}>为此版本新建 PR</button>}</p>}
    {receipt && <a href={url} target="_blank" rel="noreferrer">查看 PR</a>}
    <form noValidate onSubmit={event => { event.preventDefault(); void publish(); }}>
      <label>发布版本号<input aria-label="版本标签" value={tag} disabled={locked || !!result} required maxLength={100} placeholder="v1.2.3"
        aria-invalid={!!tag && !validVersion} onChange={event => { setTag(event.target.value); setError(""); }} /></label>
      {tag && !validVersion && <p>版本号格式：v1.2.3 或 v1.2.3-beta.1。</p>}
      <label>发布类型<select aria-label="发布类型" value={prerelease ? "pre" : "stable"} disabled={locked || !!result} onChange={event => setPrerelease(event.target.value === "pre")}>
        <option value="stable">正式版</option><option value="pre">预发布版</option>
      </select></label>
      <details><summary>标题与说明（可选）</summary>
      <label>发布标题<input aria-label="发布标题" value={title} disabled={locked || !!result} maxLength={200} placeholder={tag.trim() || "默认使用版本号"} onChange={event => setTitle(event.target.value)} /></label>
      <label>发布说明<textarea aria-label="发布说明" value={body} disabled={locked || !!result} maxLength={20000} onChange={event => setBody(event.target.value)} /></label>
      </details>
      {!connected && <p role="status">请先连接 GitHub。</p>}
      {connected && check.pending && <p role="status">{url ? "正在核对发布来源…" : "正在确认发布权限…"}</p>}
      {connected && (check.error || accessError) && <p role="alert">{check.error || accessError} <button type="button" disabled={busy || locked} onClick={() => void check.retry()}>重试</button></p>}
      {canPublish && checked?.login && <p className="release-account">发布账号：{checked.login}</p>}
      <button className="evolution-primary" disabled={busy || locked || !connected || !canPublish || !receipt || !!result}><Upload size={14} />{pending === "startRelease" ? "正在启动发布…" : "发布"}</button>
    </form>
    {pending === "startRelease" && <p role="status">{state?.logs.trim().split("\n").at(-1) || "正在检查发布权限、PR 合并状态及提交源码…"}</p>}
    {error && <p role="alert">{error}</p>}
    {result && <p role="status">发布任务已启动，可关闭此窗口。在进化页面顶部查看构建、修复和发布进度。</p>}
  </section>;
}
