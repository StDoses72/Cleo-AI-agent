import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

interface Row { id: string }

export function VirtualTimeline<T extends Row>({ rows, viewport, follow, bottomInset = 0, threadId, render, onScroll }: {
  rows: T[]; viewport: RefObject<HTMLDivElement | null>; follow: RefObject<boolean>;
  bottomInset?: number;
  threadId: string; render: (row: T) => ReactNode; onScroll: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const observer = useRef<ResizeObserver | null>(null);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const previousThread = useRef(threadId);
  const programmaticScrollTop = useRef<number | null>(null);
  const observedScrollTop = useRef<number | null>(null);
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;
  const [, refresh] = useState(0);
  // Native scrolling can move the viewport before its scroll event reaches React.
  const unobservedScroll = (top: number) => observedScrollTop.current !== null
    && Math.abs(top - observedScrollTop.current) > 1
    && (programmaticScrollTop.current === null || Math.abs(top - programmaticScrollTop.current) > 1);
  const remember = useCallback(() => {
    if (follow.current || !viewport.current) return;
    const top = viewport.current.getBoundingClientRect().top;
    const bottom = viewport.current.getBoundingClientRect().bottom;
    const node = [...nodes.current.entries()].sort((a, b) => a[1].getBoundingClientRect().top - b[1].getBoundingClientRect().top)
      .find(([, element]) => element.getBoundingClientRect().bottom > top + 1 && element.getBoundingClientRect().top < bottom);
    anchor.current = node ? { id: node[0], top: node[1].getBoundingClientRect().top - top } : null;
  }, [follow, viewport]);

  // The parent viewport ref is available after the complete layout commit.
  useEffect(() => {
    const userScroll = () => {
      programmaticScrollTop.current = null;
      anchor.current = null;
    };
    const scroll = () => {
      const top = viewport.current?.scrollTop;
      if (top === undefined) return;
      const expected = programmaticScrollTop.current;
      programmaticScrollTop.current = null;
      observedScrollTop.current = top;
      if (expected === null || Math.abs(top - expected) > 1) { onScrollRef.current(); remember(); }
      refresh(value => value + 1);
    };
    const element = viewport.current;
    element?.addEventListener("scroll", scroll);
    element?.addEventListener("wheel", userScroll, { passive: true });
    element?.addEventListener("pointerdown", userScroll);
    element?.addEventListener("keydown", userScroll);
    return () => {
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
    heights.current.clear(); anchor.current = null; follow.current = true;
    observedScrollTop.current = null; programmaticScrollTop.current = null;
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
  let scrollTop = Math.max(0, (view?.scrollTop ?? 0) - containerTop);
  const anchorIndex = anchor.current ? rows.findIndex(row => row.id === anchor.current!.id) : -1;
  if (!unobservedScroll(view?.scrollTop ?? 0)) {
    if (follow.current) scrollTop = Math.max(0, offsets.at(-1)! - height);
    else if (anchorIndex >= 0) scrollTop = Math.max(0, offsets[anchorIndex] - anchor.current!.top);
  }
  let first = 0;
  while (first < rows.length - 1 && offsets[first + 1] < scrollTop) first++;
  let end = first;
  while (end < rows.length && offsets[end] < scrollTop + height) end++;
  first = Math.max(0, first - 4);
  end = Math.min(rows.length, end + 4);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const previousTop = element.scrollTop;
    if (unobservedScroll(previousTop)) { anchor.current = null; onScrollRef.current(); }
    if (follow.current) element.scrollTop = element.scrollHeight;
    else if (anchor.current) {
      const node = nodes.current.get(anchor.current.id);
      if (node) element.scrollTop += node.getBoundingClientRect().top
        - element.getBoundingClientRect().top - anchor.current.top;
    }
    if (element.scrollTop !== previousTop) programmaticScrollTop.current = element.scrollTop;
    observedScrollTop.current = element.scrollTop;
    if (!follow.current && !anchor.current) remember();
  });

  return <div className="timeline virtual-timeline" ref={container} data-testid="timeline"
    data-mounted-count={end - first} data-row-count={rows.length}>
    <div aria-hidden="true" style={{ height: offsets[first] }} />
    {rows.slice(first, end).map(row => <MeasuredRow key={row.id} id={row.id} nodes={nodes.current} observer={observer.current}>
      {render(row)}
    </MeasuredRow>)}
    <div aria-hidden="true" style={{ height: offsets.at(-1)! - offsets[end] }} />
  </div>;
}

function MeasuredRow({ id, children, nodes, observer }: {
  id: string; children: ReactNode; nodes: Map<string, HTMLDivElement>; observer: ResizeObserver | null;
}) {
  const ref = useCallback((node: HTMLDivElement | null) => {
    const previous = nodes.get(id);
    if (previous) observer?.unobserve(previous);
    if (node) { nodes.set(id, node); observer?.observe(node); } else nodes.delete(id);
  }, [id, nodes, observer]);
  return <div ref={ref} data-row-id={id} className="virtual-timeline-row">{children}</div>;
}
