import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_ATTACHMENT_BYTES,
  attachmentsFromPaths,
  materializeInlineAttachments,
  withThumbnails,
} from "./attachments.mjs";

test("common document formats become lightweight attachment metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-attachments-"));
  const pdf = join(root, "brief.pdf");
  const docx = join(root, "proposal.docx");
  try {
    await writeFile(pdf, "%PDF-1.7", "utf8");
    await writeFile(docx, "docx", "utf8");

    const attachments = await attachmentsFromPaths([pdf, docx]);

    assert.deepEqual(attachments.map(({ name, mimeType }) => ({ name, mimeType })), [
      { name: "brief.pdf", mimeType: "application/pdf" },
      {
        name: "proposal.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    ]);
    assert.equal("base64" in attachments[0], false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported and oversized files are rejected before IPC", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-attachment-errors-"));
  const executable = join(root, "setup.exe");
  const oversized = join(root, "oversized.pdf");
  try {
    await writeFile(executable, "MZ", "utf8");
    await writeFile(oversized, "", "utf8");
    await truncate(oversized, MAX_ATTACHMENT_BYTES + 1);

    await assert.rejects(attachmentsFromPaths([executable]), /不支持的附件类型/);
    await assert.rejects(attachmentsFromPaths([oversized]), /附件超过 50 MB/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pasted in-memory files are materialized for local agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-pasted-attachment-"));
  try {
    const [attachment] = await materializeInlineAttachments([
      {
        name: "clipboard.png",
        mimeType: "image/png",
        base64: Buffer.from("image-bytes").toString("base64"),
      },
    ], root);

    assert.equal(attachment.name, "clipboard.png");
    assert.equal(attachment.mimeType, "image/png");
    assert.equal(attachment.size, 11);
    assert.match(attachment.path, /clipboard\.png$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pasted files arrive as raw bytes, so the sandboxed preload never needs Buffer", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-pasted-bytes-"));
  try {
    const bytes = new TextEncoder().encode("screenshot-bytes");
    const [attachment] = await materializeInlineAttachments([
      { name: "screenshot.png", mimeType: "image/png", bytes },
    ], root);

    assert.equal(attachment.size, bytes.length);
    assert.equal(await readFile(attachment.path, "utf8"), "screenshot-bytes");
    assert.match(attachment.path, /screenshot\.png$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image attachments gain a thumbnail no larger than 96px; other files and failures keep none", () => {
  const sizes = { "wide.jpg": { width: 1920, height: 1080 }, "tall.png": { width: 40, height: 80 } };
  const fakeImage = (path) => {
    const name = path.split("/").pop();
    if (name === "broken.png") throw new Error("cannot decode");
    const size = sizes[name] ?? { width: 0, height: 0 };
    const make = (current) => ({
      isEmpty: () => !current.width,
      getSize: () => current,
      resize: (next) => make(next),
      toDataURL: () => `data:image/png;base64,${current.width}x${current.height}`,
      toJPEG: () => Buffer.from(`${current.width}x${current.height}`),
    });
    return make(size);
  };
  const [wide, tall, broken, doc] = withThumbnails([
    { name: "wide.jpg", path: "C:/shots/wide.jpg", mimeType: "image/jpeg", size: 10 },
    { name: "tall.png", path: "C:/shots/tall.png", mimeType: "image/png", size: 10 },
    { name: "broken.png", path: "C:/shots/broken.png", mimeType: "image/png", size: 10 },
    { name: "brief.pdf", path: "C:/docs/brief.pdf", mimeType: "application/pdf", size: 10 },
  ], fakeImage);

  assert.equal(wide.thumbnail, `data:image/jpeg;base64,${Buffer.from("96x54").toString("base64")}`);
  assert.equal(tall.thumbnail, "data:image/png;base64,40x80");
  assert.equal("thumbnail" in broken, false);
  assert.equal("thumbnail" in doc, false);
  assert.equal(wide.name, "wide.jpg");
});
