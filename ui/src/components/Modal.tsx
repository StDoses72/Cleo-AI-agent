import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

export function handleDialogKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
  event.stopPropagation();
  if ((event.key === "Enter" || event.key === "Escape")
      && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) {
    event.preventDefault();
    return;
  }
  if (event.key !== "Tab") return;
  const dialog = event.currentTarget;
  if (event.target instanceof Element && event.target.closest("dialog") !== dialog) return;
  const targets = [...dialog.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")]
    .filter(element => element.tabIndex >= 0 && !element.matches(":disabled")
      && element.getClientRects().length > 0 && element.closest("dialog") === dialog);
  const first = targets[0];
  const last = targets.at(-1);
  if (!first) { event.preventDefault(); dialog.focus(); }
  else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
    event.preventDefault(); last?.focus();
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
    event.preventDefault(); first.focus();
  }
}

export function Modal({ open, onClose, className, label, labelledBy, describedBy, role = "dialog", children }: {
  open: boolean;
  onClose?: () => void;
  className: string;
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  role?: "dialog" | "alertdialog";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (open) dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, [open]);
  return <dialog ref={ref} className={`modal-backdrop ${className}`} role={role}
    aria-label={label} aria-labelledby={labelledBy} aria-describedby={describedBy}
    onCancel={event => { event.preventDefault(); onClose?.(); }}
    onKeyDown={handleDialogKeyDown}
    onMouseDown={event => { if (event.target === ref.current) onClose?.(); }}>
    {children}
  </dialog>;
}
