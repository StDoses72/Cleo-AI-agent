import assert from "node:assert/strict";
import test from "node:test";
import { trustedPreviewSender } from "./computer-preview.mjs";

test("desktop IPC accepts only the trusted main app frame", () => {
  const frame = { url: "file:///app/index.html" };
  assert.equal(trustedPreviewSender({ senderFrame: frame, sender: { mainFrame: frame } }, frame.url), true);
  assert.equal(trustedPreviewSender({ senderFrame: { ...frame }, sender: { mainFrame: frame } }, frame.url), false);
  assert.equal(trustedPreviewSender({ senderFrame: frame, sender: { mainFrame: frame } }, "https://remote"), false);
});
