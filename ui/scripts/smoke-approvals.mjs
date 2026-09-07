import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(process.env.CLEO_TEST_TMP || tmpdir(), "cleo-approvals-"));
let app;
try {
  app = await electron.launch({
    args: [".", `--user-data-dir=${join(scratch, "profile")}`],
    cwd: appDir,
    env: { ...process.env, CLEO_DESKTOP_MOCK: "1", CLEO_HOME: join(scratch, "home") },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByTestId("conversation").waitFor();
  await page.getByRole("button", { name: "开发", exact: true }).click();
  await page.getByTestId("new-thread").click();
  const input = page.getByTestId("composer-input");
  const prompt = page.getByTestId("approval-prompt");
  const stop = page.getByTestId("stop-button");
  async function request(text) {
    await stop.waitFor({ state: "detached" });
    await input.fill(text);
    await page.getByTestId("send-button").click();
    await prompt.waitFor();
  }

  await request("browser approval");
  assert.match(await prompt.innerText(), /localhost:5173/);
  assert.equal(await page.getByTestId("approval-session").count(), 0);
  if (process.env.CLEO_TEST_SCREENSHOT) {
    await page.screenshot({ path: process.env.CLEO_TEST_SCREENSHOT });
  }
  await page.getByTestId("approval-once").click();
  await prompt.waitFor({ state: "detached" });
  await stop.waitFor({ state: "detached" });

  await request("browser approval decline");
  await page.getByTestId("approval-deny").click();
  await page.getByText("命令已拒绝", { exact: true }).waitFor();
  await request("browser approval cancel");
  await page.getByTestId("approval-cancel").focus();
  await page.keyboard.press("Escape");
  await page.getByText("请求已取消", { exact: true }).waitFor();

  for (let i = 0; i < 2; i += 1) {
    await request(`browser approval stop ${i}`);
    await stop.click();
    assert.equal(await stop.count(), 1, "Keep the run locked while cancellation is pending");
    await stop.waitFor({ state: "detached" });
    await prompt.waitFor({ state: "detached" });
  }
  await request("git commit approval after cancellation");
  await page.getByTestId("approval-session").click();
  await stop.waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log("PASS: browser accept/decline/cancel, repeated stop/resend, command approval");
} finally {
  try {
    await app?.close();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
