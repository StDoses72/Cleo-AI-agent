import { t as tr } from "../../electron/i18n.mjs";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Check,
  Circle,
  CircleAlert,
  CircleCheck,
  Clock3,
  Copy,
  Cpu,
  FileCode2,
  FolderOpen,
  GitBranch,
  Maximize2,
  MessageSquare,
  Minimize2,
  RotateCcw,
  ShieldCheck,
  Terminal,
  X,
  FolderMinus,
} from "lucide-react";
import type { ChangeFile, MemoryEntry, Project, RuntimeProfile, RuntimeUpdate, Thread } from "../types";
import { accessLabel, approvalLabel, effortLabels, isGeneralProject, projectLabel, projectPathLabel } from "../runtime-labels";
import { TaskTokenUsage } from "./TaskTokenUsage";
import { ContextUsage } from "./ContextUsage";
import { ComputerPanel } from "./ComputerPanel";
import { FilesPanel, type FileReveal } from "./FilesPanel";
import { BranchHoldNotice, CommentForm, ReviewCommentsBar, SourceControlRow, type BranchHold, type ReviewComment, type RunSourceControl } from "./ReviewActions";
import { RuntimePermissions } from "./Overlays";

/** "details" holds what used to be two tabs (run output and context); the old ids still open it. */
export type InspectorTab = "changes" | "details" | "files" | "computer";

interface InspectorProps {
  running: boolean;
  onStop: () => void;
  resizeHandle?: ReactNode;
  thread: Thread | null;
  project: Project | null;
  runtime: RuntimeProfile;
  memories: MemoryEntry[];
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  onClose: () => void;
  onNotify: (message: string, tone?: "success" | "error") => void;
  onCopyText: (value: string) => void;
  onRevealPath: (value: string) => void;
  fileReveal?: FileReveal | null;
  /** Select this changed file in the Changes tab (the nonce makes a repeat request count). */
  changeReveal?: { path: string; nonce: number } | null;
  /** Git actions bound to the task's folder; absent where the task has no repository. */
  runSourceControl?: RunSourceControl;
  reviewComments?: ReviewComment[];
  /** Set while review notes wait for git and the workspace to agree on the branch. */
  branchHold?: BranchHold;
  onAddReviewComment?: (comment: Omit<ReviewComment, "id">) => void;
  onRemoveReviewComment?: (id: string) => void;
  onSendReviewComments?: () => void;
  onClearReviewComments?: () => void;
  /** Save this task's file access / approval; absent where permissions are not editable. */
  onPermissionsChange?: (threadId: string, update: RuntimeUpdate) => Promise<void>;
  onOpenExternalPath?: (absolutePath: string) => void;
  /** Open a changed file in the Files tab. */
  onOpenFile?: (path: string) => void;
  /** Revert the latest reply's file changes; shown only when the thread allows it. */
  onUndo?: () => void;
  undoing?: boolean;
  /** The built-in browser / computer view exists only in the desktop app. */
  computerAvailable?: boolean;
  /** Another conversation is running in this task's checkout, so git actions wait. */
  sourceBusy?: boolean;
  /** The panel is at its widest; the toggle switches between that and the previous width. */
  wide?: boolean;
  onToggleWide?: () => void;
}

/** Purpose: The details pane beside a conversation: what changed, the project's files, what the run
 * is doing and using, and (in the desktop app) the live browser or computer view.
 */
