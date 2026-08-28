import { useEffect } from "react";
import { GitBranch, LoaderCircle, ShieldCheck, Terminal, X } from "lucide-react";
import type { ApprovalDecision, ApprovalRequest } from "../types";

interface ApprovalPromptProps {
  request: ApprovalRequest | null;
  pending: boolean;
  error: string | null;
  onResolve: (decision: ApprovalDecision) => void;
}

const titleByKind: Record<ApprovalRequest["kind"], string> = {
  command: "Cleo 想要执行受保护的命令",
  file_change: "Cleo 想要修改受保护的文件",
  permissions: "Cleo 请求额外权限",
};

export function ApprovalPrompt({ request, pending, error, onResolve }: ApprovalPromptProps) {
  const decisions = new Set(request?.availableDecisions ?? []);
  const denyDecision: ApprovalDecision | null = decisions.has("decline")
    ? "decline"
    : decisions.has("cancel") ? "cancel" : null;

  useEffect(() => {
    const decideFromKeyboard = (event: globalThis.KeyboardEvent) => {
      if (!request || pending) return;
      if (event.target instanceof HTMLInputElement
        || event.target instanceof HTMLTextAreaElement
        || event.target instanceof HTMLSelectElement) return;
      if (event.key === "1" && decisions.has("accept")) onResolve("accept");
      if (event.key === "2" && decisions.has("acceptForSession")) {
        onResolve("acceptForSession");
      }
      if (event.key === "Escape" && denyDecision) onResolve(denyDecision);
    };
    window.addEventListener("keydown", decideFromKeyboard);
    return () => window.removeEventListener("keydown", decideFromKeyboard);
  }, [decisions, denyDecision, onResolve, pending, request]);

  if (!request) return null;

  const actionSummary = request.commandActions
    .map((action) => typeof action.command === "string" ? action.command : "")
    .filter(Boolean)
    .join(" && ");
  const detail = request.command
    || actionSummary
    || request.grantRoot
    || (request.permissions ? JSON.stringify(request.permissions) : "等待确认后继续当前操作");
  const reason = request.reason || (
    request.kind === "command"
      ? "该命令需要超出当前沙箱或写入受保护区域。请确认后继续。"
      : request.kind === "file_change"
        ? "这项文件修改超出了当前会话已经授予的写入范围。"
        : "Codex 请求临时扩展当前会话的文件系统或网络访问范围。"
  );

  return (
    <section className="approval-prompt" aria-labelledby="approval-title" data-testid="approval-prompt">
      <header className="approval-header">
        <span className="approval-mark" aria-hidden="true"><ShieldCheck size={18} /></span>
        <div>
          <span className="approval-kicker">需要你的确认</span>
          <h3 id="approval-title">{titleByKind[request.kind]}</h3>
        </div>
        <span className="approval-context" title={request.cwd || request.method}>
          <GitBranch size={12} />{request.kind === "command" ? "命令" : request.kind === "file_change" ? "文件" : "权限"}
        </span>
      </header>

      <div className="approval-command">
        <Terminal size={14} aria-hidden="true" />
        <code>{detail}</code>
      </div>

      <p className="approval-reason">{reason}</p>

      <div className="approval-options">
        {decisions.has("accept") ? (
          <button className="approval-option primary" type="button" disabled={pending} onClick={() => onResolve("accept")} data-testid="approval-once">
            <span><strong>仅允许这一次</strong><small>继续当前操作，不保存规则</small></span>
            {pending ? <LoaderCircle className="approval-spinner" size={13} /> : <kbd>1</kbd>}
          </button>
        ) : null}
        {decisions.has("acceptForSession") ? (
          <button className="approval-option" type="button" disabled={pending} onClick={() => onResolve("acceptForSession")} data-testid="approval-session">
            <span><strong>本次会话始终允许</strong><small>相同请求在本次会话中不再询问</small></span>
            <kbd>2</kbd>
          </button>
        ) : null}
      </div>

      <footer className="approval-footer">
        {denyDecision ? (
          <button type="button" disabled={pending} onClick={() => onResolve(denyDecision)} data-testid="approval-deny">
            <X size={13} />拒绝
          </button>
        ) : <span />}
        <span className={error ? "approval-error" : ""}>
          {error || (request.cwd ? request.cwd : "请求暂停中")} {!error ? <kbd>Esc</kbd> : null}
        </span>
      </footer>
    </section>
  );
}
