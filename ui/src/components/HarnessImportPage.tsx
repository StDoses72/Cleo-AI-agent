import { useCallback, useEffect, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, FolderOpen, RefreshCw } from "lucide-react";
import { cleoClient } from "../services/cleoClient";
import type { HarnessSyncItem, HarnessSyncStatus } from "../types";

const harnessNames: Record<string, string> = { claude: "Claude", codex: "Codex" };
const kindLabels: Record<string, string> = {
  skills: "技能", agents: "子 agent", commands: "命令", rules: "规则", prompts: "提示词", instructions: "指令文件",
};

/** Purpose: Compare Cleo's own harness directories with the local Claude/Codex setup and copy
 * chosen items either way. Input: whether the page is visible. Output: explicit, non-overwriting copies.
 */
export function HarnessImportPage({ active, onRevealPath }: { active: boolean; onRevealPath: (path: string) => void }) {
  const [statuses, setStatuses] = useState<HarnessSyncStatus[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unselected, setUnselected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setStatuses(await cleoClient.getHarnessSync()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { if (active) void load(); }, [active, load]);

  const toggle = (key: string) => setUnselected(previous => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const run = async (harness: string, direction: "import" | "export", items: string[], settings = false) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await cleoClient.syncHarnessItems(harness, direction, items, settings);
      const target = direction === "import" ? "Cleo" : "本机";
      setNotice(`${harnessNames[harness]}：已复制 ${result.copied.length} 项到${target}` +
        (result.skipped.length ? `，${result.skipped.length} 项因目标已存在而跳过（不会覆盖）` : "") + "。");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  return <div className="settings-page harness-sync">
    <p className="settings-note">Cleo 在自己的目录中保存 Claude 与 Codex 的技能、指令和设置。这里可以对比本机 harness 的配置，把新增内容导入 Cleo，或把 Cleo 中新增的内容导出回本机。复制只补充缺少的项目，不会覆盖任何一方已有的文件；登录凭据、插件和会话历史不在同步范围内。</p>
    <div className="harness-sync-toolbar">
      <button type="button" disabled={loading || busy} onClick={() => void load()}><RefreshCw size={14} />{loading ? "正在检查…" : "重新检查"}</button>
    </div>
    {error && <p className="settings-error" role="alert">{error}</p>}
    {notice && <p className="settings-success" role="status">{notice}</p>}
    {!statuses && loading && <p role="status">正在对比本机与 Cleo 的配置…</p>}
    {statuses?.map(status => {
      const group = (state: HarnessSyncItem["state"]) => status.items.filter(item => item.state === state);
      const localOnly = group("local_only"), cleoOnly = group("cleo_only"), different = group("different"), same = group("same");
      const selected = (items: HarnessSyncItem[]) => items.filter(item => !unselected.has(`${status.harness}:${item.id}`)).map(item => item.id);
      const inSync = !localOnly.length && !cleoOnly.length && !different.length && !status.settings.missingInCleo.length;
      const list = (items: HarnessSyncItem[], selectable: boolean) => <ul className="harness-sync-list">
        {items.map(item => {
          const key = `${status.harness}:${item.id}`;
          return <li key={item.id}>
            {selectable ? <label><input type="checkbox" checked={!unselected.has(key)} disabled={busy} onChange={() => toggle(key)} />
              <span>{item.name}</span></label> : <span>{item.name}</span>}
            <small>{kindLabels[item.kind] || item.kind}</small>
          </li>;
        })}
      </ul>;
      return <section key={status.harness} className="harness-sync-card" aria-label={`${harnessNames[status.harness]} 配置对比`}>
        <header>
          <strong>{harnessNames[status.harness]}</strong>
          <span className={inSync ? "harness-sync-badge ok" : "harness-sync-badge"}>{!status.localExists ? "本机未安装" : inSync ? "已一致" : "有差异"}</span>
        </header>
        <div className="harness-sync-paths">
          <span>本机：{status.localPath}</span>{status.localExists && <button type="button" aria-label={`打开本机 ${harnessNames[status.harness]} 目录`} onClick={() => onRevealPath(status.localPath)}><FolderOpen size={13} /></button>}
          <span>Cleo：{status.cleoPath}</span><button type="button" aria-label={`打开 Cleo 的 ${harnessNames[status.harness]} 目录`} onClick={() => onRevealPath(status.cleoPath)}><FolderOpen size={13} /></button>
        </div>
        <p className="harness-sync-summary">相同 {same.length} · 本机新增 {localOnly.length} · Cleo 新增 {cleoOnly.length} · 内容不同 {different.length}</p>
        {status.localExists && localOnly.length > 0 && <div className="harness-sync-group">
          <h4>本机有、Cleo 没有</h4>{list(localOnly, true)}
          <button type="button" className="settings-primary" disabled={busy || !selected(localOnly).length}
            onClick={() => void run(status.harness, "import", selected(localOnly))}><ArrowDownToLine size={14} />导入到 Cleo</button>
        </div>}
        {status.localExists && cleoOnly.length > 0 && <div className="harness-sync-group">
          <h4>Cleo 有、本机没有</h4>{list(cleoOnly, true)}
          <button type="button" disabled={busy || !selected(cleoOnly).length}
            onClick={() => void run(status.harness, "export", selected(cleoOnly))}><ArrowUpFromLine size={14} />导出到本机</button>
        </div>}
        {different.length > 0 && <div className="harness-sync-group">
          <h4>同名但内容不同</h4>{list(different, false)}
          <p className="settings-note">两边都保留，不会自动覆盖。如需统一，请打开对应目录手动替换。</p>
        </div>}
        {status.localExists && status.settings.missingInCleo.length > 0 && <div className="harness-sync-group">
          <h4>本机 {status.settings.file} 中 Cleo 缺少的设置</h4>
          <p className="harness-sync-keys">{status.settings.missingInCleo.join("、")}</p>
          <button type="button" disabled={busy} onClick={() => void run(status.harness, "import", [], true)}><ArrowDownToLine size={14} />导入这些设置</button>
        </div>}
      </section>;
    })}
  </div>;
}
