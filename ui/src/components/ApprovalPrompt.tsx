import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch, LoaderCircle, ShieldCheck, Terminal, X } from "lucide-react";
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
  elicitation: "工具请求你的授权",
};

type AllowMode = "accept" | "acceptForSession";

export function ApprovalPrompt({ request, pending, error, onResolve }: ApprovalPromptProps) {
  const decisions = new Set(request?.availableDecisions ?? []);
  const denyDecision: ApprovalDecision | null = decisions.has("decline")
    ? "decline"
    : decisions.has("cancel") ? "cancel" : null;
  const [allowMode, setAllowMode] = useState<AllowMode>("accept");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // A new request starts from the conservative choice again.
  useEffect(() => { setAllowMode("accept"); setMenuOpen(false); }, [request?.id]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [menuOpen]);

  useEffect(() => {
    const decideFromKeyboard = (event: globalThis.KeyboardEvent) => {
      if (!request || pending || event.defaultPrevented || event.isComposing
          || event.ctrlKey || event.metaKey || event.altKey || document.querySelector("dialog[open]")) return;
      if (event.target instanceof HTMLInputElement
        || event.target instanceof HTMLTextAreaElement
        || event.target instanceof HTMLSelectElement
        || (event.target instanceof HTMLElement && event.target.isContentEditable)) return;
      if (event.key === "Escape" && menuOpen) { setMenuOpen(false); return; }
      if (event.key === "1" && decisions.has("accept")) onResolve("accept");
      if (event.key === "2" && decisions.has("acceptForSession")) {
        onResolve("acceptForSession");
      }
      if (event.key === "Escape") {
        if (decisions.has("cancel")) onResolve("cancel");
        else if (denyDecision) onResolve(denyDecision);
      }
    };
    window.addEventListener("keydown", decideFromKeyboard);
    return () => window.removeEventListener("keydown", decideFromKeyboard);
  }, [decisions, denyDecision, menuOpen, onResolve, pending, request]);

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
        : "当前服务请求你的确认。"
  );

  const onceLabel = request.decisionLabels?.accept
    || (request.mode === "url" ? "已完成授权" : request.kind === "elicitation" ? "允许" : "仅允许这一次");
  const onceHint = request.kind === "elicitation" ? "继续此工具请求" : "继续当前操作，不保存规则";
  const sessionLabel = request.decisionLabels?.acceptForSession || "本次会话始终允许";
  const sessionHint = request.decisionLabels ? "采用服务提供的权限范围" : "相同请求在本次会话中不再询问";
  const canChooseMode = decisions.has("accept") && decisions.has("acceptForSession");
  const activeMode: AllowMode = decisions.has("accept") ? (canChooseMode ? allowMode : "accept") : "acceptForSession";
  const allowLabel = activeMode === "accept" ? onceLabel : sessionLabel;
  const allowHint = activeMode === "accept" ? onceHint : sessionHint;
  const allowTestId = activeMode === "accept" ? "approval-once" : "approval-session";
  // The deny card is the peer of the allow card; cancel stays in the footer unless it is the only way out.
  const denyCard: ApprovalDecision | null = decisions.has("decline") ? "decline" : decisions.has("cancel") ? "cancel" : null;
  const footerCancel = denyCard === "decline" && decisions.has("cancel");

  return (
    <section className="approval-prompt" aria-labelledby="approval-title" data-testid="approval-prompt">
      <header className="approval-header">
        <span className="approval-mark" aria-hidden="true"><ShieldCheck size={18} /></span>
        <div>
          <span className="approval-kicker">需要你的确认</span>
          <h3 id="approval-title">{request.title || titleByKind[request.kind]}</h3>
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
      {request.kind === "permissions" && request.permissions && request.command && <details className="approval-details">
        <summary>请求详情</summary><pre>{JSON.stringify(request.permissions, null, 2)}</pre>
      </details>}
      {request.kind === "elicitation" && request.mode === "url" && !request.unsupportedReason ? (
        <p className="approval-reason">
          请先打开 <a href={request.url!} target="_blank" rel="noreferrer">{request.url}</a>，
          完成授权后再确认。
        </p>
      ) : null}
      {request.unsupportedReason ? (
        <p className="approval-error" role="alert">{request.unsupportedReason}</p>
      ) : null}

      <div className="approval-options">
        {decisions.has("accept") || decisions.has("acceptForSession") ? (
          <div className={`approval-option primary approval-allow ${menuOpen ? "menu-open" : ""}`} ref={menuRef}>
            <button
              className="approval-allow-main"
              type="button"
              disabled={pending}
              onClick={() => onResolve(activeMode)}
              data-testid={allowTestId}
            >
              <span>
                <strong>{allowLabel}</strong>
                <small>{allowHint}</small>
              </span>
              {pending ? <LoaderCircle className="approval-spinner" size={14} /> : <kbd>{activeMode === "accept" ? "1" : "2"}</kbd>}
            </button>
            {canChooseMode ? (
              <>
                <button
                  className="approval-allow-toggle"
                  type="button"
                  disabled={pending}
                  aria-label="选择允许方式"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((open) => !open)}
                  data-testid="approval-allow-menu"
                >
                  <ChevronDown size={16} />
                </button>
                {menuOpen ? (
                  <div className="approval-allow-options surface-popover" role="menu" aria-label="允许方式">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={activeMode === "accept"}
                      onClick={() => { setAllowMode("accept"); setMenuOpen(false); }}
                    >
                      <span><strong>{onceLabel}</strong><small>{onceHint}</small></span>
                      {activeMode === "accept" ? <Check size={14} /> : <kbd>1</kbd>}
                    </button>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={activeMode === "acceptForSession"}
                      onClick={() => { setAllowMode("acceptForSession"); setMenuOpen(false); }}
                      data-testid={activeMode === "accept" ? "approval-session-choice" : undefined}
                    >
                      <span><strong>{sessionLabel}</strong><small>{sessionHint}</small></span>
                      {activeMode === "acceptForSession" ? <Check size={14} /> : <kbd>2</kbd>}
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
        {denyCard ? (
          <button
            className="approval-option danger"
            type="button"
            disabled={pending}
            onClick={() => onResolve(denyCard)}
            data-testid={denyCard === "decline" ? "approval-deny" : "approval-cancel"}
          >
            <span>
              <strong>{denyCard === "decline" ? (request.decisionLabels?.decline || "拒绝") : "取消此次请求"}</strong>
              <small>{denyCard === "decline" ? "不执行这项操作" : "放弃等待，结束这次请求"}</small>
            </span>
            {footerCancel ? <X size={15} /> : <kbd>Esc</kbd>}
          </button>
        ) : null}
      </div>

      <footer className="approval-footer">
        {footerCancel ? (
          <button type="button" disabled={pending} onClick={() => onResolve("cancel")} data-testid="approval-cancel">
            取消此次请求
          </button>
        ) : <span />}
        <span className={error ? "approval-error" : ""}>
          {error || (request.cwd ? request.cwd : "请求暂停中")} {!error && footerCancel ? <kbd>Esc</kbd> : null}
        </span>
      </footer>
    </section>
  );
}
