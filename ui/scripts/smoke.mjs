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

  await window.locator(".project-picker").click();
  await window.getByTestId("choose-workspace").waitFor();
  await window.locator(".project-picker").click();

  await window.getByRole("button", { name: "对话", exact: true }).click();
  await window.getByRole("heading", { name: "对话", exact: true }).waitFor();
  await window.getByTestId("new-thread").click();
  await window.getByText("从一个清晰的目标开始。").waitFor();
  await window.getByTestId("runtime-selector").click();
  await window.getByText("gpt-5.4-mini", { exact: true }).click();
  await window.getByTestId("runtime-selector").getByText("gpt-5.4-mini", { exact: true }).waitFor();

  await window.getByRole("button", { name: "记忆", exact: true }).click();
  await window.getByTestId("memory-view").waitFor();
  await window.getByText("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2").waitFor();
  await window.getByTestId("memory-nav-projects").click();
  await window.getByRole("heading", { name: "项目记忆", exact: true }).waitFor();
  await window.getByRole("button", { name: /Cleo-AI-agent/ }).click();
  await window.getByText("Cleo 是 local-first runtime", { exact: true }).click();
  await window.getByText("原始证据", { exact: true }).waitFor();
  await window.getByTestId("memory-nav-pending").click();
  await window.getByRole("heading", { name: "待确认", exact: true }).waitFor();
  const reviewRowsBefore = await window.getByTestId("memory-review-list").locator("article").count();
  await window.getByTestId("memory-review-confirm").first().click();
  await window.waitForFunction(
    (count) => document.querySelectorAll('[data-testid="memory-review-list"] article').length === count - 1,
    reviewRowsBefore,
  );
  await window.screenshot({ path: join(outputDir, "02-memory.png") });

  await window.getByRole("button", { name: "开发", exact: true }).click();
  await window.getByTestId("conversation").waitFor();
  await window.getByTestId("new-thread").click();
  await window.getByText("从一个清晰的目标开始。").waitFor();
  await window.getByTestId("runtime-selector").click();
  await window.getByText("codex", { exact: true }).click();
  await window.getByText("GPT-5.6-Terra", { exact: true }).waitFor();
  await window.screenshot({ path: join(outputDir, "03-runtime-selector.png") });
  await window.getByText("GPT-5.6-Terra", { exact: true }).click();
  await window.getByTestId("runtime-selector").getByText("gpt-5.6-terra", { exact: true }).waitFor();
  await window.getByTestId("effort-selector").selectOption("low");
  assert(await window.getByTestId("effort-selector").inputValue() === "low", "Draft effort was not selectable");
  await window.screenshot({ path: join(outputDir, "03-new-thread.png") });

  await window.getByTestId("composer-input").fill("检查当前 mock 边界并完成一次可见的运行");
  await window.getByTestId("send-button").click();
  await window.getByTestId("stop-button").waitFor();
  await window.getByText("真实后端接入后，这些事件会保持同一结构从 IPC bridge 流入").waitFor({ timeout: 20_000 });
  await window.getByText("2 个文件").waitFor();
  assert(await window.getByTestId("effort-selector").inputValue() === "low", "Created thread did not keep draft effort");
  await window.screenshot({ path: join(outputDir, "04-completed-turn.png") });

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
  await window.getByText("memory_gate.model", { exact: false }).waitFor();
  await window.getByText("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2").waitFor();
  await window.screenshot({ path: join(outputDir, "06b-settings-memory.png") });
  await window.getByRole("button", { name: "模型", exact: true }).click();
  await window.getByLabel("模型名称").waitFor();
  await window.getByLabel("API Key").waitFor();
  await window.screenshot({ path: join(outputDir, "06c-settings-models.png") });
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
    header: document.querySelector(".conversation-header")?.getBoundingClientRect().toJSON(),
  }));
  assert(compactFit.document.width === compactFit.viewport.width, "Compact view scrolls horizontally");
  assert(compactFit.document.height === compactFit.viewport.height, "Compact view scrolls vertically");
  assert(compactFit.composer?.bottom <= compactFit.viewport.height, "Composer is clipped in compact view");
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
