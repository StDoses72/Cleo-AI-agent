import { t as tr } from "../../electron/i18n.mjs";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { normalizeMath } from "../markdown-math";
import { ChevronDown, ChevronRight, CircleAlert, Copy, ExternalLink, File, FolderClosed, FolderOpen, Globe, RefreshCw } from "lucide-react";
import type { WorkspaceEntry, WorkspaceFilePreview } from "../computer-types";
import "./files-panel.css";

export interface FileReveal { path: string; line: number | null; nonce: number }

interface Listing { entries: WorkspaceEntry[]; truncated: boolean; error?: string }

const MAX_LINES = 4000;
const MIN_TREE_HEIGHT = 80;
const MIN_PREVIEW_HEIGHT = 120;
const DIVIDER_HEIGHT = 18;

function joinPath(root: string, relative: string) {
  const separator = root.includes("\\") ? "\\" : "/";
  return relative ? `${root.replace(/[\\/]+$/, "")}${separator}${relative.split("/").join(separator)}` : root;
}

function size(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FilesPanel({ root, threadId = null, reveal, onNotify, onCopyText, onOpenExternal, onOpenBrowser }: {
  root: string | null;
  /** The conversation whose built-in browser previews open in. */
  threadId?: string | null;
  reveal: FileReveal | null;
  onNotify: (message: string) => void;
  onCopyText: (value: string) => void;
  onOpenExternal: (absolutePath: string) => void;
  onOpenBrowser: () => void;
}) {
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [selected, setSelected] = useState<string>("");
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null);
  const [error, setError] = useState("");
  const [line, setLine] = useState<number | null>(null);
  const highlighted = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dividerDrag = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const [draggingDivider, setDraggingDivider] = useState(false);
  const [treeHeight, setTreeHeight] = useState<number | null>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const files = window.cleoDesktop?.files;

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const observer = new ResizeObserver(() => setPanelHeight(panel.clientHeight));
    observer.observe(panel);
    setPanelHeight(panel.clientHeight);
    return () => observer.disconnect();
  }, [root]);

  /** Purpose: Keep both file navigation and the preview usable while dragging the divider. */
  const limitTreeHeight = (height: number) => {
    const available = panelRef.current?.clientHeight ?? 0;
    return Math.max(MIN_TREE_HEIGHT, Math.min(height, Math.max(MIN_TREE_HEIGHT, available - MIN_PREVIEW_HEIGHT - DIVIDER_HEIGHT)));
  };

  const onDividerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !panelRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dividerDrag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: panelRef.current.querySelector(".files-tree")?.getBoundingClientRect().height ?? 0,
    };
    setDraggingDivider(true);
  };
  const onDividerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dividerDrag.current?.pointerId !== event.pointerId) return;
    setTreeHeight(limitTreeHeight(dividerDrag.current.startHeight + event.clientY - dividerDrag.current.startY));
  };
  const onDividerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = panelRef.current?.querySelector(".files-tree")?.getBoundingClientRect().height ?? 0;
    const next = event.key === "ArrowUp" ? current - 20 : event.key === "ArrowDown" ? current + 20
      : event.key === "Home" ? MIN_TREE_HEIGHT : event.key === "End" ? Number.MAX_SAFE_INTEGER : null;
    if (next === null) return;
    event.preventDefault();
    setTreeHeight(limitTreeHeight(next));
  };

  const load = useCallback(async (path: string) => {
    if (!root || !files) return;
    try {
      const listing = await files<{ entries: WorkspaceEntry[]; truncated: boolean }>("list", { root, path });
      setListings(current => ({ ...current, [path]: listing }));
    } catch (cause) {
      setListings(current => ({ ...current, [path]: { entries: [], truncated: false, error: cause instanceof Error ? cause.message : tr("filespanel.could_not_read_the_folder") } }));
    }
  }, [root, files]);

  const open = useCallback(async (path: string, targetLine: number | null = null) => {
    if (!root || !files) return;
    setSelected(path); setLine(targetLine); setError("");
    try { setPreview(await files<WorkspaceFilePreview>("read", { root, path })); }
    catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : tr("filespanel.could_not_preview_the_file")); }
  }, [root, files]);

  useEffect(() => {
    setListings({}); setExpanded(new Set([""])); setSelected(""); setPreview(null); setError("");
    if (root) void load("");
  }, [root, load]);

  // Reveal a file chosen from a chat link: expand its folders, then preview it.
  useEffect(() => {
    if (!reveal || !root) return;
    const parts = reveal.path.split("/");
    const folders = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
    setExpanded(current => new Set([...current, "", ...folders]));
    for (const folder of folders) void load(folder);
    void open(reveal.path, reveal.line);
  }, [reveal, root, load, open]);

  useEffect(() => { highlighted.current?.scrollIntoView({ block: "center" }); }, [preview, line]);

  const toggle = (path: string) => {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else { next.add(path); if (!listings[path]) void load(path); }
      return next;
    });
  };

  const openInBrowser = async () => {
    if (!root || !preview) return;
    try { await window.cleoDesktop?.computer?.("preview", { root, path: preview.path, threadId }); onOpenBrowser(); }
    catch (cause) { onNotify(cause instanceof Error ? cause.message : tr("filespanel.could_not_open_in_the_built_in_browser")); }
  };

  const lines = useMemo(() => (preview?.text ?? "").split(/\r?\n/).slice(0, MAX_LINES), [preview?.text]);

  if (!root) {
    return <div className="inspector-empty"><FolderClosed size={22} /><strong>{tr("filespanel.no_working_directory")}</strong><span>{tr("filespanel.choose_a_project_folder_for_this_task_to_browse_and_preview_its_files_here")}</span></div>;
  }
  if (!files) {
    return <div className="inspector-empty"><CircleAlert size={22} /><strong>{tr("filespanel.file_sidebar_unavailable")}</strong><span>{tr("filespanel.use_this_feature_in_the_cleo_desktop_app")}</span></div>;
  }

  const renderTree = (path: string, depth: number): React.ReactNode => {
    const listing = listings[path];
    if (!listing) return <p className="files-tree-note" style={{ paddingLeft: 10 + depth * 12 }}>{tr("filespanel.loading")}</p>;
    if (listing.error) return <p className="files-tree-note error" style={{ paddingLeft: 10 + depth * 12 }}>{listing.error}</p>;
    return <>
      {listing.entries.map(entry => {
        const isOpen = expanded.has(entry.path);
        return <div key={entry.path}>
          <button type="button" className={`files-tree-row ${selected === entry.path ? "active" : ""}`} style={{ paddingLeft: 8 + depth * 12 }}
            title={entry.path} onClick={() => entry.kind === "directory" ? toggle(entry.path) : void open(entry.path)}>
            {entry.kind === "directory" ? <>{isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{isOpen ? <FolderOpen size={13} /> : <FolderClosed size={13} />}</>
              : <><span className="files-tree-spacer" /><File size={13} /></>}
            <span>{entry.name}</span>
          </button>
          {entry.kind === "directory" && isOpen && renderTree(entry.path, depth + 1)}
        </div>;
      })}
      {listing.truncated && <p className="files-tree-note" style={{ paddingLeft: 10 + depth * 12 }}>{tr("filespanel.showing_the_first_2_000_items_only")}</p>}
    </>;
  };

  return <div className={`files-panel ${draggingDivider ? "is-resizing" : ""}`} ref={panelRef} style={treeHeight === null ? undefined : { "--files-tree-height": `${Math.min(treeHeight, Math.max(MIN_TREE_HEIGHT, panelHeight - MIN_PREVIEW_HEIGHT - DIVIDER_HEIGHT))}px` } as CSSProperties}>
    <div className="files-tree" aria-label={tr("filespanel.working_directory_files")}>
      <div className="files-tree-header"><span title={root}>{root.split(/[\\/]/).filter(Boolean).at(-1) ?? root}</span>
        <button className="icon-button" type="button" aria-label={tr("filespanel.refresh_file_list")} onClick={() => { setListings({}); for (const path of expanded) void load(path); }}><RefreshCw size={13} /></button></div>
      {renderTree("", 0)}
    </div>
    <div className="files-divider" role="separator" tabIndex={0} aria-label={preview?.kind === "pdf" ? tr("filespanel.drag_vertically_to_resize_the_pdf_preview") : tr("filespanel.drag_vertically_to_resize_the_file_preview")}
      title={tr("filespanel.drag_vertically_to_resize_the_preview")} aria-orientation="horizontal"
      aria-valuemin={MIN_TREE_HEIGHT} aria-valuemax={Math.max(MIN_TREE_HEIGHT, panelHeight - MIN_PREVIEW_HEIGHT - DIVIDER_HEIGHT)}
      aria-valuenow={Math.round(treeHeight ?? panelHeight * .38)}
      onPointerDown={onDividerDown} onPointerMove={onDividerMove}
      onPointerUp={() => { dividerDrag.current = null; setDraggingDivider(false); }} onPointerCancel={() => { dividerDrag.current = null; setDraggingDivider(false); }}
      onLostPointerCapture={() => { dividerDrag.current = null; setDraggingDivider(false); }} onKeyDown={onDividerKeyDown}>
      <span aria-hidden="true">{tr("filespanel.drag_vertically_to_resize_the_preview")}</span>
    </div>
    <div className="files-preview">
      {error && <p className="computer-panel-error"><CircleAlert size={14} />{error}</p>}
      {!preview && !error && <div className="inspector-empty"><File size={22} /><strong>{tr("filespanel.select_a_file_to_preview")}</strong><span>{tr("filespanel.file_links_in_the_conversation_also_locate_files_here")}</span></div>}
      {preview && <>
        <header className="files-preview-header">
          <span title={preview.path}>{preview.path}</span><small>{size(preview.size)}</small>
          {["html", "pdf", "image", "markdown", "text"].includes(preview.kind) && <button type="button" className="icon-button" aria-label={tr("filespanel.open_in_the_built_in_browser")} title={tr("filespanel.open_in_the_built_in_browser")} onClick={() => void openInBrowser()}><Globe size={14} /></button>}
          <button type="button" className="icon-button" aria-label={tr("filespanel.open_in_the_system_application")} title={tr("filespanel.open_in_the_system_application")} onClick={() => onOpenExternal(joinPath(root, preview.path))}><ExternalLink size={14} /></button>
          <button type="button" className="icon-button" aria-label={tr("filespanel.copy_path")} title={tr("filespanel.copy_path")} onClick={() => { onCopyText(joinPath(root, preview.path)); onNotify(tr("filespanel.file_path_copied")); }}><Copy size={14} /></button>
        </header>
        {preview.kind === "image" && <div className="files-image"><img src={preview.url} alt={preview.path} /></div>}
        {preview.kind === "pdf" && <iframe className="files-pdf" title={preview.path} src={preview.url} />}
        {preview.kind === "binary" && <div className="inspector-empty"><File size={22} /><strong>{tr("filespanel.binary_file")}</strong><span>{tr("filespanel.a_text_preview_is_unavailable_open_it_in_a_system_application")}</span></div>}
        {preview.kind === "markdown" && <div className="files-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore", errorColor: "#c96b63" }]]} urlTransform={(url) => {
            if (/^(https?:|mailto:|#)/i.test(url)) return url;
            try { return new URL(url, preview.url).href; } catch { return ""; }
          }} components={{ a: ({ node: _node, href, children, ...props }) => <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a> }}>
            {normalizeMath(preview.text ?? "")}</ReactMarkdown>
        </div>}
        {(preview.kind === "text" || preview.kind === "html") && <>
          {preview.kind === "html" && <p className="computer-panel-hint">{tr("filespanel.html_source_click")}<Globe size={11} /> {tr("filespanel.to_preview_the_page_in_the_built_in_browser")}</p>}
          <pre className="files-code" tabIndex={0} aria-label={tr("filespanel.file_contents")}>{lines.map((text, index) => <span key={index} ref={line === index + 1 ? highlighted : undefined}
            className={line === index + 1 ? "target" : ""}><i>{index + 1}</i><code>{text || " "}</code></span>)}</pre>
          {(preview.truncated || (preview.text ?? "").split(/\r?\n/).length > MAX_LINES) && <p className="computer-panel-hint">{tr("filespanel.this_file_is_large_only_its_beginning_is_shown")}</p>}
        </>}
      </>}
    </div>
  </div>;
}
