import { t as tr } from "../../electron/i18n.mjs";
import { useCallback, useEffect, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, FolderOpen, RefreshCw } from "lucide-react";
import { cleoClient } from "../services/cleoClient";
import type { HarnessSyncItem, HarnessSyncStatus } from "../types";

const harnessNames: Record<string, string> = { claude: "Claude", codex: "Codex" };
const kindLabels: Record<string, string> = {
  get skills() { return tr("harnessimportpage.skills"); }, get agents() { return tr("harnessimportpage.subagents"); }, get commands() { return tr("approvalprompt.command"); }, get rules() { return tr("harnessimportpage.rules"); }, get prompts() { return tr("harnessimportpage.prompts"); }, get instructions() { return tr("harnessimportpage.instruction_files"); },
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
      const target = direction === "import" ? "Cleo" : tr("computerpanel.this_computer");
      setNotice(tr("harnessimportpage.value_copied_value_items_to_value", { p0: harnessNames[harness], p1: result.copied.length, p2: target }) +
        (result.skipped.length ? tr("harnessimportpage.skipped_value_existing_destination_items_without_overwriting_them", { p0: result.skipped.length }) : "") + "。");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  return <div className="settings-page harness-sync">
    <div className="harness-sync-toolbar">
      <button type="button" disabled={loading || busy} onClick={() => void load()}><RefreshCw size={14} />{loading ? tr("dependencysetup.checking") : tr("dependencysetup.check_again")}</button>
    </div>
    {error && <p className="settings-error" role="alert">{error}</p>}
    {notice && <p className="settings-success" role="status">{notice}</p>}
    {!statuses && loading && <p role="status">{tr("harnessimportpage.comparing_local_and_cleo_configurations")}</p>}
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
      return <section key={status.harness} className="harness-sync-card" aria-label={tr("harnessimportpage.value_configuration_comparison", { p0: harnessNames[status.harness] })}>
        <header>
          <strong>{harnessNames[status.harness]}</strong>
          <span className={inSync ? "harness-sync-badge ok" : "harness-sync-badge"}>{!status.localExists ? tr("harnessimportpage.not_installed_locally") : inSync ? tr("harnessimportpage.up_to_date") : tr("harnessimportpage.differences_found")}</span>
        </header>
        <div className="harness-sync-paths">
          <span>{tr("harnessimportpage.local")}{status.localPath}</span>{status.localExists && <button type="button" aria-label={tr("harnessimportpage.open_the_local_value_directory", { p0: harnessNames[status.harness] })} onClick={() => onRevealPath(status.localPath)}><FolderOpen size={13} /></button>}
          <span>Cleo：{status.cleoPath}</span><button type="button" aria-label={tr("harnessimportpage.open_cleo_s_value_directory", { p0: harnessNames[status.harness] })} onClick={() => onRevealPath(status.cleoPath)}><FolderOpen size={13} /></button>
        </div>
        <p className="harness-sync-summary">{tr("harnessimportpage.matching")}{same.length} {tr("harnessimportpage.local_only")}{localOnly.length} {tr("harnessimportpage.cleo_only")}{cleoOnly.length} {tr("harnessimportpage.different_contents")}{different.length}</p>
        {status.localExists && localOnly.length > 0 && <div className="harness-sync-group">
          <h4>{tr("harnessimportpage.available_locally_missing_in_cleo")}</h4>{list(localOnly, true)}
          <button type="button" className="settings-primary" disabled={busy || !selected(localOnly).length}
            onClick={() => void run(status.harness, "import", selected(localOnly))}><ArrowDownToLine size={14} />{tr("harnessimportpage.import_into_cleo")}</button>
        </div>}
        {status.localExists && cleoOnly.length > 0 && <div className="harness-sync-group">
          <h4>{tr("harnessimportpage.available_in_cleo_missing_locally")}</h4>{list(cleoOnly, true)}
          <button type="button" disabled={busy || !selected(cleoOnly).length}
            onClick={() => void run(status.harness, "export", selected(cleoOnly))}><ArrowUpFromLine size={14} />{tr("harnessimportpage.export_to_local_installation")}</button>
        </div>}
        {different.length > 0 && <div className="harness-sync-group">
          <h4>{tr("harnessimportpage.same_name_different_contents")}</h4>{list(different, false)}
        </div>}
        {status.localExists && status.settings.missingInCleo.length > 0 && <div className="harness-sync-group">
          <h4>{tr("harnessimportpage.local_2")}{status.settings.file} {tr("harnessimportpage.settings_missing_in_cleo")}</h4>
          <p className="harness-sync-keys">{status.settings.missingInCleo.join("、")}</p>
          <button type="button" disabled={busy} onClick={() => void run(status.harness, "import", [], true)}><ArrowDownToLine size={14} />{tr("harnessimportpage.import_these_settings")}</button>
        </div>}
      </section>;
    })}
  </div>;
}
