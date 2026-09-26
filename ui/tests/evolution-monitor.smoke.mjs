import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { EvolutionMonitorStore } from "../electron/evolution-monitor-store.mjs";
import { writeJson } from "../electron/evolution-store.mjs";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "cleo-monitor-native-"));
const root = join(scratch, "profile", "evolution");
const store = new EvolutionMonitorStore(root);
const env = { ...process.env, CLEO_DESKTOP_MOCK: "1", CLEO_HOME: join(scratch, "data") };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  await store.publish({ threadId: "test-session", phase: "正在检查", detail: "原程序退出后窗口仍可保存消息。" });
  await writeJson(join(root, "state.json"), { threadId: "test-session", transaction: { phase: "staged" } });
  app = await electron.launch({ executablePath: join(ui, "node_modules/electron/dist/electron.exe"), args: [ui, "--cleo-evolution-monitor", `--user-data-dir=${join(scratch, "profile")}`], env });
  const page = await app.firstWindow();
  await page.getByText("正在备份并准备切换", { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "补充需求" }).fill("重启时补充：保留之前的布局");
  await page.getByRole("button", { name: "发送补充需求" }).click();
  await page.getByText("已保存 · 等待会话空闲", { exact: true }).waitFor();
  const restartedApp = new EvolutionMonitorStore(root);
  assert.equal((await restartedApp.pending("test-session")).body, "重启时补充：保留之前的布局");
  await writeJson(join(root, "state.json"), { threadId: "test-session", transaction: null });
  await restartedApp.publish({ protocol: 2, threadId: "test-session", phase: "会话就绪", detail: "新版已连接", thread: {
    id: "test-session", items: [
      { id: "user", type: "message", role: "user", content: "请检查进化工作区" },
      { id: "tool", type: "tool", name: "读取源文件", command: "git status", output: "工作区检查完成", status: "done" },
      { id: "assistant", type: "message", role: "assistant", content: "已检查代码，准备调整窗口布局。" },
    ], pendingQuestions: [{ id: "question", status: "pending", questions: [{ id: "layout", question: "窗口默认多宽？", options: [{ label: "紧凑", description: "适合并排查看" }] }] }],
  } });
  await page.getByText("新版已连接", { exact: true }).waitFor();
  await page.getByText("已检查代码，准备调整窗口布局。", { exact: true }).waitFor();
  await page.getByText("⌁ 读取源文件 · 完成", { exact: true }).click();
  await page.getByText("工作区检查完成", { exact: true }).waitFor();
  await page.getByRole("radio", { name: /紧凑/ }).check();
  await page.getByRole("button", { name: "提交回答" }).click();
  await page.getByRole("button", { name: "■ 停止执行" }).click();
  await page.waitForFunction(async () => (await window.cleoMonitor.status()).commands.some(command => command.action === "stop"));
  const commands = await restartedApp.commands();
  assert.deepEqual(commands.map(command => command.action), ["answer", "stop"]);
  assert.deepEqual(commands[0].params.answers, { layout: ["紧凑"] });
  for (const command of commands) await restartedApp.commandResult(command.id, "completed");

  // Check -> save sit left of "版本与恢复" and use the main program's readiness.
  const header = page.locator("header .header-actions button:visible");
  const ready = { protocol: 2, threadId: "test-session", phase: "会话就绪", detail: "改动待检查", thread: null };
  await restartedApp.publish({ ...ready, actions: { needsCheck: true, suggestedName: "0.5.19" } });
  await page.getByRole("button", { name: "检查改动" }).waitFor();
  assert.deepEqual(await header.allTextContents(), ["检查改动", "版本与恢复"]);
  await page.waitForFunction(() => !document.getElementById("check").disabled);
  await page.getByRole("button", { name: "检查改动" }).click();
  await page.waitForFunction(async () => (await window.cleoMonitor.status()).commands.some(command => command.action === "build"));
  for (const command of await restartedApp.commands()) await restartedApp.commandResult(command.id, "completed");
  await restartedApp.publish({ ...ready, detail: "已应用", actions: { canSave: true, suggestedName: "0.5.19" } });
  await page.getByRole("button", { name: "保存版本" }).waitFor();
  assert.deepEqual(await header.allTextContents(), ["保存版本", "版本与恢复"]);
  await page.waitForFunction(() => !document.getElementById("save").disabled);
  await page.getByRole("button", { name: "保存版本" }).click();
  assert.equal(await page.getByRole("textbox", { name: "版本名称" }).getAttribute("placeholder"), "默认：0.5.19");
  if (process.env.CLEO_SMOKE_OUTPUT) await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "evolution-monitor-save.png") });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.waitForFunction(async () => (await window.cleoMonitor.status()).commands.some(command => command.action === "save"));
  const save = (await restartedApp.commands()).find(command => command.action === "save");
  assert.deepEqual(save.params, { name: "" });
  if (process.env.CLEO_SMOKE_OUTPUT) await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "evolution-monitor.png") });
  console.log("PASS: native independent monitor, restart progress, durable supplemental messages and reconnection");
} finally {
  await app?.close();
  assert.equal(dirname(scratch), resolve(tmpdir()));
  await rm(scratch, { recursive: true, force: true });
}
