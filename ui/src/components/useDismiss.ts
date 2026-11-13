import { useEffect, type RefObject } from "react";

/** Close a popover on a click outside it or on Escape, handing focus back to its trigger. */
export function useDismiss(open: boolean, close: () => void, wrap: RefObject<HTMLElement | null>, trigger: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const inside = wrap.current?.contains(document.activeElement);
      close();
      if (inside) { event.preventDefault(); event.stopPropagation(); trigger.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
}
