import { t as tr } from "../../electron/i18n.mjs";
import { useState } from "react";
import { Check, Copy, ExternalLink, GitBranch } from "lucide-react";
import type { EvolutionGithubAuth } from "../evolution-types";

/** Purpose: Keep device authorization instructions visible while gh waits for the user.
 * Input: transient login state, operation lock, and callbacks. Output: authorization controls and the next contribution step.
 */
export function GithubLogin({ auth, busy, onAction, onContribute }: {
  auth: EvolutionGithubAuth | null | undefined;
  busy: boolean;
  onAction: (action: string) => void;
  onContribute: () => void;
}) {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [failedCopy, setFailedCopy] = useState<string | null>(null);
  auth = auth || { status: "disconnected", message: "" };
  const pending = auth.status === "starting" || auth.status === "waiting" || auth.status === "checking";
  const retry = auth.status === "failed" || auth.status === "cancelled";
  const copyCode = async () => {
    if (!auth.code) return;
    try {
      await window.cleoDesktop?.copyText(auth.code);
      setCopiedCode(auth.code); setFailedCopy(null);
    } catch { setFailedCopy(auth.code); }
  };
  return <section className="evolution-github" aria-label={tr("githublogin.github_sign_in")}>
    <div className="evolution-github-heading"><GitBranch size={16} /><strong>{tr("githublogin.github_connection")}</strong></div>
    {auth.message && <p role="status">{auth.message}</p>}
    {auth.status === "connected" && <p role="status" aria-label={tr("githublogin.repository_release_permission")}>
      {auth.repositoryAccess?.login && <strong>{auth.repositoryAccess.login} · {auth.repositoryAccess.role} · </strong>}
      {auth.repositoryAccess?.message || tr("githublogin.repository_release_permission_has_not_been_confirmed")}
    </p>}
    {auth.diagnostic && <p className="evolution-github-hint">{tr("githublogin.diagnostics")}{auth.diagnostic}</p>}
    {auth.status === "waiting" && auth.code && <>
      <div className="evolution-github-code">
        <code aria-label={tr("githublogin.github_one_time_code")}>{auth.code}</code>
        <button onClick={() => void copyCode()}>{copiedCode === auth.code ? <Check size={14} /> : <Copy size={14} />}{copiedCode === auth.code ? tr("conversation.copied") : tr("githublogin.copy_code")}</button>
      </div>
      <p>{tr("githublogin.enter_this_code_at_github_com_login_device")}</p>
      {auth.browserError && <p className="evolution-github-hint">{auth.browserError}</p>}
      {failedCopy === auth.code && <p className="evolution-github-hint">{tr("githublogin.copy_failed_select_and_copy_the_code_manually")}</p>}
    </>}
    <div className="evolution-github-actions">
      {auth.status === "connected" && <button className="evolution-primary" disabled={busy} onClick={onContribute}>{auth.repositoryAccess?.canRelease ? tr("githublogin.submit_pr_publish") : tr("githublogin.continue_pr_submission")}</button>}
      {auth.status === "waiting" && <button className="evolution-primary" onClick={() => onAction("openGithubLogin")}><ExternalLink size={14} />{tr("githublogin.open_github_authorization_page")}</button>}
      {pending && <button onClick={() => onAction("cancelLogin")}>{tr("githublogin.cancel_sign_in")}</button>}
      {retry && <button disabled={busy} onClick={() => onAction("login")}>{tr("githublogin.reconnect_github")}</button>}
      {auth.status === "disconnected" && <button disabled={busy} onClick={() => onAction("login")}>{tr("githublogin.connect_github")}</button>}
      {auth.status === "connected" && <button disabled={busy} onClick={() => onAction("login")}>{tr("githublogin.check_connection")}</button>}
    </div>
  </section>;
}