export function Inspector({
  running,
  onStop,
  resizeHandle,
  thread,
  project,
  runtime,
  memories,
  activeTab,
  onTabChange,
  onClose,
  onNotify,
  onCopyText,
  onRevealPath,
  fileReveal = null,
  changeReveal = null,
  onOpenExternalPath,
  onOpenFile,
  onUndo,
  undoing = false,
  computerAvailable = false,
  sourceBusy = false,
  runSourceControl,
  reviewComments = [],
  branchHold,
  onAddReviewComment,
  onRemoveReviewComment,
  onSendReviewComments,
  onClearReviewComments,
  onPermissionsChange,
  wide = false,
  onToggleWide,
}: InspectorProps) {
  const tabs: { id: InspectorTab; label: string; count?: number }[] = [
    { id: "changes", label: tr("inspector.changes"), count: thread?.changes.length || undefined },
    ...(window.cleoDesktop?.files || activeTab === "files" ? [{ id: "files" as const, label: tr("approvalprompt.file") }] : []),
    { id: "details", label: tr("inspector.details") },
    ...(computerAvailable || activeTab === "computer" ? [{ id: "computer" as const, label: tr("inspector.computer") }] : []),
  ];
  return (
    <aside className="inspector" data-testid="inspector" aria-label={tr("inspector.details_panel")}>
      {resizeHandle}
      <header className="inspector-header">
        <div className="inspector-tabs" role="tablist" aria-label={tr("inspector.details_panel")} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const index = tabs.findIndex(tab => tab.id === activeTab);
          const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
          onTabChange(tabs[next].id);
          (event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next])?.focus();
        }}>
          {tabs.map(tab => (
            <button key={tab.id} id={`inspector-tab-${tab.id}`} className={activeTab === tab.id ? "active" : ""} type="button"
              role="tab" aria-selected={activeTab === tab.id} aria-controls="inspector-panel" data-tab={tab.id}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => onTabChange(tab.id)}>
              {tab.label}{tab.count ? <small>{tab.count}</small> : null}
            </button>
          ))}
        </div>
        {onToggleWide ? (
          // Wide review: the panel takes all the room the conversation can spare, and back.
          <button className="icon-button" type="button" aria-pressed={wide} data-testid="inspector-wide"
            aria-label={wide ? tr("inspector.restore_width") : tr("inspector.widen_for_review")}
            title={wide ? tr("inspector.restore_width") : tr("inspector.widen_for_review")} onClick={onToggleWide}>
            {wide ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        ) : null}
        <button className="icon-button" type="button" aria-label={tr("app.close_inspector")} title={tr("app.close_inspector")} onClick={onClose}><X size={16} /></button>
      </header>
      <div className="inspector-panel" id="inspector-panel" role="tabpanel" aria-labelledby={`inspector-tab-${activeTab}`}>
        {activeTab === "computer" ? (
          <ComputerPanel thread={thread} running={running} onStop={onStop} />
        ) : activeTab === "files" ? (
          <FilesPanel root={project?.path || null} threadId={thread?.id ?? null} reveal={fileReveal} onNotify={onNotify} onCopyText={onCopyText}
            onOpenExternal={(path) => (onOpenExternalPath ? onOpenExternalPath(path) : onRevealPath(path))}
            onOpenBrowser={() => onTabChange("computer")} />
        ) : activeTab === "changes" ? (
          <ChangesPanel thread={thread} repositoryPath={project?.path ?? ""} reveal={changeReveal} onNotify={onNotify} onCopyText={onCopyText} onOpenFile={onOpenFile}
            onUndo={onUndo} undoing={undoing} running={running} sourceBusy={sourceBusy} runSourceControl={runSourceControl}
            comments={reviewComments} branchHold={branchHold} onAddComment={onAddReviewComment} onRemoveComment={onRemoveReviewComment}
            onSendComments={onSendReviewComments} onClearComments={onClearReviewComments} />
        ) : (
          <DetailsPanel thread={thread} project={project} runtime={runtime} memories={memories} onRevealPath={onRevealPath}
            onPermissionsChange={onPermissionsChange} />
        )}
      </div>
    </aside>
  );
}

interface DiffLine {
  kind: "added" | "deleted" | "hunk" | "context" | "meta";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

/** Purpose: Number a unified diff the way a reviewer reads it.
 * Input: the raw diff text. Output: one entry per line with the old and new file line numbers,
 * restarted at every `@@ -a,b +c,d @@` hunk header; headers and file metadata carry no numbers.
 */
export function numberDiff(diff: string): DiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  // Only lines inside a hunk are source lines; file headers, mode and rename lines and binary
  // notices before the first hunk carry no numbers and take no review notes.
  let inHunk = false;
  return diff.split("\n").map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      return { kind: "hunk", text, oldLine: null, newLine: null };
    }
    if (text.startsWith("diff --git")) inHunk = false;
    if (!inHunk || /^(diff --git|index |--- |\+\+\+ |\\ )/.test(text)) return { kind: "meta", text, oldLine: null, newLine: null };
    if (text.startsWith("+")) return { kind: "added", text, oldLine: null, newLine: newLine++ };
    if (text.startsWith("-")) return { kind: "deleted", text, oldLine: oldLine++, newLine: null };
    return { kind: "context", text, oldLine: oldLine++, newLine: newLine++ };
  });
}

/** Purpose: A short fingerprint of a file's diff (FNV-1a), so a review note knows which version of
 * the change it was written on. */
