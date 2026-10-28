import { t as tr } from "./i18n.mjs";
import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 20;

const mimeTypes = new Map(Object.entries({
  ".bmp": "image/bmp",
  ".c": "text/x-c",
  ".cc": "text/x-c++",
  ".cfg": "text/plain",
  ".cpp": "text/x-c++",
  ".cs": "text/x-csharp",
  ".css": "text/css",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".go": "text/x-go",
  ".h": "text/x-c",
  ".hpp": "text/x-c++",
  ".htm": "text/html",
  ".html": "text/html",
  ".ini": "text/plain",
  ".java": "text/x-java-source",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".jsx": "text/jsx",
  ".kt": "text/x-kotlin",
  ".kts": "text/x-kotlin",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".mjs": "text/javascript",
  ".odf": "application/vnd.oasis.opendocument.formula",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".pdf": "application/pdf",
  ".php": "text/x-php",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ps1": "text/plain",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".rs": "text/x-rust",
  ".rtf": "application/rtf",
  ".sh": "text/x-shellscript",
  ".sql": "application/sql",
  ".svg": "image/svg+xml",
  ".swift": "text/x-swift",
  ".toml": "application/toml",
  ".ts": "text/typescript",
  ".tsv": "text/tab-separated-values",
  ".tsx": "text/tsx",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zsh": "text/x-shellscript",
}));

const specialNames = new Map([
  ["dockerfile", "text/plain"],
  ["license", "text/plain"],
  ["makefile", "text/plain"],
]);

const extensionForMimeType = new Map([
  ["application/pdf", ".pdf"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["text/plain", ".txt"],
]);

export const SUPPORTED_ATTACHMENT_EXTENSIONS = [...mimeTypes.keys()]
  .map((extension) => extension.slice(1))
  .sort();

export const ATTACHMENT_FILTERS = [
  { get name() { return tr("attachments.supported_files"); }, extensions: SUPPORTED_ATTACHMENT_EXTENSIONS },
  { get name() { return tr("attachments.common_documents"); }, extensions: ["pdf", "doc", "docx", "rtf", "odt", "txt", "md"] },
  { get name() { return tr("attachments.spreadsheets_and_presentations"); }, extensions: ["csv", "tsv", "xls", "xlsx", "ods", "ppt", "pptx", "odp"] },
  { get name() { return tr("attachments.images"); }, extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"] },
  { get name() { return tr("attachments.code_and_data"); }, extensions: ["json", "jsonl", "yaml", "yml", "xml", "html", "css", "js", "jsx", "ts", "tsx", "py", "java", "c", "cpp", "h", "hpp", "cs", "go", "rs", "rb", "php", "swift", "kt", "sh", "ps1", "sql", "toml", "ini", "cfg", "log"] },
];

function mimeTypeFor(name, providedMimeType = "") {
  const normalizedName = basename(String(name || "")).toLowerCase();
  const mapped = mimeTypes.get(extname(normalizedName)) || specialNames.get(normalizedName);
  if (mapped) return mapped;
  const normalizedMimeType = String(providedMimeType || "").toLowerCase();
  if (extensionForMimeType.has(normalizedMimeType)) return normalizedMimeType;
  throw new Error(tr("attachments.unsupported_attachment_type_value", { p0: basename(String(name || tr("attachments.unknown_file"))) }));
}

function ensureBatchSize(count) {
  if (count > MAX_ATTACHMENT_COUNT) {
    throw new Error(tr("attachments.you_can_add_at_most_value_attachments_at_once", { p0: MAX_ATTACHMENT_COUNT }));
  }
}

function ensureFileSize(name, size) {
  if (size > MAX_ATTACHMENT_BYTES) {
    throw new Error(tr("attachments.attachment_exceeds_50_mb_value", { p0: basename(name) }));
  }
}

export async function attachmentsFromPaths(paths) {
  const normalizedPaths = [...new Set((paths || []).map((path) => String(path || "").trim()).filter(Boolean))];
  ensureBatchSize(normalizedPaths.length);
  return Promise.all(normalizedPaths.map(async (path) => {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) throw new Error(tr("attachments.only_files_can_be_attached_value", { p0: basename(path) }));
    ensureFileSize(path, fileStat.size);
    return {
      name: basename(path),
      path,
      mimeType: mimeTypeFor(path),
      size: fileStat.size,
    };
  }));
}

/** Purpose: Read an in-memory file's bytes as the preload sends them (Uint8Array/ArrayBuffer) or as legacy base64. */
function inlineBytes(entry) {
  const bytes = entry?.bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return Buffer.from(String(entry?.base64 || ""), "base64");
}

export async function materializeInlineAttachments(entries, directory) {
  const normalizedEntries = Array.isArray(entries) ? entries : [];
  ensureBatchSize(normalizedEntries.length);
  if (!normalizedEntries.length) return [];
  await mkdir(directory, { recursive: true });
  const attachments = [];
  for (const entry of normalizedEntries) {
    const mimeType = mimeTypeFor(entry?.name, entry?.mimeType);
    const data = inlineBytes(entry);
    ensureFileSize(String(entry?.name || "clipboard-file"), data.length);
    const sourceName = basename(String(entry?.name || "clipboard-file"));
    const sourceExtension = extname(sourceName).toLowerCase();
    const extension = mimeTypes.has(sourceExtension)
      ? sourceExtension
      : extensionForMimeType.get(mimeType) || ".bin";
    const stem = basename(sourceName, sourceExtension).replace(/[^a-z\d._-]+/gi, "-").slice(0, 80)
      || "clipboard-file";
    const path = join(directory, `${randomUUID()}-${stem}${extension}`);
    await writeFile(path, data, { flag: "wx" });
    attachments.push({ name: sourceName, path, mimeType, size: data.length });
  }
  return attachments;
}

export const THUMBNAIL_EDGE = 96;

/** Purpose: Give image attachments a small preview the chips can show before and after sending.
 * Input: attachment records and Electron's `nativeImage.createFromPath` (or a stand-in). Output: the
 * same records; images that decode gain `thumbnail`, a PNG/JPEG data URL at most 96px on its longest
 * edge. Unreadable or unsupported images keep no thumbnail so the chip falls back to its icon.
 */
export function withThumbnails(attachments, createImage) {
  return (attachments || []).map((attachment) => {
    if (!attachment?.mimeType?.startsWith("image/")) return attachment;
    try {
      const image = createImage(attachment.path);
      if (!image || image.isEmpty()) return attachment;
      const { width, height } = image.getSize();
      if (!width || !height) return attachment;
      const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(width, height));
      const resized = scale < 1
        ? image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) })
        : image;
      // Photos compress far better as JPEG; PNG keeps transparency for screenshots and icons.
      const thumbnail = attachment.mimeType === "image/png"
        ? resized.toDataURL()
        : `data:image/jpeg;base64,${resized.toJPEG(82).toString("base64")}`;
      return { ...attachment, thumbnail };
    } catch {
      return attachment;
    }
  });
}
