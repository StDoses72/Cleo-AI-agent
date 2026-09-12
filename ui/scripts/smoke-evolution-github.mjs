import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = await mkdtemp(join(tmpdir(), "cleo-github-ui-"));
const output = join(ui, "output/playwright/evolution");
const app = await electron.launch({ executablePath: process.env.CLEO_SMOKE_EXECUTABLE, args: [".", `--user-data-dir=${profile}`], cwd: ui,
  env: { ...process.env, CLEO_DESKTOP_MOCK: "1" } });
const page = await app.firstWindow();
const state = { phase: "idle", supported: true, prepared: false, active: null, baseline: null,
  currentVersion: "0.3.9", builds: [], releases: [], logs: "", error: null, iteration: null,
  githubAuth: null };
const actions = [];
// The mock preload has no IPC subscription; selecting the current view refreshes its snapshot.
const publish = () => page.getByRole("button", { name: "进化", exact: true }).click();
let finishLogin;
let copiedCode;
let finishSubmit;
let failSubmit = true;
const submissionIds = [];
try {
  await page.getByTestId("conversation").waitFor();
  await page.exposeFunction("githubSnapshot", () => state);
  await page.exposeFunction("githubCopy", (value) => { copiedCode = value; });
  await page.exposeFunction("githubAction", async (action, params) => {
    actions.push(action);
    if (action === "login") {
      state.phase = "authenticating";
      state.githubAuth = { status: "waiting", code: actions.filter((value) => value === "login").length === 1 ? "AB12-CD34" : "EF56-GH78",
        message: "请在 GitHub 页面输入验证码并完成授权。" };
      await publish();
      await new Promise((done) => { finishLogin = done; });
    }
    if (action === "cancelLogin") {
      state.phase = "idle"; state.githubAuth = { status: "cancelled", message: "已取消 GitHub 登录。" };
      finishLogin(); await publish();
    }
    if (action === "prepare") {
      if (actions.filter((value) => value === "prepare").length === 1) throw new Error("源码下载暂时失败，请重试。");
      state.prepared = true;
    }
    if (action === "submit") {
      assert.deepEqual({ title: params.title, body: params.body }, { title: "Custom harness", body: "Add model selection; build and regression checks passed." });
      assert.match(params.submissionId, /^[a-f0-9-]{36}$/);
      submissionIds.push(params.submissionId);
      await new Promise((done) => { finishSubmit = done; });
      if (failSubmit) throw new Error("GitHub 暂时不可用，请重试。");
      const number = (state.pullRequests?.length || 0) + 1;
      state.pullRequest = { url: `https://github.com/example/fixture/pull/${number}`, state: "OPEN", merged: false,
        number, title: "Custom harness", submittedAt: new Date().toISOString(), checks: "pending", submissionId: params.submissionId };
      state.pullRequests = [state.pullRequest, ...(state.pullRequests || [])];
      return state.pullRequest.url;
    }
    if (action === "pullRequest") {
      state.pullRequests.find((pr) => pr.url === params.url).checks = "failed";
    }
  });
  await page.evaluate(() => {
    window.cleoDesktop = { ...window.cleoDesktop,
      getEvolutionState: () => window.githubSnapshot(),
      copyText: (value) => window.githubCopy(value),
      evolutionAction: (action, params) => window.githubAction(action, params) };
  });
  await page.getByRole("button", { name: "进化", exact: true }).click();
  await page.getByRole("button", { name: "新建 PR", exact: true }).click();
  await page.getByRole("button", { name: "连接 GitHub", exact: true }).click();
  const auth = page.getByRole("region", { name: "GitHub 登录", exact: true });
  await auth.waitFor({ timeout: 2000 });
  assert.equal(await page.locator("dialog[open]").count(), 0, "Contribution dialog must not cover device authorization.");
  await auth.getByText("AB12-CD34", { exact: true }).waitFor();
  await auth.getByRole("button", { name: "打开 GitHub 授权页面", exact: true }).click();
  assert.ok(actions.includes("openGithubLogin"));
  await auth.getByRole("button", { name: "复制验证码", exact: true }).click();
  assert.equal(copiedCode, "AB12-CD34");
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: join(output, "github-device-login.png") });
  state.phase = "idle"; state.githubAuth = { status: "failed", message: "GitHub 授权等待超时，请重新连接并使用新的验证码。" };
  finishLogin(); await publish();
  await auth.getByRole("button", { name: "重新连接 GitHub", exact: true }).waitFor();
  assert.equal(await page.getByText("AB12-CD34", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "重新检查", exact: true }).count(), 0);
  await auth.getByRole("button", { name: "重新连接 GitHub", exact: true }).click();
  await auth.getByText("EF56-GH78", { exact: true }).waitFor();
  await auth.getByRole("button", { name: "取消登录", exact: true }).click();
  await auth.getByText("已取消 GitHub 登录。", { exact: true }).waitFor();
  assert.equal(await page.getByText("EF56-GH78", { exact: true }).count(), 0);
  assert.ok(actions.includes("cancelLogin"));
  state.active = "saved";
  state.builds = [{ id: "saved", kind: "local", name: "add custom harness", savedAt: "2026-09-11", baseTag: "v0.3.9", sourceHash: "verified-source" }];
  state.githubAuth = { status: "connected", message: "GitHub 已连接，可以继续提交 PR。" };
  await publish();
  await page.getByRole("button", { name: "新建 PR", exact: true }).click({ timeout: 2000 });
  const dialog = page.getByRole("dialog");
  await dialog.getByText("提交版本：add custom harness", { exact: true }).waitFor();
  await dialog.getByLabel("PR 标题", { exact: true }).fill("Custom harness");
  await dialog.getByLabel("PR 说明", { exact: true }).fill("Add model selection; build and regression checks passed.");
  assert.equal(await dialog.getByRole("button", { name: "创建新 PR", exact: true }).isEnabled(), false);
  await dialog.getByRole("button", { name: "准备当前版本源码", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "源码下载暂时失败" }).waitFor();
  assert.equal(await dialog.getByLabel("PR 标题", { exact: true }).inputValue(), "Custom harness");
  await dialog.getByRole("button", { name: "准备当前版本源码", exact: true }).click();
  await dialog.getByText("源码已准备，可以填写说明并提交。", { exact: true }).waitFor();
  assert.equal(actions.includes("submit"), false, "Preparing source must not publish a PR.");
  assert.equal(state.iteration, null, "Preparing a contribution must not create an editing conversation.");
  await page.screenshot({ path: join(output, "github-submit-ready.png") });
  await dialog.getByRole("button", { name: "创建新 PR", exact: true }).click();
  await dialog.getByRole("button", { name: "正在提交…", exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "正在提交…", exact: true }).isDisabled(), true);
  finishSubmit();
  await dialog.getByRole("alert").filter({ hasText: "GitHub 暂时不可用" }).waitFor();
  assert.equal(await dialog.getByLabel("PR 标题", { exact: true }).inputValue(), "Custom harness");
  failSubmit = false;
  await dialog.getByRole("button", { name: "创建新 PR", exact: true }).click();
  await dialog.getByRole("button", { name: "正在提交…", exact: true }).waitFor();
  finishSubmit();
  await page.locator("dialog[open]").waitFor({ state: "hidden" });
  const receipt = page.getByRole("status", { name: "PR 提交结果" });
  await receipt.getByText("新 PR 已创建", { exact: true }).waitFor();
  assert.equal(submissionIds[0], submissionIds[1], "Retry retains the original submission identity.");
  assert.equal(await page.getByRole("button", { name: "继续提交 PR", exact: true }).count(), 0);
  await page.getByRole("button", { name: "PR 历史", exact: true }).click();
  await dialog.getByRole("button", { name: "刷新 PR #1", exact: true }).click();
  await dialog.getByText(/CI 检查未通过/).waitFor();
  await page.keyboard.press("Escape");
  await receipt.getByRole("button", { name: "关闭提交提示", exact: true }).click();
  await receipt.waitFor({ state: "hidden" });
  await page.screenshot({ path: join(output, "github-submit-success.png") });
  await page.getByRole("button", { name: "新建 PR", exact: true }).click();
  assert.equal(await dialog.getByLabel("PR 标题", { exact: true }).inputValue(), "");
  assert.equal(await dialog.getByLabel("PR 说明", { exact: true }).inputValue(), "");
  await dialog.getByLabel("PR 标题", { exact: true }).fill("Custom harness");
  await dialog.getByLabel("PR 说明", { exact: true }).fill("Add model selection; build and regression checks passed.");
  await dialog.getByRole("button", { name: "创建新 PR", exact: true }).click();
  await dialog.getByRole("button", { name: "正在提交…", exact: true }).waitFor();
  finishSubmit();
  await page.locator("dialog[open]").waitFor({ state: "hidden" });
  await receipt.getByRole("link", { name: "查看 #2", exact: true }).waitFor();
  assert.notEqual(submissionIds[1], submissionIds[2], "A fresh form gets a new submission identity, even with identical content.");
  await page.getByRole("button", { name: "PR 历史", exact: true }).click();
  assert.equal(await dialog.locator("article").count(), 2);
  await page.screenshot({ path: join(output, "github-pr-history.png") });
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByTestId("conversation").waitFor();
  await page.evaluate(() => { window.cleoDesktop = { ...window.cleoDesktop, getEvolutionState: () => window.githubSnapshot() }; });
  await publish();
  assert.equal(await receipt.count(), 0, "Historical PRs must not reappear as current success banners after restart.");
  await page.getByRole("button", { name: "PR 历史", exact: true }).click();
  assert.equal(await dialog.locator("article").count(), 2);
  console.log(JSON.stringify({ status: "passed", deviceCodeVisible: true, retry: true, cancellation: true,
    connectedSubmissionEntry: true, savedSourcePreparation: true, preparationRetryPreservesDraft: true,
    submitSpinner: true, submitFailureKeepsDraft: true, successClosesDialog: true, ciSeparateFromSubmission: true,
    newIntentNewPR: true, retrySameIdentity: true, historySurvivesReload: true, explicitSubmissionOnly: true, output }));
} finally {
  finishLogin?.();
  finishSubmit?.();
  await app.close();
  assert.equal(dirname(profile), resolve(tmpdir()));
  await rm(profile, { recursive: true, force: true });
}
