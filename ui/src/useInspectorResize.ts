import { useLayoutEffect, useEffect, useRef, useState, type CSSProperties, type PointerEvent, type KeyboardEvent } from "react";

/** Purpose: Resize the shared inspector without storing user data.
 * Input: layout changes and visibility. Output: bounded width and accessible drag-handle events.
 */
export function useInspectorResize(layoutKey: string, visible: boolean) {
  const [shell, setShell] = useState<HTMLDivElement | null>(null);
  const [preferredWidth, setPreferredWidth] = useState(370);
  const [bounds, setBounds] = useState({ min: 280, max: 600 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; width: number; target: HTMLDivElement } | null>(null);
  const clamp = (value: number) => Math.min(bounds.max, Math.max(bounds.min, value));
  const width = clamp(preferredWidth);

  useLayoutEffect(() => {
    if (!shell) return;
    const measure = () => {
      // Match the existing overlay breakpoint, leaving usable conversation space in either layout.
      const sidebar = window.innerWidth <= 1180 ? 0 : parseFloat(getComputedStyle(shell).getPropertyValue("--sidebar-width")) || 0;
      const available = Math.max(0, shell.clientWidth - 56 - sidebar);
      const max = Math.max(0, Math.floor(available - Math.min(360, available / 2)));
      setBounds({ min: Math.min(280, max), max });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [shell, layoutKey]);

  /** Purpose: End capture on release, cancellation, focus loss, or panel closure. */
  const stop = () => {
    const previous = drag.current;
    drag.current = null;
    setDragging(false);
    if (previous?.target.hasPointerCapture(previous.id)) previous.target.releasePointerCapture(previous.id);
  };
  useEffect(() => {
    window.addEventListener("blur", stop);
    return () => window.removeEventListener("blur", stop);
  }, []);
  useEffect(() => { if (!visible) stop(); }, [visible]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, width, target: event.currentTarget };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    setPreferredWidth(clamp(drag.current.width + drag.current.x - event.clientX));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 10;
    const next = { ArrowLeft: width + step, ArrowRight: width - step, Home: bounds.min, End: bounds.max }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setPreferredWidth(clamp(next));
  };

  return { setShell, dragging, style: { "--inspector-preferred-width": `${width}px` } as CSSProperties,
    handleProps: { role: "separator", tabIndex: 0, "aria-label": "调整检查器宽度", "aria-orientation": "vertical" as const,
      "aria-valuemin": bounds.min, "aria-valuemax": bounds.max, "aria-valuenow": width,
      onPointerDown, onPointerMove, onPointerUp: stop, onPointerCancel: stop, onLostPointerCapture: stop, onKeyDown } };
}
