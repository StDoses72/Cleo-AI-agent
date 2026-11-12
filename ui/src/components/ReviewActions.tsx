import { t as tr } from "../../electron/i18n.mjs";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, GitBranch, GitCommitHorizontal, GitPullRequest, LoaderCircle, MessageSquare, X } from "lucide-react";
import type { PullRequestStatus, SourceControlOp, SourceControlStatus } from "../types";

export type RunSourceControl = <T = unknown>(op: SourceControlOp, params?: Record<string, unknown>) => Promise<T>;

/** A note a reviewer leaves on one line of the current workspace diff. `excerpt` is the line's text
 * when the note was written: the note stays pinned to that text and is shown as outdated if the
 * line changes. */
export interface ReviewComment {
  id: string;
  path: string;
  line: number;
  side: "old" | "new";
  text: string;
  excerpt: string;
  /** The task's folder and branch when the note was written; the note shows only there. */
  repository?: string;
  branch?: string;
  /** Fingerprint ("h1:…") of the diff hunk the note was written on; a different one is marked on the
   * note. Older notes may carry a whole-file fingerprint without the prefix ("version not checked"). */
  diffHash?: string;
}

/** Purpose: What a review note says about its version when it is sent: nothing when it is current. */
function versionNote(version: "current" | "changed" | "unverified") {
  return version === "changed" ? ` ${tr("review.note_stale_in_prompt")}`
    : version === "unverified" ? ` ${tr("review.note_unverified_in_prompt")}` : "";
}

/** Purpose: Format review notes as one instruction the agent can act on, quoting each line.
 * Input: the notes and, optionally, the version each was written on (see noteVersion); notes not on
 * the current change say so, so the agent checks they still apply. */
export function reviewCommentsPrompt(comments: ReviewComment[],
  versionOf: (comment: ReviewComment) => "current" | "changed" | "unverified" = () => "current") {
  return [tr("review.comments_intro"), ...comments.map((comment) =>
    `- ${comment.path}:${comment.line}${comment.side === "old" ? ` (${tr("review.removed_line")})` : ""} \`${comment.excerpt.slice(1).trim().slice(0, 120)}\` — ${comment.text}${versionNote(versionOf(comment))}`)].join("\n");
}

/** Purpose: The branch row of the Changes tab: where the work lives and the actions that keep it.
 * Input: a git runner bound to the task's folder and a change counter that triggers a refresh.
 * Output: branch with ahead/behind counts, Commit (inline message form, optional push), Push and
 * Create pull request; folders that are not repositories show nothing.
 */
