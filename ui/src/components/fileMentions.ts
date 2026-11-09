/** @-mentions of project files in the composer: where a mention is being typed and which files match. */

export interface MentionQuery {
  /** Index of the "@" in the text. */
  start: number;
  /** What follows the "@" up to the caret. */
  query: string;
}

/** Purpose: Find the @-mention the caret is in. Input: composer text and caret index.
 * Output: the mention, or null when the caret is not right after "@…" (an "@" must start the text
 * or follow whitespace, so e-mail addresses do not open the file list). */
export function mentionAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const match = /(^|\s)@([^\s@"]*)$/.exec(before);
  if (!match) return null;
  return { start: before.length - match[2].length - 1, query: match[2] };
}

function isSubsequence(haystack: string, needle: string) {
  let position = 0;
  for (const character of haystack) {
    if (character === needle[position]) position += 1;
    if (position === needle.length) return true;
  }
  return needle.length === 0;
}

/** Purpose: Rank project files for a mention query, best first.
 * Input: repository-relative paths, the typed query, how many to return.
 * Output: file-name prefix matches, then file-name matches, then path matches, then paths that
 * contain the query's characters in order; shorter paths first within a group. An empty query
 * lists the shallowest files. */
export function rankFiles(files: string[], query: string, limit = 8): string[] {
  const needle = query.toLowerCase().replaceAll("\\", "/");
  const scored: { path: string; score: number }[] = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    const score = !needle ? lower.split("/").length
      : name.startsWith(needle) ? 0
        : name.includes(needle) ? 1
          : lower.includes(needle) ? 2
            : isSubsequence(lower, needle) ? 3 : -1;
    if (score >= 0) scored.push({ path, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((item) => item.path);
}

/** Purpose: The text that replaces "@query" when a file is chosen; paths with spaces are quoted. */
export function mentionText(path: string) {
  return /\s/.test(path) ? `@"${path}" ` : `@${path} `;
}
