/**
 * Purpose: Normalise the math delimiters models actually emit before remark-math sees them.
 *
 * - `\[ ... \]` becomes `$$ ... $$` and `\( ... \)` becomes `$ ... $`, so LaTeX-style output renders.
 * - A dollar sign that starts a number (`$5`, `价格 $8`) is escaped so prices stay text.
 * - Fenced code blocks and inline code are left untouched.
 */
export function normalizeMath(markdown: string): string {
  if (!markdown || !/[$\\]/.test(markdown)) return markdown;
  return splitCode(markdown)
    .map((part) => (part.code ? part.text : normalizeProse(part.text)))
    .join("");
}

function normalizeProse(text: string): string {
  return text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => `$$${body}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) => `$${body}$`)
    // Currency: a dollar sign at a word boundary followed by a digit is not math.
    .replace(/(^|[\s(（【「"'])\$(?=\d)/g, "$1\\$");
}

/** Split markdown into prose and code segments (fenced blocks first, then inline spans). */
function splitCode(markdown: string): { text: string; code: boolean }[] {
  const parts: { text: string; code: boolean }[] = [];
  const fence = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2[ \t]*(?=\n|$)|$)/g;
  let last = 0;
  for (const match of markdown.matchAll(fence)) {
    const start = match.index! + match[1].length;
    if (start > last) parts.push(...splitInlineCode(markdown.slice(last, start)));
    parts.push({ text: markdown.slice(start, match.index! + match[0].length), code: true });
    last = match.index! + match[0].length;
  }
  if (last < markdown.length) parts.push(...splitInlineCode(markdown.slice(last)));
  return parts;
}

function splitInlineCode(text: string): { text: string; code: boolean }[] {
  const parts: { text: string; code: boolean }[] = [];
  const span = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
  let last = 0;
  for (const match of text.matchAll(span)) {
    if (match.index! > last) parts.push({ text: text.slice(last, match.index!), code: false });
    parts.push({ text: match[0], code: true });
    last = match.index! + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), code: false });
  return parts;
}
