import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_ATTACHMENT_BYTES,
  attachmentsFromPaths,
  materializeInlineAttachments,
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
