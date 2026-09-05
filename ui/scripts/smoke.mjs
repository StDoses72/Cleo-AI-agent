import { _electron as electron } from "playwright";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(appDir, "output", "playwright");
const packagedExecutable = process.env.CLEO_EXECUTABLE;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await mkdir(outputDir, { recursive: true });
const electronApp = packagedExecutable
  ? await electron.launch({
      executablePath: packagedExecutable,
      env: { ...process.env, CLEO_DESKTOP_MOCK: "1" },
    })
  : await electron.launch({
      args: ["."],
      cwd: appDir,
      env: { ...process.env, CLEO_DESKTOP_MOCK: "1" },
    });
const window = await electronApp.firstWindow();
const consoleErrors = [];
window.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

try {
  await window.getByTestId("conversation").waitFor({ timeout: 15_000 });
  const initialFit = await window.evaluate(() => {
    const required = [".workspace-rail", ".thread-sidebar", ".conversation-shell", ".inspector"];
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
      regions: required.map((selector) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        return rect
          ? { selector, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
          : { selector, missing: true };
      }),
    };
  });
  assert(initialFit.document.width === initialFit.viewport.width, "Initial view scrolls horizontally");
  assert(initialFit.document.height === initialFit.viewport.height, "Initial view scrolls vertically");
  await window.screenshot({ path: join(outputDir, "01-initial.png") });
  const historyPicker = window.getByTestId("change-history-picker");
  await historyPicker.selectOption("desktop-ui-foundation");
  assert(await window.locator(".changed-files button").count() === 2, "Historical diff was not selectable");
  await window.screenshot({ path: join(outputDir, "01b-change-history.png") });
  await historyPicker.selectOption("workspace");

  await window.locator(".project-picker").click();
  await window.getByTestId("choose-workspace").waitFor();
  await window.locator(".project-picker").click();

  await window.getByRole("button", { name: "对话", exact: true }).click();
  await window.getByRole("heading", { name: "对话", exact: true }).waitFor();
  await window.getByTestId("new-thread").click();
  await window.getByText("今天想聊些什么？").waitFor();
  await window.getByTestId("runtime-selector").click();
  await window.getByText("gpt-5.4-mini", { exact: true }).click();
  await window.getByTestId("runtime-selector").getByText("gpt-5.4-mini", { exact: true }).waitFor();

  await window.getByRole("button", { name: "记忆", exact: true }).click();
  await window.getByTestId("memory-view").waitFor();
  await window.getByTestId("memory-nav-projects").click();
  await window.getByRole("heading", { name: "项目记忆", exact: true }).waitFor();
  await window.getByRole("button", { name: /Cleo-AI-agent/ }).click();
  await window.getByText("Cleo 是 local-first runtime", { exact: true }).click();
  await window.getByText("原始证据", { exact: true }).waitFor();
  await window.getByTestId("memory-nav-pending").click();
  await window.getByRole("heading", { name: "待确认", exact: true }).waitFor();
  const reviewRowsBefore = await window.getByTestId("memory-review-list").locator("article").count();
  const firstReviewRow = window.getByTestId("memory-review-list").locator("article").first();
  await firstReviewRow.locator(".memory-review-toggle").click();
  await firstReviewRow.getByTestId("memory-review-confirm").dblclick();
  await window.waitForFunction(
    (count) => document.querySelectorAll('[data-testid="memory-review-list"] article').length === count - 1,
    reviewRowsBefore,
  );
  assert(await window.locator(".memory-review-error").count() === 0, "Double-click submitted memory review twice");
  await window.getByTestId("memory-review-confirm").first().click();
  await window.waitForFunction(
    () => document.querySelectorAll('[data-testid="memory-review-list"] article').length === 0,
  );
  await window.screenshot({ path: join(outputDir, "02-memory.png") });

  await window.getByRole("button", { name: "开发", exact: true }).click();
  await window.getByTestId("conversation").waitFor();
  await window.getByTestId("new-thread").click();
  await window.getByText("从一个清晰的目标开始。").waitFor();
  await window.getByTestId("runtime-selector").click();
  await window.getByText("claude", { exact: true }).click();
  await window.getByText("Claude Opus 5", { exact: true }).waitFor();
  await window.getByText("Claude Opus 5", { exact: true }).click();
  assert(
    JSON.stringify(await window.getByTestId("effort-selector").locator("option").allTextContents())
      === JSON.stringify(["由 harness 管理", "low", "medium", "high", "xhigh", "max"]),
    "Claude effort options did not match the harness catalog",
  );
  await window.getByTestId("runtime-selector").click();
  await window.getByText("codex", { exact: true }).click();
  await window.getByText("GPT-5.6-Terra", { exact: true }).waitFor();
  await window.screenshot({ path: join(outputDir, "03-runtime-selector.png") });
  await window.getByText("GPT-5.6-Terra", { exact: true }).click();
  await window.getByTestId("runtime-selector").getByText("gpt-5.6-terra", { exact: true }).waitFor();
  await window.getByTestId("effort-selector").selectOption("low");
  assert(await window.getByTestId("effort-selector").inputValue() === "low", "Draft effort was not selectable");
  await window.screenshot({ path: join(outputDir, "03-new-thread.png") });

  await window.evaluate(() => {
    const composer = document.querySelector('[data-testid="composer"]');
    const transfer = new DataTransfer();
    transfer.items.add(new File(["%PDF-test"], "brief.pdf", { type: "application/pdf" }));
    composer?.dispatchEvent(new DragEvent("dragenter", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  });
  await window.getByText("松开以添加文件", { exact: true }).waitFor();
  await window.evaluate(() => {
    const composer = document.querySelector('[data-testid="composer"]');
    const transfer = new DataTransfer();
    transfer.items.add(new File(["%PDF-test"], "brief.pdf", { type: "application/pdf" }));
    composer?.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  });
  await window.getByText("brief.pdf", { exact: true }).waitFor();
  await window.evaluate(() => {
    const input = document.querySelector('[data-testid="composer-input"]');
    const transfer = new DataTransfer();
    transfer.items.add(new File(
      ["PK-docx-test"],
      "proposal.docx",
      { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    ));
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: transfer });
    input?.dispatchEvent(paste);
  });
  await window.getByText("proposal.docx", { exact: true }).waitFor();
  assert(await window.locator(".attachment-chip").count() === 2, "Drag and paste did not add both attachments");
  await window.screenshot({ path: join(outputDir, "03b-attachments.png") });

  await window.getByTestId("composer-input").fill("检查当前 mock 边界并完成一次可见的运行");
  await window.getByTestId("send-button").click();
  await window.waitForFunction(() => document.querySelectorAll(".attachment-chip").length === 0);
  await window.getByTestId("stop-button").waitFor();
  await window.getByRole("heading", { name: "正在整理", exact: true }).waitFor({ timeout: 20_000 });
  await window.getByTestId("thought-group").waitFor({ timeout: 5_000 });
  await window.getByTestId("tool-group").getByText("2 次调用", { exact: false }).waitFor({ timeout: 5_000 });
  const streamingLayout = await window.evaluate(() => {
    const timeline = document.querySelector('[data-testid="timeline"]');
    const thoughtGroup = timeline?.querySelector('[data-testid="thought-group"]');
    const toolGroup = timeline?.querySelector('[data-testid="tool-group"]');
    const assistant = timeline?.querySelector(".message-entry.assistant");
    const viewport = document.querySelector(".conversation-viewport");
    const children = timeline ? Array.from(timeline.children) : [];
    return {
      thoughtIndex: thoughtGroup ? children.indexOf(thoughtGroup) : -1,
      toolIndex: toolGroup ? children.indexOf(toolGroup) : -1,
      assistantIndex: assistant ? children.indexOf(assistant) : -1,
      distanceFromBottom: viewport
        ? viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
        : Number.POSITIVE_INFINITY,
    };
  });
  assert(
    streamingLayout.thoughtIndex >= 0
      && streamingLayout.toolIndex >= 0
      && streamingLayout.thoughtIndex < streamingLayout.assistantIndex
      && streamingLayout.toolIndex < streamingLayout.assistantIndex,
    "Streaming assistant text was not kept after the visible process groups",
  );
  assert(streamingLayout.distanceFromBottom < 24, "Streaming timeline did not follow the latest text");
  await window.getByRole("heading", { name: "运行完成", exact: true }).waitFor({ timeout: 20_000 });
  await window.getByText("真实后端接入后，这些事件会保持同一结构从 IPC bridge 流入").waitFor({ timeout: 20_000 });
  await window.locator(".change-summary").getByText("2 个文件", { exact: true }).waitFor();
  const thoughtGroupButton = window.getByTestId("thought-group").getByRole("button").first();
  assert(
    await thoughtGroupButton.getAttribute("aria-expanded") === "false",
    "Completed thought group was not collapsed by default",
  );
  await thoughtGroupButton.click();
  assert(await window.locator(".thought-entry").count() === 1, "Thought group did not retain visible commentary");
  assert(await window.locator(".plan-entry").count() === 1, "Plan updates created duplicate cards");
  assert(
    await window.locator('.plan-entry li[data-status="done"]').count() === 3,
    "Plan card did not receive the latest incremental step state",
  );
  assert(await window.getByTestId("tool-group").count() === 1, "Tool calls were not grouped");
  const toolGroupButton = window.getByTestId("tool-group").getByRole("button");
  assert(
    await toolGroupButton.getAttribute("aria-expanded") === "false",
    "Completed tool group was not collapsed by default",
  );
  await toolGroupButton.click();
  assert(await window.getByTestId("tool-process").count() === 3, "Tool group did not retain every process");
  assert(await window.locator(".message-entry.assistant li").count() === 3, "Markdown list did not render");
  assert(
    await window.getByRole("link", { name: "渲染说明" }).getAttribute("target") === "_blank",
    "Markdown link did not use the external-link policy",
  );
  const localFileLink = window.getByRole("link", { name: "项目入口" });
  assert(
    await localFileLink.getAttribute("target") === null,
    "Local Markdown link unexpectedly opened as a web URL",
  );
  assert(
    (await localFileLink.getAttribute("class"))?.includes("local-file-link"),
    "Local Markdown link did not receive the native-file affordance",
  );
  assert(await window.getByTestId("effort-selector").inputValue() === "low", "Created thread did not keep draft effort");
  await window.screenshot({ path: join(outputDir, "04a-process-expanded.png") });
  await thoughtGroupButton.click();
  await toolGroupButton.click();
  await window.screenshot({ path: join(outputDir, "04-completed-turn.png") });

  await window.getByTestId("composer-input").fill("请运行需要审批的 git commit");
  await window.getByTestId("send-button").click();
  await window.getByTestId("approval-prompt").waitFor({ timeout: 10_000 });
  await window.screenshot({ path: join(outputDir, "04b-approval-request.png") });
  await window.getByTestId("approval-session").click();
  await window.getByTestId("approval-prompt").waitFor({ state: "detached" });
  await window.getByTestId("composer-input").waitFor({ state: "visible", timeout: 20_000 });
  await window.waitForFunction(() => !document.querySelector('[data-testid="stop-button"]'));

  await window.getByTestId("composer-input").fill("再次运行需要审批的 git commit");
  await window.getByTestId("send-button").click();
  await window.getByTestId("approval-prompt").waitFor({ timeout: 10_000 });
  await window.getByTestId("approval-deny").click();
  await window.getByText("命令已拒绝", { exact: true }).waitFor({ timeout: 10_000 });
  await window.getByTestId("approval-prompt").waitFor({ state: "detached" });
  await window.screenshot({ path: join(outputDir, "04c-approval-denied.png") });

  await window.getByRole("button", { name: "运行记录", exact: true }).click();
  await window.getByRole("button", { name: "上下文", exact: true }).click();
  await window.getByTestId("inspector").getByText("运行参数", { exact: true }).waitFor();
  await window.getByRole("button", { name: "运行", exact: true }).click();
  await window.getByText("上次运行已完成").waitFor();

  await window.keyboard.press("Control+K");
  await window.getByRole("dialog", { name: "命令面板" }).waitFor();
  await window.screenshot({ path: join(outputDir, "05-command-palette.png") });
  await window.keyboard.press("Escape");

  await window.getByRole("button", { name: "设置", exact: true }).click();
  await window.getByRole("dialog", { name: "设置" }).waitFor();
  await window.getByRole("button", { name: /雾白/ }).click();
  await window.screenshot({ path: join(outputDir, "06-settings-light.png") });
  await window.getByRole("button", { name: "数据与记忆", exact: true }).click();
  await window.getByText("在记忆页查看整理结果和待确认来源。", { exact: true }).waitFor();
  await window.screenshot({ path: join(outputDir, "06b-settings-memory.png") });
  await window.getByRole("button", { name: "模型", exact: true }).click();
  await window.getByLabel("模型名称").waitFor();
  await window.getByLabel("API Key").waitFor();
  await window.screenshot({ path: join(outputDir, "06c-settings-models.png") });
  await window.getByRole("button", { name: "更新", exact: true }).click();
  await window.getByRole("heading", { name: "软件更新", exact: true }).waitFor();
  await window.getByText("开发模式不会连接发布服务器", { exact: false }).waitFor();
  await window.screenshot({ path: join(outputDir, "06d-settings-updates.png") });
  await window.keyboard.press("Escape");

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1000, 700);
  });
  await window.waitForTimeout(350);
  const compactFit = await window.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    document: {
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    },
    composer: document.querySelector(".composer")?.getBoundingClientRect().toJSON(),
    composerDock: document.querySelector(".composer-dock")?.getBoundingClientRect().toJSON(),
    composerHint: document.querySelector(".composer-hint")?.getBoundingClientRect().toJSON(),
    header: document.querySelector(".conversation-header")?.getBoundingClientRect().toJSON(),
    threadRow: document.querySelector(".thread-row")?.getBoundingClientRect().toJSON(),
    threadSelect: document.querySelector(".thread-row-select")?.getBoundingClientRect().toJSON(),
    inspector: document.querySelector(".inspector")?.getBoundingClientRect().toJSON(),
  }));
  assert(compactFit.document.width === compactFit.viewport.width, "Compact view scrolls horizontally");
  assert(compactFit.document.height === compactFit.viewport.height, "Compact view scrolls vertically");
  assert(compactFit.composer?.bottom <= compactFit.viewport.height, "Composer is clipped in compact view");
  assert(compactFit.composerHint?.bottom <= compactFit.composerDock?.bottom, "Composer hint overlaps the window edge");
  assert(compactFit.threadSelect?.right <= compactFit.threadRow?.right, "Thread controls overflow their row");
  assert(
    !compactFit.inspector || compactFit.inspector.right <= compactFit.viewport.width,
    "Inspector drawer is clipped in compact view",
  );
  await window.screenshot({ path: join(outputDir, "07-compact-window.png") });

  await window.getByTestId("new-thread").click();
  await window.getByText("从一个清晰的目标开始。").waitFor();
  await window.getByTestId("composer-input").fill("请模拟失败状态");
  await window.getByTestId("send-button").click();
  await window.getByText("任务已暂停").waitFor({ timeout: 20_000 });
  await window.getByTestId("composer-input").waitFor({ state: "visible" });
  await window.screenshot({ path: join(outputDir, "08-recoverable-error.png") });

  await window.getByRole("button", { name: "对话", exact: true }).click();
  const chatRowsBeforeDelete = await window.locator(".thread-row").count();
  await window.locator(".thread-row").first().hover();
  await window.getByTestId("delete-thread").first().click();
  await window.getByRole("alertdialog").waitFor();
  await window.screenshot({ path: join(outputDir, "09-delete-chat-confirmation.png") });
  await window.getByRole("button", { name: "永久删除", exact: true }).click();
  await window.waitForFunction(
    (count) => document.querySelectorAll(".thread-row").length === count - 1,
    chatRowsBeforeDelete,
  );

  await window.getByRole("button", { name: "开发", exact: true }).click();
  const productivityRowsBeforeDelete = await window.locator(".thread-row").count();
  await window.locator(".thread-row").first().hover();
  await window.getByTestId("delete-thread").first().click();
  await window.getByText("SDK / ACP 中的原生会话不会被远程删除。", { exact: false }).waitFor();
  await window.getByRole("button", { name: "永久删除", exact: true }).click();
  await window.waitForFunction(
    (count) => document.querySelectorAll(".thread-row").length === count - 1,
    productivityRowsBeforeDelete,
  );
  await window.screenshot({ path: join(outputDir, "10-delete-productivity-complete.png") });

  assert(consoleErrors.length === 0, `Console errors: ${consoleErrors.join(" | ")}`);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        title: await window.title(),
        initialFit,
        compactFit,
        screenshots: outputDir,
        consoleErrors,
      },
      null,
      2,
    ),
  );
} finally {
  await window.evaluate(() => localStorage.setItem("cleo-theme", "dark")).catch(() => {});
  await electronApp.close();
}