export function diffFingerprint(diff: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < diff.length; index += 1) {
    hash ^= diff.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Purpose: The fingerprint of the hunk that contains one reviewed line, so a note is tied to that
 * piece of the change rather than to the whole file.
 * Input: the file's diff and the note's side, line and line text. Output: the hunk's fingerprint, or
 * null when no line with that number and text exists any more. */
export function hunkFingerprintAt(diff: string, side: "old" | "new", line: number, excerpt: string) {
  const lines = numberDiff(diff);
  const index = lines.findIndex((entry) => (side === "new" ? entry.newLine : entry.oldLine) === line
    && (entry.newLine !== null ? "new" : "old") === side && entry.text === excerpt);
  return index < 0 ? null : hunkFingerprintOfIndex(lines, index);
}

/** Notes record hunk fingerprints with this prefix. Round-7 notes carry a whole-file fingerprint
 * without it, which cannot be compared with a hunk's, so those read as "version not checked". */
const HUNK_FINGERPRINT = "h1:";
function hasHunkFingerprint(note: ReviewComment) {
  return Boolean(note.diffHash?.startsWith(HUNK_FINGERPRINT));
}

function hunkFingerprintOfIndex(lines: DiffLine[], index: number) {
  let start = index;
  while (start > 0 && lines[start].kind !== "hunk") start -= 1;
  let end = index + 1;
  while (end < lines.length && lines[end].kind !== "hunk" && !lines[end].text.startsWith("diff --git")) end += 1;
  return HUNK_FINGERPRINT + diffFingerprint(lines.slice(start, end).map((entry) => entry.text).join("\n"));
}

/** Purpose: Whether a note still sits on the version of the change it was written on.
 * Output: "current", "changed" (the line reads the same but its hunk changed), or "unverified"
 * (an older note without a fingerprint). */
export function noteVersion(note: ReviewComment, diff: string | undefined): "current" | "changed" | "unverified" {
  if (!hasHunkFingerprint(note)) return "unverified";
  if (diff === undefined) return "changed";
  return hunkFingerprintAt(diff, note.side, note.line, note.excerpt) === note.diffHash ? "current" : "changed";
}

/** Purpose: One hunk of a file's change as a patch git can apply in reverse.
 * Input: the changed file and which hunk. Output: the file's diff header (everything before its
 * first hunk; synthesized when the diff has none) followed by that hunk alone. */
export function hunkPatch(file: ChangeFile, hunkIndex: number): string {
  const lines = file.diff.replace(/\r\n/g, "\n").split("\n");
  const starts = lines.flatMap((line, index) => (line.startsWith("@@") ? [index] : []));
  const start = starts[hunkIndex];
  if (start === undefined) return "";
  const end = starts[hunkIndex + 1] ?? lines.length;
  let header = lines.slice(0, starts[0]);
  if (!header.some((line) => line.startsWith("diff --git"))) {
    header = [`diff --git a/${file.path} b/${file.path}`,
      file.status === "added" ? "--- /dev/null" : `--- a/${file.path}`,
      file.status === "deleted" ? "+++ /dev/null" : `+++ b/${file.path}`];
  }
  return [...header, ...lines.slice(start, end)].join("\n").replace(/\n*$/, "\n");
}

/** How much of each preference the backend records for a turn, in code points (Python slicing in
 * cleo/harnesses/service.py), so lengths are compared as code points too. */
const MEMORY_EXCERPT_LIMIT = 160;

/** Purpose: Compare what a turn was given with the memory library's text now.
 * Input: the recorded text (the backend keeps up to 160 characters of each preference) and the
 * library's current text, if the entry still exists.
 * Output: "changed" when they differ; "partial" only when the library's text runs past a full-length
 * record, so the rest cannot be compared; otherwise "same" ("missing" without a library entry).
 */
export function compareRecordedMemory(recorded: string, saved: string | undefined) {
  if (saved === undefined) return "missing" as const;
  // A shorter record is the whole preference, so any difference (an added sentence too) counts.
  if ([...recorded].length < MEMORY_EXCERPT_LIMIT) return saved === recorded ? "same" as const : "changed" as const;
  if (!saved.startsWith(recorded)) return "changed" as const;
  return [...saved].length > [...recorded].length ? "partial" as const : "same" as const;
}

/** The last changes-card request the Changes tab acted on (the tab remounts when switched to). */
let appliedChangeReveal = 0;

function ChangesPanel({ thread, repositoryPath, reveal = null, onNotify, onCopyText, onOpenFile, onUndo, undoing, running, sourceBusy, runSourceControl,
  comments, branchHold, onAddComment, onRemoveComment, onSendComments, onClearComments }: {
  thread: Thread | null;
  /** The task's folder: the branch row restarts when the task moves to another repository. */
  repositoryPath: string;
  reveal?: { path: string; nonce: number } | null;
  onNotify: (message: string, tone?: "success" | "error") => void;
  onCopyText: (value: string) => void;
  onOpenFile?: (path: string) => void;
  onUndo?: () => void;
  undoing: boolean;
  running: boolean;
  sourceBusy: boolean;
  runSourceControl?: RunSourceControl;
  comments: ReviewComment[];
  branchHold?: BranchHold;
  onAddComment?: (comment: Omit<ReviewComment, "id">) => void;
  onRemoveComment?: (id: string) => void;
  onSendComments?: () => void;
  onClearComments?: () => void;
}) {
  const [reverting, setReverting] = useState<string | null>(null);
  const revertFile = async (path: string) => {
    if (!runSourceControl || !window.confirm(tr("review.revert_file_confirm", { p0: path }))) return;
    setReverting(path);
    try {
      await runSourceControl("revertFile", { path });
      onNotify(tr("review.file_reverted_value", { p0: path }));
    } catch (error) {
      onNotify(error instanceof Error ? error.message : tr("app.operation_failed"), "error");
    } finally { setReverting(null); }
  };
  /** Undo one hunk of the selected file (after confirmation); git refuses a hunk that no longer matches. */
  const revertHunk = async (path: string, patch: string) => {
    if (!runSourceControl || !window.confirm(tr("review.revert_hunk_confirm", { p0: path }))) return;
    setReverting(path);
    try {
      await runSourceControl("revertHunk", { patch });
      onNotify(tr("review.hunk_reverted", { p0: path }));
    } catch (error) {
      onNotify(error instanceof Error ? error.message : tr("app.operation_failed"), "error");
    } finally { setReverting(null); }
  };
  const [selectedSetId, setSelectedSetId] = useState("workspace");
  const history = thread?.changeHistory ?? [];
  const selectedSet = history.find((changeSet) => changeSet.id === selectedSetId);
  const changes = selectedSet?.changes ?? thread?.changes ?? [];
  const [selectedPath, setSelectedPath] = useState(changes[0]?.path ?? "");
  useEffect(() => {
    setSelectedSetId("workspace");
  }, [thread?.id]);
  useEffect(() => {
    setSelectedPath((current) => (
      changes.some((file) => file.path === current) ? current : changes[0]?.path ?? ""
    ));
  }, [changes, selectedSetId]);
  // A file picked from the conversation's changes card opens on the workspace changes.
  useEffect(() => {
    // Applied once: coming back to the tab later keeps whatever file the reviewer moved to.
    if (!reveal || reveal.nonce === appliedChangeReveal) return;
    appliedChangeReveal = reveal.nonce;
    setSelectedSetId("workspace");
    setSelectedPath(reveal.path);
  }, [reveal?.nonce]);
  const selected = changes.find((file) => file.path === selectedPath) ?? changes[0];

  if (!thread?.changes.length && !history.length) {
    return (
      <div className="changes-panel">
        {runSourceControl && thread ? <SourceControlRow key={`${thread.id}:${repositoryPath}`} run={runSourceControl} paths={[]} busy={running || sourceBusy}
          busyReason={sourceBusy ? tr("sourcecontrol.checkout_busy") : undefined} onNotify={onNotify} /> : null}
        {branchHold ? <BranchHoldNotice hold={branchHold} /> : null}
        <div className="inspector-empty">
          <GitBranch size={20} />
          <strong>{tr("inspector.no_file_changes")}</strong>
        </div>
      </div>
    );
  }

  const additions = changes.reduce((total, file) => total + file.additions, 0);
  const deletions = changes.reduce((total, file) => total + file.deletions, 0);
  return (
    <div className="changes-panel">
      <div className="changes-toolbar">
        {history.length ? (
          <label className="change-history-picker">
            <Clock3 size={13} />
            <select
              aria-label={tr("inspector.choose_change_snapshot")}
              data-testid="change-history-picker"
              value={selectedSetId}
              onChange={(event) => setSelectedSetId(event.target.value)}
            >
              <option value="workspace">{tr("inspector.current_workspace")}{tr("conversation.value_files", { p0: thread?.changes.length ?? 0 })}</option>
              {history.map((changeSet) => (
                <option value={changeSet.id} key={changeSet.id}>
                  {changeSet.title} · {changeSet.createdAt} · {changeSet.changes.length} {tr("inspector.files_2")}</option>
              ))}
            </select>
          </label>
        ) : <span className="changes-scope">{tr("inspector.current_workspace_title")}</span>}
        {onUndo && selectedSetId === "workspace" ? (
          <button className="changes-undo" type="button" disabled={running || undoing} onClick={onUndo}
            title={tr("conversation.revert_project_git_changes_from_the_latest_turn_excludes_browser_and_desktop_actions")}>
            <RotateCcw className={undoing ? "spin" : ""} size={13} />
            <span>{undoing ? tr("conversation.reverting") : tr("inspector.undo_latest_turn")}</span>
          </button>
        ) : null}
      </div>
      {runSourceControl && selectedSetId === "workspace" ? (
        <SourceControlRow key={`${thread?.id}:${repositoryPath}`} run={runSourceControl} paths={(thread?.changes ?? []).map((file) => file.path)}
          busy={running || undoing || sourceBusy} busyReason={sourceBusy ? tr("sourcecontrol.checkout_busy") : undefined} onNotify={onNotify} />
      ) : null}
      {branchHold && selectedSetId === "workspace" ? <BranchHoldNotice hold={branchHold} /> : null}
      {onSendComments && onClearComments ? <ReviewCommentsBar comments={comments} onSend={onSendComments} onClear={onClearComments} /> : null}
      {!changes.length ? (
        <div className="inspector-empty change-snapshot-empty">
          <GitBranch size={20} />
          <strong>{tr("inspector.no_changes_in_the_current_workspace")}</strong>
        </div>
      ) : (
        <>
          <div className="change-summary">
            <span>{tr("conversation.value_files", { p0: changes.length })}</span>
            <div><strong>+{additions}</strong><em>-{deletions}</em></div>
          </div>
          <div className="changed-files" role="listbox" aria-label={tr("inspector.changed_files")}>
            {changes.map((file) => (
              <div className={`changed-file ${file.path === selected?.path ? "active" : ""}`} key={file.path}>
                <button type="button" role="option" aria-selected={file.path === selected?.path} onClick={() => setSelectedPath(file.path)}>
                  <small className={`change-status ${file.status}`} title={file.status}>{file.status.slice(0, 1).toUpperCase()}</small>
                  <span title={file.path}><b>{file.path.split("/").at(-1)}</b><i>{file.path.split("/").slice(0, -1).join("/")}</i></span>
                  {comments.some((comment) => comment.path === file.path) ? <MessageSquare size={12} className="file-comment-mark" /> : null}
                  <em className="change-counts"><ins>+{file.additions}</ins><del>-{file.deletions}</del></em>
                </button>
                {runSourceControl && selectedSetId === "workspace" ? (
                  <button type="button" className="changed-file-revert" disabled={running || undoing || sourceBusy || reverting !== null}
                    aria-label={tr("review.revert_file_value", { p0: file.path })} title={tr("review.revert_file_value", { p0: file.path })}
                    onClick={() => void revertFile(file.path)}>
                    <RotateCcw className={reverting === file.path ? "spin" : ""} size={12} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          {selected ? <DiffViewer file={selected} onNotify={onNotify} onCopyText={onCopyText} onOpenFile={onOpenFile}
            comments={selectedSetId === "workspace" ? comments.filter((comment) => comment.path === selected.path) : []}
            onAddComment={onAddComment && selectedSetId === "workspace"
              ? (line, side, text, excerpt) => onAddComment({ path: selected.path, line, side, text, excerpt,
                diffHash: hunkFingerprintAt(selected.diff, side, line, excerpt) ?? undefined }) : undefined}
            onRemoveComment={onRemoveComment}
            onRevertHunk={runSourceControl && selectedSetId === "workspace"
              ? (index) => void revertHunk(selected.path, hunkPatch(selected, index)) : undefined}
            revertDisabled={running || undoing || sourceBusy || reverting !== null} /> : null}
        </>
      )}
    </div>
  );
}

function DiffViewer({ file, onNotify, onCopyText, onOpenFile, comments = [], onAddComment, onRemoveComment, onRevertHunk, revertDisabled = false }: {
  file: ChangeFile;
  onNotify: (message: string, tone?: "success" | "error") => void;
  onCopyText: (value: string) => void;
  onOpenFile?: (path: string) => void;
  comments?: ReviewComment[];
  onAddComment?: (line: number, side: "old" | "new", text: string, excerpt: string) => void;
  onRemoveComment?: (id: string) => void;
  /** Undo one hunk (by its position in the file's diff). */
  onRevertHunk?: (hunkIndex: number) => void;
  revertDisabled?: boolean;
}) {
  const lines = useMemo(() => numberDiff(file.diff), [file.diff]);
  // Each hunk header's position among the file's hunks, for "undo this hunk".
  const hunkIndexes = useMemo(() => {
    let count = -1;
    return lines.map((line) => (line.kind === "hunk" ? ++count : -1));
  }, [lines]);
  const language = useMemo(() => languageOf(file.path), [file.path]);
  const [commenting, setCommenting] = useState<{ line: number; side: "old" | "new" } | null>(null);
  // Keyboard review: arrow keys move a line cursor, Enter or "c" opens a note on it.
  const [cursor, setCursor] = useState<number | null>(null);
  useEffect(() => { setCommenting(null); setCursor(null); }, [file.path]);
  const numbered = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.newLine !== null || line.oldLine !== null);
  const located = (comment: ReviewComment) => lines.some((line) => (comment.side === "new" ? line.newLine : line.oldLine) === comment.line
    && (line.newLine !== null ? "new" : "old") === comment.side && line.text === comment.excerpt);
  const outdated = comments.filter((comment) => !located(comment));
  const diffRef = useRef<HTMLPreElement>(null);
  // Closing a note returns the keyboard to the diff, on the line the note belongs to.
  const closeNote = () => { setCommenting(null); diffRef.current?.focus({ preventScroll: true }); };
  const moveCursor = (event: React.KeyboardEvent<HTMLPreElement>) => {
    // Keys typed inside a note's editor (or its buttons) belong to that editor, not to the diff.
    if (event.target !== event.currentTarget || event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (!onAddComment || !numbered.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const position = numbered.findIndex(({ index }) => index === cursor);
      const next = position < 0 ? 0 : Math.max(0, Math.min(numbered.length - 1, position + (event.key === "ArrowDown" ? 1 : -1)));
      setCursor(numbered[next].index);
      event.currentTarget.querySelector(`[data-line-index="${numbered[next].index}"]`)?.scrollIntoView({ block: "nearest" });
    } else if ((event.key === "Enter" || event.key.toLowerCase() === "c") && cursor !== null && !event.ctrlKey && !event.metaKey) {
      const target = lines[cursor];
      const number = target.newLine ?? target.oldLine;
      if (number === null) return;
      event.preventDefault();
      setCommenting({ line: number, side: target.newLine !== null ? "new" : "old" });
    }
  };
  return (
    <div className="diff-viewer">
      <header>
        <div><FileCode2 size={13} /><span title={file.path}>{file.path}</span></div>
        {onOpenFile && file.status !== "deleted" ? (
          <button type="button" title={tr("inspector.open_in_files")} aria-label={tr("inspector.open_in_files")} onClick={() => onOpenFile(file.path)}>
            <FolderOpen size={13} />
          </button>
        ) : null}
        <button type="button" title={tr("filespanel.copy_path")} aria-label={tr("filespanel.copy_path")} onClick={() => {
          onCopyText(file.path);
          onNotify(tr("filespanel.file_path_copied"));
        }}><Copy size={13} /></button>
      </header>
      {outdated.length ? (
        <div className="diff-outdated" role="note">
          <strong>{tr("review.outdated_comments", { p0: outdated.length })}</strong>
          {outdated.map((note) => <span key={note.id}>{note.line}: {note.text}
            {onRemoveComment ? <button type="button" aria-label={tr("conversation.remove")} onClick={() => onRemoveComment(note.id)}><X size={12} /></button> : null}</span>)}
        </div>
      ) : null}
      <pre ref={diffRef} tabIndex={0} role="region" aria-label={onAddComment ? tr("review.diff_keyboard_hint") : tr("inspector.code_diff")} onKeyDown={moveCursor}
        aria-activedescendant={cursor !== null ? `diff-line-${cursor}` : undefined}>
        {lines.map((line, index) => {
          const side = line.newLine !== null ? "new" : "old";
          const number = line.newLine ?? line.oldLine;
          const notes = number === null ? [] : comments.filter((comment) => comment.line === number && comment.side === side && comment.excerpt === line.text);
          return (
            <span className={`diff-line ${cursor === index ? "cursor" : ""}`} key={`${index}-${line.text}`} id={`diff-line-${index}`} data-line-index={index}>
              <span className={line.kind}>
                {onAddComment && number !== null ? (
                  <button type="button" className="diff-comment-add" tabIndex={-1} aria-label={tr("review.comment_on_line_value", { p0: number })}
                    title={tr("review.comment_on_line_value", { p0: number })} onClick={() => setCommenting({ line: number, side })}>+</button>
                ) : <b className="diff-comment-add" aria-hidden="true" />}
                <i aria-hidden="true">{line.oldLine ?? ""}</i><i aria-hidden="true">{line.newLine ?? ""}</i>
                <code>{line.kind === "added" || line.kind === "deleted" || line.kind === "context"
                  ? <>{line.text.slice(0, 1)}{highlight(line.text.slice(1), language)}</> : line.text || " "}</code>
                {line.kind === "hunk" && onRevertHunk ? (
                  <button type="button" className="diff-hunk-revert" disabled={revertDisabled} data-testid="revert-hunk"
                    title={tr("review.revert_hunk")} onClick={() => onRevertHunk(hunkIndexes[index])}>
                    <RotateCcw size={11} />{tr("review.revert_hunk")}
                  </button>
                ) : null}
              </span>
              {notes.map((note) => (
                <span className="diff-comment" key={note.id}>
                  <MessageSquare size={12} /><span>{note.text}</span>
                  {/* The line still reads the same, but its hunk is not the one the note was written on
                      (or the note predates fingerprints). */}
                  {!hasHunkFingerprint(note) ? <small className="diff-comment-stale">{tr("review.note_version_unverified")}</small>
                    : note.diffHash !== hunkFingerprintOfIndex(lines, index) ? <small className="diff-comment-stale">{tr("review.note_file_changed")}</small> : null}
                  {onRemoveComment ? <button type="button" aria-label={tr("conversation.remove")} onClick={() => onRemoveComment(note.id)}><X size={12} /></button> : null}
                </span>
              ))}
              {commenting && number === commenting.line && side === commenting.side && onAddComment ? (
                <CommentForm onCancel={closeNote} onSave={(text) => { onAddComment(number, side, text, line.text); closeNote(); }} />
              ) : null}
            </span>
          );
        })}
      </pre>
    </div>
  );
}

/** Purpose: What the conversation itself does not show about the run: its state, terminal output,
 * context and token use, permissions, the working directory and the memories it was given. The
 * turn's duration, its tool calls and (for development tasks) the harness, model and effort are
 * already in the conversation and the composer, and are not repeated here.
 */
function DetailsPanel({
  thread,
  project,
  runtime,
  memories,
  onRevealPath,
  onPermissionsChange,
}: {
  thread: Thread | null;
  project: Project | null;
  runtime: RuntimeProfile;
  memories: MemoryEntry[];
  onRevealPath: (value: string) => void;
  onPermissionsChange?: (threadId: string, update: RuntimeUpdate) => Promise<void>;
}) {
  const waiting = thread?.waitingFor;
  const running = thread?.status === "running" && !waiting;
  const hasIssue = thread?.status === "attention" || Boolean(waiting);
  const completed = thread?.status === "completed";
  // What the latest turn was actually given, as recorded when it was sent; without such a record
  // (chats, older turns) the section is honestly labelled as the most recently updated entries.
  const supplied = useMemo(() => {
    for (const item of [...(thread?.items ?? [])].reverse()) {
      if (item.type === "message" && item.role === "user") return item.memoryContext ?? null;
    }
    return null;
  }, [thread?.items]);
  const relevantMemories = useMemo(() => memories.slice(0, 3), [memories]);
  return (
    <div className="details-panel run-panel context-panel">
      <section className="run-status">
        <span className={running ? "running" : hasIssue ? "issue" : completed ? "complete" : "idle"}>{running ? <Circle size={12} /> : hasIssue ? <CircleAlert size={12} /> : completed ? <Check size={12} /> : <Clock3 size={12} />}</span>
        <div><strong>{waiting === "approval" ? tr("threadsidebar.awaiting_approval") : waiting === "question" ? tr("conversation.waiting_for_an_answer")
          : running ? tr("inspector.agent_is_running") : hasIssue ? tr("inspector.the_last_run_needs_attention") : completed ? tr("inspector.the_last_run_completed") : tr("inspector.not_run_yet")}</strong>{(running || hasIssue || completed) && <small>{thread?.updatedAt}</small>}</div>
      </section>
      <section className="inspector-section">
        <div className="section-kicker"><Terminal size={14} /><span>{tr("inspector.terminal_output")}</span></div>
        {thread?.terminal?.length ? (
          <pre className="terminal-output" tabIndex={0} role="region" aria-label={tr("inspector.terminal_output")}>{thread.terminal.join("")}{running && <span className="cursor">▋</span>}</pre>
        ) : <p className="muted details-empty">{tr("inspector.no_execution_output_yet")}</p>}
      </section>
      <section className="inspector-section">
        <ContextUsage usage={thread?.usage} />
      </section>
      <section className="inspector-section">
        <div className="section-kicker"><Cpu size={14} /><span>{tr("routing.task_usage")}</span></div>
        <TaskTokenUsage usage={thread?.taskUsage} />
      </section>
      <section className="inspector-section">
        <div className="section-kicker"><ShieldCheck size={14} /><span>{tr("inspector.run_settings")}</span></div>
        {/* A development task's harness, model and effort are the composer pill; a chat's pill names only the model. */}
        {thread?.space === "productivity" ? null : <dl className="property-list">
          <div><dt>{tr("conversation.provider")}</dt><dd>{runtime.provider}</dd></div>
          <div><dt>{tr("inspector.model")}</dt><dd>{runtime.model}</dd></div>
          <div><dt>{tr("conversation.reasoning_effort")}</dt><dd>{runtime.effort ? effortLabels[runtime.effort] ?? runtime.effort : tr("conversation.determined_by_the_model")}</dd></div>
          <div><dt>{tr("inspector.access")}</dt><dd title={runtime.access}>{accessLabel(runtime.access)}</dd></div>
          <div><dt>{tr("inspector.approval")}</dt><dd title={runtime.approval}>{approvalLabel(runtime.approval)}</dd></div>
        </dl>}
        {thread?.space === "productivity" ? (
          <div className="details-permissions">
            <RuntimePermissions key={thread.id} runtime={runtime} threadId={thread.id} onChange={onPermissionsChange} />
          </div>
        ) : null}
        <button className="workspace-context-row" type="button" onClick={() => project?.path && onRevealPath(project.path)}><span className={`project-glyph compact ${isGeneralProject(project) ? "plain" : ""}`} style={{ "--project-accent": project?.accent } as CSSProperties}>{isGeneralProject(project) ? <FolderMinus size={12} /> : projectLabel(project).slice(0, 1)}</span><div><strong>{projectLabel(project) || tr("inspector.no_project")}</strong>{projectPathLabel(project) ? <small>{projectPathLabel(project)}</small> : null}</div></button>
      </section>
      {supplied?.count ? (
        <section className="inspector-section memory-context" data-testid="memory-supplied">
          <div className="section-kicker"><CircleCheck size={14} /><span>{tr("inspector.memories_given_last_turn")}</span><small>{supplied.count}</small></div>
          {supplied.entries.map((entry) => {
            // What the turn was given is the recorded text; the library's current wording is shown
            // separately, and only when it has changed since.
            const saved = memories.find((memory) => memory.id === entry.id);
            const comparison = compareRecordedMemory(entry.content, saved?.content);
            return (
              <details key={entry.id || entry.content}>
                <summary>{entry.content.length > 40 ? `${entry.content.slice(0, 40)}…` : entry.content}</summary>
                <p>{entry.content}</p>
                {saved && comparison === "changed" ? <p className="memory-now"><small>{tr("inspector.memory_changed_since")}</small>{saved.content}</p>
                  : comparison === "partial" ? <p className="memory-now"><small>{tr("inspector.memory_excerpt_partial")}</small></p> : null}
              </details>
            );
          })}
        </section>
      ) : (
        <section className="inspector-section memory-context">
          <div className="section-kicker"><CircleCheck size={14} /><span>{tr("memoryview.recently_updated")}</span><small>{relevantMemories.length}</small></div>
          {relevantMemories.length ? relevantMemories.map((memory) => (
            <details key={memory.id}><summary>{memory.title}</summary><p>{memory.content}</p></details>
          )) : <p className="muted">{tr("inspector.no_memories_yet")}</p>}
        </section>
      )}
    </div>
  );
}

const KEYWORDS: Record<string, RegExp> = {
  script: /^(?:import|export|from|default|const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|interface|type|enum|async|await|try|catch|finally|throw|typeof|instanceof|in|of|void|null|undefined|true|false|this|public|private|readonly|static|as)$/,
  python: /^(?:import|from|as|def|class|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|try|except|finally|raise|with|yield|lambda|async|await|pass|break|continue|self)$/,
  generic: /^(?:if|else|for|while|return|true|false|null|function|class|import|export|const|let|var|def|fn|pub|struct|impl|use|match)$/,
};

/** Purpose: Pick a keyword set from a file name; unknown types get a small shared set. */
function languageOf(path: string) {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(extension)) return "script";
  if (extension === "py") return "python";
  // Languages whose line comments start with "#" (strings and numbers still coloured).
  if (["sh", "bash", "zsh", "ps1", "rb", "yml", "yaml", "toml", "r", "pl", "conf", "ini", "dockerfile"].includes(extension)
    || /(^|\/)(dockerfile|makefile)$/i.test(path)) return "hash";
  if (["sql", "lua", "hs"].includes(extension)) return "dash";
  if (["css", "json", "md", "txt", "html", "svg", "xml"].includes(extension)) return "plain";
  return "generic";
}

/** Which line-comment marker a language uses. */
function commentMarker(language: string) {
  return language === "python" || language === "hash" ? "#" : language === "dash" ? "--" : "//";
}

/** Purpose: Light, dependency-free colouring of one diff line: strings, comments, numbers and keywords.
 * Output: React nodes whose text is exactly the input, so copying a line yields the original code. */
function highlight(text: string, language: string): ReactNode {
  if (!text || language === "plain" || text.length > 400) return text || " ";
  const marker = commentMarker(language);
  const comment = marker === "#" ? "#.*$" : marker === "--" ? "--.*$" : "\\/\\/.*$";
  const pattern = new RegExp(`(${comment}|"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`|\\b\\d+(?:\\.\\d+)?\\b|[A-Za-z_$][\\w$]*)`, "g");
  const keywords = KEYWORDS[language] ?? KEYWORDS.generic;
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const [token] = match;
    const index = match.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    const kind = token.startsWith(marker) ? "tok-comment"
      : /^["'`]/.test(token) ? "tok-string" : /^\d/.test(token) ? "tok-number" : keywords.test(token) ? "tok-keyword" : "";
    out.push(kind ? <span className={kind} key={index}>{token}</span> : token);
    last = index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
