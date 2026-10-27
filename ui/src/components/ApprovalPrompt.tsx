import { t as tr } from "../../electron/i18n.mjs";
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
  get command() { return tr("approvalprompt.cleo_wants_to_run_a_protected_command"); },
  get file_change() { return tr("approvalprompt.cleo_wants_to_modify_protected_files"); },
  get permissions() { return tr("approvalprompt.cleo_requests_additional_permissions"); },
  get elicitation() { return tr("approvalprompt.a_tool_needs_your_authorization"); },
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
    || (request.permissions ? JSON.stringify(request.permissions) : tr("approvalprompt.waiting_for_confirmation_to_continue"));
  const reason = request.reason || (
    request.kind === "command"
      ? tr("approvalprompt.this_command_needs_access_beyond_the_current_sandbox_or_to_a_protected_area_confirm_t")
      : request.kind === "file_change"
        ? tr("approvalprompt.this_file_change_is_outside_the_write_access_granted_to_the_current_session")
        : tr("approvalprompt.the_current_service_needs_your_confirmation")
  );

  const onceLabel = request.decisionLabels?.accept
    || (request.mode === "url" ? tr("approvalprompt.authorization_completed") : request.kind === "elicitation" ? tr("approvalprompt.allow") : tr("approvalprompt.allow_once"));
  const onceHint = request.kind === "elicitation" ? tr("approvalprompt.continue_this_tool_request") : tr("approvalprompt.continue_without_saving_a_rule");
  const sessionLabel = request.decisionLabels?.acceptForSession || tr("approvalprompt.always_allow_in_this_session");
  const sessionHint = request.decisionLabels ? tr("approvalprompt.use_the_scope_provided_by_the_service") : tr("approvalprompt.do_not_ask_again_for_matching_requests_in_this_session");
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
          <span className="approval-kicker">{tr("approvalprompt.your_confirmation_is_required")}</span>
          <h3 id="approval-title">{request.title || titleByKind[request.kind]}</h3>
        </div>
        <span className="approval-context" title={request.cwd || request.method}>
          <GitBranch size={12} />{request.kind === "command" ? tr("approvalprompt.command") : request.kind === "file_change" ? tr("approvalprompt.file") : tr("approvalprompt.permissions")}
        </span>
      </header>

      <div className="approval-command">
        <Terminal size={14} aria-hidden="true" />
        <code>{detail}</code>
      </div>

      <p className="approval-reason">{reason}</p>
      {request.kind === "permissions" && request.permissions && request.command && <details className="approval-details">
        <summary>{tr("approvalprompt.request_details")}</summary><pre>{JSON.stringify(request.permissions, null, 2)}</pre>
      </details>}
      {request.kind === "elicitation" && request.mode === "url" && !request.unsupportedReason ? (
        <p className="approval-reason">
          {tr("approvalprompt.first_open")}<a href={request.url!} target="_blank" rel="noreferrer">{request.url}</a>{tr("approvalprompt.complete_authorization_then_confirm")}</p>
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
                  aria-label={tr("approvalprompt.choose_how_to_allow")}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((open) => !open)}
                  data-testid="approval-allow-menu"
                >
                  <ChevronDown size={16} />
                </button>
                {menuOpen ? (
                  <div className="approval-allow-options surface-popover" role="menu" aria-label={tr("approvalprompt.permission_scope")}>
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
              <strong>{denyCard === "decline" ? (request.decisionLabels?.decline || tr("approvalprompt.deny")) : tr("approvalprompt.cancel_this_request")}</strong>
              <small>{denyCard === "decline" ? tr("approvalprompt.do_not_perform_this_operation") : tr("approvalprompt.stop_waiting_and_end_this_request")}</small>
            </span>
            {footerCancel ? <X size={15} /> : <kbd>Esc</kbd>}
          </button>
        ) : null}
      </div>

      <footer className="approval-footer">
        {footerCancel ? (
          <button type="button" disabled={pending} onClick={() => onResolve("cancel")} data-testid="approval-cancel">
            {tr("approvalprompt.cancel_this_request")}</button>
        ) : <span />}
        <span className={error ? "approval-error" : ""}>
          {error || (request.cwd ? request.cwd : tr("approvalprompt.request_paused"))} {!error && footerCancel ? <kbd>Esc</kbd> : null}
        </span>
      </footer>
    </section>
  );
}
