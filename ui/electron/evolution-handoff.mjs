/** Purpose: Keep switching code independent of windows and never restore user data.
 * Input: store and launch/health/termination/progress hooks.
 * Output: success only after a selected or fallback program acknowledges startup; failure leaves recovery to the caller.
 */
export async function runHandoff(store, hooks) {
  const initial = await store.read();
  if (!initial.transaction) return { ok: false, error: "没有待完成的版本切换。" };
  const targets = [...new Set([initial.transaction.to, initial.transaction.from, initial.baseline].filter(Boolean))];
  let detail = "";
  for (let index = 0; index < targets.length; index += 1) {
    let child;
    try {
      const build = await hooks.withLock(async () => {
        if (index) {
          await store.recover(targets[index]);
          await store.stage(targets[index]);
        }
        return store.activate();
      });
      const transaction = (await store.read()).transaction;
      await hooks.progress(index ? "正在恢复可用版本" : "正在启动修改后的 Cleo",
        index ? "新版本没有成功启动，正在自动回退。你的数据保持不变。" : "确认主界面和后端就绪后，此窗口会自动关闭。");
      child = await hooks.launch(build, transaction.id);
      if (await hooks.waitHealthy(child, transaction.id, build.id)) {
        await store.update({ lastRestartError: index ? "上次应用未成功，已自动回到可用版本。可以继续修改或重新应用。" : null });
        return { ok: true, recovered: index > 0, active: build.id };
      }
      throw new Error("程序未在规定时间内完成启动检查。");
    } catch (error) {
      detail = error.message;
      if (child) {
        try { await hooks.stop(child); }
        catch { return { ok: false, error: "新程序尚未完全退出。恢复入口将保持打开，请关闭该程序后重试。" }; }
      }
    }
  }
  return { ok: false, error: detail || "没有版本成功启动，请选择其他可用版本。" };
}
