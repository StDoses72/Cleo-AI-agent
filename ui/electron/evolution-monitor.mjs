import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJson } from "./evolution-store.mjs";
import { EvolutionMonitorStore } from "./evolution-monitor-store.mjs";
import { launchDesktop } from "./evolution-launch.mjs";

/** Purpose: Keep a small native progress and message window alive across Cleo restarts.
 * Input: standard userData path. Output: read-only progress plus durable supplemental messages.
 * This process never edits the version registry or launches a model.
 */
export async function startEvolutionMonitor() {
  const root = join(app.getPath("userData"), "evolution");
  const store = new EvolutionMonitorStore(root);
  await app.whenReady();
  const window = new BrowserWindow({ width: 680, height: 780, minWidth: 460, minHeight: 480,
    title: "Cleo · 进化伴随窗口", autoHideMenuBar: true, backgroundColor: "#101417",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "cleo-companion",
      preload: join(dirname(fileURLToPath(import.meta.url)), "evolution-monitor-preload.cjs") } });
  const trusted = event => { if (event.sender !== window.webContents) throw new Error("无效的进化窗口。"); };
  ipcMain.handle("cleo:monitor:status", async event => {
    trusted(event);
    await writeJson(join(store.root, "presence.json"), { pid: process.pid, version: app.getVersion(), updatedAt: Date.now() });
    const [runtime, state, messages] = await Promise.all([store.runtime(), readJson(join(root, "state.json"), {}), store.messages()]);
    const tx = state.transaction;
    let phase = runtime.phase || "等待会话";
    let detail = runtime.detail || "在 Cleo 的进化工作区提出改进要求。";
    if (tx) {
      phase = tx.phase === "staged" ? "正在备份并准备切换" : "正在启动修改后的 Cleo";
      detail = "此窗口会保留。补充需求已保存，主程序就绪后在原进化会话中继续。";
    } else if (state.lastRestartError) { phase = "已恢复可用版本"; detail = state.lastRestartError; }
    else if (Date.now() - (runtime.updatedAt || 0) > 15000) {
      phase = "等待 Cleo 连接"; detail = "主程序尚未连接；补充需求仍会保存。打开 Cleo 后可继续，或使用独立恢复入口。";
    }
    const threadId = state.threadId || null;
    const connected = runtime.protocol === 2 && Date.now() - (runtime.updatedAt || 0) < 15000 && !tx;
    return { phase, detail, logs: runtime.logs || "", threadId, connected,
      thread: runtime.thread?.id === threadId ? runtime.thread : null,
      running: runtime.running, paused: await store.paused(), canDiscard: Boolean(state.iteration),
      actions: connected ? runtime.actions || null : null,
      commands: (await store.commands()).slice(-10), messages: messages.filter(m => m.threadId === threadId).slice(-30) };
  });
  ipcMain.handle("cleo:monitor:send", async (event, body) => {
    trusted(event);
    const state = await readJson(join(root, "state.json"), {});
    return store.enqueue(state.threadId, body);
  });
  ipcMain.handle("cleo:monitor:control", async (event, action, params = {}) => {
    trusted(event);
    const state = await readJson(join(root, "state.json"), {});
    const runtime = await store.runtime();
    const connected = runtime.protocol === 2 && Date.now() - (runtime.updatedAt || 0) < 15000;
    if (action === "emergency" || (action === "recovery" && !connected)) {
      const target = state.builds?.find(build => build.id === state.baseline) || state.builds?.find(build => build.id === state.active);
      if (!target?.executable) throw new Error("尚无恢复版本，请先在主窗口准备进化工作区。");
      await launchDesktop(target.executable, ["--cleo-recovery", `--user-data-dir=${app.getPath("userData")}`], { ...process.env, CLEO_EVOLUTION_CHILD: "1" });
      return;
    }
    if (!connected) throw new Error("主程序尚未连接。消息会保存，或使用“版本与恢复”打开独立恢复控制器。");
    if (action === "discard" || action === "recovery") {
      if (state.transaction) throw new Error("正在切换版本，请等待当前恢复流程结束。");
      let targetId;
      if (action === "recovery") {
        const targets = (state.builds || []).filter(build => build.savedAt || build.kind === "official" || build.baseline || build.id === state.iteration?.base).reverse();
        if (!targets.length) throw new Error("尚无可恢复的版本。");
        const selected = await dialog.showMessageBox(window, { type: "question", title: "回到可用版本", message: "选择恢复目标",
          detail: "将停止进化任务并归档本轮源码改动，再切换程序。聊天、记忆和账号数据保留。",
          buttons: [...targets.map(build => build.name || build.version || "本轮开始版本"), "取消"], cancelId: targets.length, defaultId: targets.length, noLink: true });
        if (selected.response === targets.length) return;
        targetId = targets[selected.response].id;
      } else {
        const choice = await dialog.showMessageBox(window, { type: "warning", title: "放弃本轮改动", message: "停止进化并回到本轮开始前？",
          detail: "本轮源码会归档保留，未发送的补充需求会取消；聊天、记忆和账号数据不会回滚。",
          buttons: ["取消", "放弃并恢复"], defaultId: 0, cancelId: 0, noLink: true });
        if (choice.response !== 1) return;
      }
      return store.command(action === "recovery" ? "rollback" : action, state.threadId,
        { active: state.active, iteration: state.iteration?.id || null, targetId });
    }
    if (["build", "apply", "save"].includes(action)) {
      if (state.transaction) throw new Error("正在切换版本，请等待当前流程结束。");
      if (action === "apply") {
        const choice = await dialog.showMessageBox(window, { type: "question", title: "应用改动", message: "检查已通过，现在应用吗？",
          detail: "Cleo 会重启并使用修改后的版本；聊天、记忆和配置保留。应用后可以在这里保存为本地版本。",
          buttons: ["稍后", "应用并重启"], defaultId: 1, cancelId: 0, noLink: true });
        if (choice.response !== 1) return;
      }
      const name = typeof params.name === "string" ? params.name.trim().slice(0, 80) : "";
      return store.command(action, state.threadId, action === "save" ? { name } : {});
    }
    if (!["stop", "resume", "answer"].includes(action)) throw new Error("不支持的操作。");
    if (action === "answer" && JSON.stringify(params).length > 30000) throw new Error("回答过长。");
    return store.command(action, state.threadId, action === "answer" ? { questionId: params.questionId, answers: params.answers } : {});
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  await window.loadFile(join(dirname(fileURLToPath(import.meta.url)), "evolution-monitor.html"));
  window.show();
  app.on("window-all-closed", () => app.quit());
}
