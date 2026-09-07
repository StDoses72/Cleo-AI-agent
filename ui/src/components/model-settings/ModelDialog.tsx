import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function ModelDialog({ title, onClose, onEscape, children }: {
  title: string; onClose: () => void; onEscape?: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (!dialog.open) dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return <dialog ref={ref} className="model-settings model-dialog" aria-label={title}
    onKeyDown={event => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); (onEscape || onClose)();
      }
    }}
    onMouseDown={event => {
      event.stopPropagation();
      if (event.target === ref.current) {
        const rect = ref.current!.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }
    }} onCancel={event => { event.preventDefault(); (onEscape || onClose)(); }}>
    <header className="ms-dialog-heading"><h2>{title}</h2><button className="ms-icon" aria-label={`关闭${title}`} onClick={onClose}><X /></button></header>
    {children}
  </dialog>;
}
