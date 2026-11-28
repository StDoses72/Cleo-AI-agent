import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

interface Row { id: string }

export function VirtualTimeline<T extends Row>({ rows, viewport, follow, bottomInset = 0, threadId, render, onScroll, footer }: {
  rows: T[]; viewport: RefObject<HTMLDivElement | null>; follow: RefObject<boolean>;
  bottomInset?: number;
  footer?: ReactNode;
  /** `onScroll` reports the reader moving the view, by how many pixels (negative is up). */
  threadId: string; render: (row: T) => ReactNode; onScroll: (delta: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const observer = useRef<ResizeObserver | null>(null);
  // The reading position: the rows in view, top to bottom, each with its distance from the top of
  // the view. The first one still loaded is held in place when the rows around it change.
  const anchor = useRef<{ id: string; top: number }[]>([]);
  const previousThread = useRef(threadId);
  // The position this component last saw or set. Anything else is the reader's scrolling.
  const observedScrollTop = useRef<number | null>(null);
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;
  const [, refresh] = useState(0);
  // Native scrolling can move the viewport before its scroll event reaches React.
  const unobservedScroll = (top: number) => observedScrollTop.current !== null
    && Math.abs(top - observedScrollTop.current) > 1;
  const visibleRows = useCallback(() => {
    if (!viewport.current) return [];
    const { top, bottom } = viewport.current.getBoundingClientRect();
    const seen: { id: string; top: number }[] = [];
    for (const [id, element] of nodes.current) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom > top + 1 && rect.top < bottom) seen.push({ id, top: rect.top - top });
    }
    return seen.sort((a, b) => a.top - b.top);
  }, [viewport]);
  const remember = useCallback(() => {
    if (!follow.current) anchor.current = visibleRows();
  }, [follow, visibleRows]);

  // The parent viewport ref is available after the complete layout commit.
  useEffect(() => {
    let frame = 0;
    const userScroll = () => {
      anchor.current = [];
    };
    const updateScroll = () => {
      frame = 0;
      const top = viewport.current?.scrollTop;
      if (top === undefined) return;
      const previous = observedScrollTop.current;
      observedScrollTop.current = top;
      // The event also follows a position the layout pass set, and one the page moved to by
      // itself (it got shorter). Both were seen there; only a new position is the reader's.
      if (previous === null || Math.abs(top - previous) > 1) { onScrollRef.current(top - (previous ?? top)); remember(); }
      refresh(value => value + 1);
    };
    const scroll = () => { if (!frame) frame = requestAnimationFrame(updateScroll); };
    const element = viewport.current;
    element?.addEventListener("scroll", scroll);
    element?.addEventListener("wheel", userScroll, { passive: true });
    element?.addEventListener("pointerdown", userScroll);
    element?.addEventListener("keydown", userScroll);
    return () => {
      cancelAnimationFrame(frame);
      element?.removeEventListener("scroll", scroll);
      element?.removeEventListener("wheel", userScroll);
      element?.removeEventListener("pointerdown", userScroll);
      element?.removeEventListener("keydown", userScroll);
    };
  }, [viewport, remember]);

  useEffect(() => {
    observer.current = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        if (entry.target === viewport.current) { changed = true; continue; }
        const id = (entry.target as HTMLElement).dataset.rowId!;
        const height = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
        if (Math.abs((heights.current.get(id) ?? 120) - height) > 0.5) {
          heights.current.set(id, height); changed = true;
        }
      }
      if (changed) refresh(value => value + 1);
    });
    for (const node of nodes.current.values()) observer.current.observe(node);
    if (viewport.current) observer.current.observe(viewport.current);
    return () => observer.current?.disconnect();
  }, []);

  if (previousThread.current !== threadId) {
    heights.current.clear(); anchor.current = []; follow.current = true;
    observedScrollTop.current = null;
    previousThread.current = threadId;
  }
  const activeIds = new Set(rows.map(row => row.id));
  for (const id of heights.current.keys()) if (!activeIds.has(id)) heights.current.delete(id);
  const offsets = [0];
  for (const row of rows) offsets.push(offsets.at(-1)! + (heights.current.get(row.id) ?? 120));
  const view = viewport.current;
  const height = Math.max(1, (view?.clientHeight ?? 700) - bottomInset);
  const containerTop = view && container.current
    ? container.current.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop : 0;
  // Read before this render changes the page: a position nobody has seen yet is the reader's
  // scrolling. One that differs only after the change is the page moving, and is no input.
  const renderTop = view?.scrollTop ?? 0;
  const moved = unobservedScroll(renderTop);
  // With nothing remembered (input cleared it, or the reader moved), the rows are where the reader
  // sees them right now. Taken before the change, the layout pass undoes exactly what it moved.
  if (moved) anchor.current = visibleRows();
  else if (!follow.current && !anchor.current.length) anchor.current = visibleRows();
  let scrollTop = Math.max(0, renderTop - containerTop);
  // Paging can drop the rows at the top of the view; the next one down that is still loaded holds.
  const held = anchor.current.find(entry => activeIds.has(entry.id));
  const anchorIndex = held ? rows.findIndex(row => row.id === held.id) : -1;
  if (follow.current && !moved) scrollTop = Math.max(0, offsets.at(-1)! - height);
  else if (anchorIndex >= 0) scrollTop = Math.max(0, offsets[anchorIndex] - held!.top);
  let first = 0;
  while (first < rows.length - 1 && offsets[first + 1] < scrollTop) first++;
  let end = first;
  while (end < rows.length && offsets[end] < scrollTop + height) end++;
  first = Math.max(0, first - 4);
  end = Math.min(rows.length, end + 4);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const delta = moved ? renderTop - observedScrollTop.current! : 0;
    const node = held && nodes.current.get(held.id);
    // A reader who has just moved is where they put themselves, also away from the pinned end.
    if (follow.current && !moved) { element.scrollTop = element.scrollHeight; anchor.current = []; }
    else if (held && node) {
      const place = () => node.getBoundingClientRect().top - element.getBoundingClientRect().top;
      element.scrollTop += place() - held.top;
      // Rows above it are gone, or it cannot go back where it was (nothing is left above it): the
      // reading position is what the page shows now.
      if (held !== anchor.current[0] || Math.abs(place() - held.top) > 1) anchor.current = [];
    }
    observedScrollTop.current = element.scrollTop;
    // Reported with the rows back in place. Before that the page has already changed while the
    // position has not: the distances to its edges are not the ones the reader sees. What the
    // listener does to the page in turn is seen here as well.
    if (delta) { onScrollRef.current(delta); observedScrollTop.current = element.scrollTop; }
    if (!follow.current && !anchor.current.length) remember();
  });

  return <div className="timeline virtual-timeline" ref={container} data-testid="timeline"
    data-mounted-count={end - first} data-row-count={rows.length}>
    <div aria-hidden="true" style={{ height: offsets[first] }} />
    {rows.slice(first, end).map(row => <MeasuredRow key={row.id} row={row} render={render}
      nodes={nodes.current} observer={observer.current} />)}
    <div aria-hidden="true" style={{ height: offsets.at(-1)! - offsets[end] }} />
    {footer}
  </div>;
}

// Scroll frames move the rendered window. Only newly visible or changed rows need their markdown rendered.
function TimelineRow<T extends Row>({ row, render, nodes, observer }: {
  row: T; render: (row: T) => ReactNode; nodes: Map<string, HTMLDivElement>; observer: ResizeObserver | null;
}) {
  const id = row.id;
  const ref = useCallback((node: HTMLDivElement | null) => {
    const previous = nodes.get(id);
    if (previous) observer?.unobserve(previous);
    if (node) { nodes.set(id, node); observer?.observe(node); } else nodes.delete(id);
  }, [id, nodes, observer]);
  return <div ref={ref} data-row-id={id} className="virtual-timeline-row">{render(row)}</div>;
}

const MeasuredRow = memo(TimelineRow) as typeof TimelineRow;
