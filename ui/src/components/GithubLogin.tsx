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
  if (!auth) return null;
  const pending = auth.status === "starting" || auth.status === "waiting";
  const retry = auth.status === "failed" || auth.status === "cancelled";
  const copyCode = async () => {
    if (!auth.code) return;
    try {
      await window.cleoDesktop?.copyText(auth.code);
      setCopiedCode(auth.code); setFailedCopy(null);
    } catch { setFailedCopy(auth.code); }
  };
  return <section className="evolution-github" aria-label="GitHub 登录">
    <div className="evolution-github-heading"><GitBranch size={16} /><strong>GitHub 连接</strong></div>
    <p role="status">{auth.message}</p>
    {auth.status === "waiting" && auth.code && <>
      <div className="evolution-github-code">
        <code aria-label="GitHub 一次性验证码">{auth.code}</code>
        <button onClick={() => void copyCode()}>{copiedCode === auth.code ? <Check size={14} /> : <Copy size={14} />}{copiedCode === auth.code ? "已复制" : "复制验证码"}</button>
      </div>
      <p>打开 github.com/login/device，输入上面的验证码。授权完成后 Cleo 会自动确认。</p>
      {auth.browserError && <p className="evolution-github-hint">{auth.browserError}</p>}
      {failedCopy === auth.code && <p className="evolution-github-hint">复制失败，请手动选择并复制验证码。</p>}
    </>}
    <div className="evolution-github-actions">
      {auth.status === "connected" && <button className="evolution-primary" disabled={busy} onClick={onContribute}>继续提交 PR</button>}
      {auth.status === "waiting" && <button className="evolution-primary" onClick={() => onAction("openGithubLogin")}><ExternalLink size={14} />打开 GitHub 授权页面</button>}
      {pending && <button onClick={() => onAction("cancelLogin")}>取消登录</button>}
      {retry && <button disabled={busy} onClick={() => onAction("login")}>重新连接 GitHub</button>}
    </div>
  </section>;
}