export function SourceControlRow({ run, paths, busy, busyReason, onNotify }: {
  run: RunSourceControl;
  /** The task's changed files: Commit stages and commits exactly these. */
  paths: string[];
  busy: boolean;
  /** Why actions are unavailable (e.g. another task is running in this checkout). */
  busyReason?: string;
  onNotify: (message: string, tone?: "success" | "error") => void;
}) {
  const changeCount = paths.length;
  const [status, setStatus] = useState<SourceControlStatus | null>(null);
  const [pullRequest, setPullRequest] = useState<PullRequestStatus | null>(null);
  const [prRefreshFailed, setPrRefreshFailed] = useState(false);
  const [pending, setPending] = useState<SourceControlOp | null>(null);
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState("");
  const [pushAfter, setPushAfter] = useState(false);
  // Only the newest status answer is applied; a slow answer for an earlier state is dropped.
  const request = useRef(0);
  // GitHub is asked about the branch's pull request once per branch (and again after a push or a
  // new PR, or each minute while checks are still running) — not on every local file change.
  const prAsked = useRef<{ key: string; at: number } | null>(null);
  // Pull request answers are numbered on their own: a later status read that does not ask GitHub
  // again (same branch, asked moments ago) must not discard the answer still on its way.
  const prRequest = useRef(0);
  const askPullRequest = (next: SourceControlStatus, force = false) => {
    if (!next?.repository || !next.upstream || !next.canCreatePullRequest) {
      prRequest.current += 1;
      setPullRequest(null);
      prAsked.current = null;
      return;
    }
    const key = `${next.branch}|${next.upstream}`;
    // A pull request belongs to its branch: after a switch, nothing is known until GitHub answers for
    // the new branch, so a failed refresh offers Retry instead of showing the previous branch's PR.
    if (prAsked.current?.key !== key) { prRequest.current += 1; setPullRequest(null); setPrRefreshFailed(false); }
    if (!force && prAsked.current?.key === key && Date.now() - prAsked.current.at < 60_000) return;
    prAsked.current = { key, at: Date.now() };
    const id = ++prRequest.current;
    void run<{ pullRequest: PullRequestStatus | null }>("pullRequest")
      .then(answer => { if (id === prRequest.current) { setPullRequest(answer.pullRequest); setPrRefreshFailed(false); } },
        // Keep the last known pull request; say that the refresh failed rather than pretending there is none.
        () => { if (id === prRequest.current) setPrRefreshFailed(true); });
  };
  const refresh = (forcePullRequest = false) => {
    const id = ++request.current;
    return run<SourceControlStatus>("status").then(next => {
      if (id !== request.current) return;
      setStatus(next);
      askPullRequest(next, forcePullRequest);
    }).catch(() => { if (id === request.current) setStatus(null); });
  };
  useEffect(() => { void refresh(); }, [paths.join("\n")]);
  // Listeners installed once call the refresh of the latest render: an older one would carry the
  // task's folder and branch as they were when it was installed.
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  // Any checkout can be switched or committed to outside Cleo, pushed or not, on GitHub or not: git
  // is asked again whenever the window comes back into focus (the pull request too, where there is one).
  useEffect(() => {
    const onFocus = () => void latestRefresh.current(true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  // GitHub changes without Cleo (a merge, new checks, a PR opened elsewhere): while a pushed branch is
  // on screen the row asks again every few minutes — every minute while checks run.
  const followed = Boolean(status?.upstream && status.canCreatePullRequest);
  const checksRunning = Boolean(pullRequest?.checks.pending && pullRequest.state === "OPEN");
  useEffect(() => {
    if (!followed) return;
    const timer = window.setInterval(() => void latestRefresh.current(true), checksRunning ? 60_000 : 180_000);
    return () => window.clearInterval(timer);
  }, [followed, checksRunning]);
  if (!status?.repository) return null;

  const perform = async (op: SourceControlOp, params: Record<string, unknown> = {}) => {
    setPending(op);
    try {
      const result = await run<Record<string, unknown>>(op, params);
      if (op === "commit") {
        onNotify(tr("review.committed_value", { p0: String(result.sha ?? "") }));
        setComposing(false);
        setMessage("");
        if (pushAfter) await run("push").then(() => onNotify(tr("review.pushed_value", { p0: status.branch ?? "" })));
      } else if (op === "push") onNotify(tr("review.pushed_value", { p0: String(result.branch ?? "") }));
      else if (op === "createPullRequest") {
        onNotify(result.url ? tr("review.pull_request_opened_value", { p0: String(result.url) }) : tr("review.pull_request_opened"));
        if (typeof result.url === "string") window.open(result.url, "_blank", "noopener");
      }
    } catch (error) {
      onNotify(error instanceof Error ? error.message : tr("app.operation_failed"), "error");
    } finally {
      setPending(null);
      // A push or a new pull request changes what GitHub knows; ask again now.
      await refresh(op === "push" || op === "createPullRequest" || (op === "commit" && pushAfter));
    }
  };
  const disabled = busy || pending !== null;
  // Push needs a branch, a remote and commits the remote lacks (unknown counts are allowed).
  const canPush = Boolean(status.branch && status.remote) && status.ahead !== 0;
  const canOpenPr = Boolean(status.canCreatePullRequest && status.upstream && !status.ahead && !changeCount && !pullRequest);
  const checks = pullRequest?.checks;
  return (
    <div className="source-control" data-testid="source-control">
      <div className="source-control-row">
        <span className="source-branch" title={status.upstream ?? undefined}>
          <GitBranch size={13} />
          <span>{status.branch ?? tr("review.detached_head")}</span>
          {status.ahead ? <small title={tr("review.commits_to_push")}>↑{status.ahead}</small> : null}
          {status.behind ? <small title={tr("review.commits_to_pull")}>↓{status.behind}</small> : null}
        </span>
        <span className="source-actions">
          <button type="button" disabled={disabled || !changeCount} onClick={() => setComposing((open) => !open)} aria-expanded={composing}
            title={busyReason ?? (changeCount ? tr("review.commit_task_changes") : tr("review.nothing_to_commit"))}>
            <GitCommitHorizontal size={13} />{tr("review.commit")}
          </button>
          <button type="button" disabled={disabled || !canPush} onClick={() => void perform("push")}
            title={canPush ? tr("review.push_hint") : tr("review.nothing_to_push")}>
            {pending === "push" ? <LoaderCircle className="spin" size={13} /> : <ArrowUp size={13} />}{tr("review.push")}
          </button>
          {pullRequest ? (
            // The open pull request and its checks, as GitHub reports them; opens in the browser.
            // The pull request's lifecycle comes first (merged / closed / draft); an open one shows its checks.
            <a className={`pull-request-status ${pullRequest.state !== "OPEN" ? "closed" : checks?.failed ? "failed" : checks?.pending ? "pending" : "passed"}`}
              href={pullRequest.url} target="_blank" rel="noreferrer" data-testid="pull-request-status"
              title={prRefreshFailed ? `${pullRequest.title} · ${tr("review.pull_request_refresh_failed")}` : pullRequest.title}>
              <GitPullRequest size={13} />#{pullRequest.number}
              <small>{pullRequest.state === "MERGED" ? tr("review.pull_request_merged")
                : pullRequest.state === "CLOSED" ? tr("review.pull_request_closed")
                  : [pullRequest.draft ? tr("review.pull_request_draft") : "",
                    checks && checks.passed + checks.failed + checks.pending
                      ? checks.failed ? tr("review.checks_failed", { p0: checks.failed })
                        : checks.pending ? tr("review.checks_pending", { p0: checks.pending })
                          : tr("review.checks_passed", { p0: checks.passed })
                      : tr("review.pull_request_open")].filter(Boolean).join(" · ")}</small>
              {prRefreshFailed ? <small className="pull-request-stale">{tr("review.pull_request_refresh_failed")}</small> : null}
            </a>
          ) : prRefreshFailed ? (
            // Asking GitHub failed and nothing is known yet: say so instead of offering a duplicate PR.
            <button type="button" onClick={() => void refresh(true)} title={tr("review.pull_request_refresh_failed")}>
              <GitPullRequest size={13} />{tr("app.retry")}
            </button>
          ) : status.canCreatePullRequest ? (
            <button type="button" disabled={disabled || !canOpenPr} onClick={() => void perform("createPullRequest")}
              title={canOpenPr ? tr("review.create_pull_request_hint") : undefined}>
              {pending === "createPullRequest" ? <LoaderCircle className="spin" size={13} /> : <GitPullRequest size={13} />}{tr("review.pull_request")}
            </button>
          ) : null}
        </span>
      </div>
      {busyReason && busy ? <p className="source-control-note" role="status">{busyReason}</p> : null}
      {composing ? (
        <form className="commit-form" onSubmit={(event) => { event.preventDefault(); void perform("commit", { message, paths }); }}>
          <textarea autoFocus rows={2} value={message} onChange={(event) => setMessage(event.target.value)}
            placeholder={tr("review.commit_message_placeholder")} aria-label={tr("review.commit_message")}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void perform("commit", { message, paths }); }
              if (event.key === "Escape") { event.preventDefault(); setComposing(false); }
            }} />
          <div>
            <label><input type="checkbox" checked={pushAfter} onChange={(event) => setPushAfter(event.target.checked)} />{tr("review.push_after_commit")}</label>
            <button type="button" onClick={() => setComposing(false)}>{tr("app.close")}</button>
            <button type="submit" className="primary" disabled={disabled || !message.trim()}>
              {pending === "commit" ? <LoaderCircle className="spin" size={13} /> : null}{tr("review.commit_value_files", { p0: changeCount })}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

/** Purpose: A one-line form under a diff line for a review note. */
export function CommentForm({ onSave, onCancel }: { onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <form className="diff-comment-form" onSubmit={(event) => { event.preventDefault(); if (text.trim()) onSave(text.trim()); }}>
      <textarea ref={ref} rows={2} value={text} onChange={(event) => setText(event.target.value)} placeholder={tr("review.comment_placeholder")}
        aria-label={tr("review.comment_placeholder")}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (text.trim()) onSave(text.trim()); }
          if (event.key === "Escape") { event.preventDefault(); onCancel(); }
        }} />
      <div>
        <button type="button" onClick={onCancel}>{tr("app.close")}</button>
        <button type="submit" className="primary" disabled={!text.trim()}>{tr("review.add_comment")}</button>
      </div>
    </form>
  );
}

/** Purpose: The pending review notes and the action that hands them to the agent. */
/** Why review notes are not on screen: git reports another branch than the workspace's record (the
 * checkout was switched outside Cleo) and the record has not caught up yet.
 * Input: the branch git reports (null: detached HEAD), the recorded one, how many of this task's notes
 * are kept meanwhile, and a re-check of git and the workspace.
 */
export interface BranchHold {
  live: string | null;
  recorded: string | null;
  kept: number;
  onRetry: () => Promise<void>;
}

export function BranchHoldNotice({ hold }: { hold: BranchHold }) {
  const [checking, setChecking] = useState(false);
  return (
    <div className="branch-hold" data-testid="branch-hold" role="status">
      <GitBranch size={13} />
      <span>{tr(hold.kept ? "review.branch_unconfirmed_kept" : "review.branch_unconfirmed",
        { p0: hold.live ?? "HEAD", p1: hold.recorded ?? "HEAD", p2: hold.kept })}</span>
      <button type="button" disabled={checking} onClick={() => {
        setChecking(true);
        void hold.onRetry().finally(() => setChecking(false));
      }}>
        {checking ? <LoaderCircle className="spin" size={12} /> : null}
        {tr("review.check_branch_again")}
      </button>
    </div>
  );
}

export function ReviewCommentsBar({ comments, onSend, onClear }: { comments: ReviewComment[]; onSend: () => void; onClear: () => void }) {
  if (!comments.length) return null;
  return (
    <div className="review-comments-bar" data-testid="review-comments">
      <MessageSquare size={13} />
      <span>{tr("review.value_comments", { p0: comments.length })}</span>
      <button type="button" onClick={onClear} aria-label={tr("review.discard_comments")} title={tr("review.discard_comments")}><X size={13} /></button>
      <button type="button" className="primary" onClick={onSend}>{tr("review.send_to_agent")}</button>
    </div>
  );
}
