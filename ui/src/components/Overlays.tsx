import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { dreamStatusLabel } from "../memoryStatus";
import { UpdateVersionPicker } from "./UpdateVersionPicker";
import { handleDialogKeyDown, Modal } from "./Modal";
import { PermissionSelector } from "./PermissionSelector";
import { accessLabel, approvalLabel, effortLabels } from "../runtime-labels";
import {
  ArrowDownToLine,
  ArrowRight,
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  Code2,
  Command,
  Database,
  FileText,
  FolderOpen,
  MessageCircle,
  Moon,
  PanelRight,
  Plus,
  Search,
  RotateCcw,
  RefreshCw,
  Save,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import type {
  AgentInstructions,
  ApplyModelSettings,
  ModelSettings,
  MemoryOverview,
  Project,
  RuntimeProfile,
  RuntimeUpdate,
  UpdateState,
  WorkspaceSpace,
} from "../types";
import { ModelSettingsPanel, type ModelsPage } from "./model-settings/ModelSettingsPanel";
import { HarnessImportPage } from "./HarnessImportPage";

export interface CommandAction {
  id: string;
  label: string;
  hint: string;
  icon: typeof Command;
  shortcut?: string;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  actions: CommandAction[];
  onClose: () => void;
}

export function CommandPalette({ open, actions, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
    }
  }, [open]);
  const filtered = useMemo(() => {
    const value = query.trim().toLocaleLowerCase();
    return value
      ? actions.filter(
          (action) =>
            action.label.toLocaleLowerCase().includes(value) ||
            action.hint.toLocaleLowerCase().includes(value),
        )
      : actions;
  }, [actions, query]);

  if (!open) return null;
  return (
    <Modal open={open} className="overlay-backdrop" label="命令面板" onClose={onClose}>
      <div className="command-palette" onMouseDown={(event) => event.stopPropagation()}>
        <label className="command-search">
          <Search size={18} />
          <input
            autoFocus
            value={query}
            aria-label="搜索命令"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-results"
            aria-activedescendant={filtered[selectedIndex] ? `command-${filtered[selectedIndex].id}` : undefined}
            onChange={(event) => { setQuery(event.target.value); setSelectedIndex(0); }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (!filtered.length) return;
                const next = (selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + filtered.length) % filtered.length;
                setSelectedIndex(next);
                document.getElementById(`command-${filtered[next].id}`)?.scrollIntoView({ block: "nearest" });
              } else if (event.key === "Enter" && filtered[selectedIndex]) {
                event.preventDefault();
                filtered[selectedIndex].run();
                onClose();
              }
            }}
            placeholder="输入命令或搜索…"
          />
          <kbd>Esc</kbd>
        </label>
        <div className="command-results" id="command-results" role="listbox" aria-label="命令">
          <span className="command-section-label">建议</span>
          {filtered.map(({ id, label, hint, icon: Icon, shortcut, run }, index) => (
            <button
              className={index === selectedIndex ? "focused" : ""}
              id={`command-${id}`}
              role="option"
              aria-selected={index === selectedIndex}
              onMouseMove={() => setSelectedIndex(index)}
              type="button"
              key={id}
              onClick={() => {
                run();
                onClose();
              }}
            >
              <span className="command-icon"><Icon size={16} /></span>
              <span><strong>{label}</strong><small>{hint}</small></span>
              {shortcut ? <kbd>{shortcut}</kbd> : <ArrowRight size={14} />}
            </button>
          ))}
          {!filtered.length ? <div className="command-empty">没有匹配的命令</div> : null}
        </div>
        <footer><span><kbd>↑↓</kbd> 选择</span><span><kbd>↵</kbd> 打开</span></footer>
      </div>
    </Modal>
  );
}

export function RenameThreadDialog({ title, onSave, onClose }: {
  title: string;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const [name, setName] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    inputRef.current?.select();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return (
    <dialog ref={dialogRef} className="rename-dialog" aria-labelledby="rename-title" onKeyDown={handleDialogKeyDown} onCancel={(event) => {
      event.preventDefault();
      if (!savingRef.current) onClose();
    }}>
      <form onSubmit={async (event) => {
        event.preventDefault();
        if (!name.trim() || savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        setError(null);
        try {
          await onSave(name.trim());
          onClose();
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "无法重命名，请重试。");
        } finally {
          savingRef.current = false;
          setSaving(false);
        }
      }}>
        <h2 id="rename-title">重命名任务</h2>
        <label htmlFor="rename-input">名称</label>
        <input ref={inputRef} id="rename-input" autoFocus value={name} disabled={saving} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
        }} />
        {error ? <p role="alert">{error}</p> : null}
        <footer>
          <button type="button" disabled={saving} onClick={onClose}>取消</button>
          <button className="primary" type="submit" disabled={saving || !name.trim()}>{saving ? "保存中…" : "保存"}</button>
        </footer>
      </form>
    </dialog>
  );
}

interface DeleteThreadDialogProps {
  threadTitle: string | null;
  productivity: boolean;
  deleting: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteThreadDialog({
  threadTitle,
  productivity,
  deleting,
  error,
  onCancel,
  onConfirm,
}: DeleteThreadDialogProps) {
  if (!threadTitle) return null;
  return (
    <Modal open className="overlay-backdrop delete-thread-backdrop" role="alertdialog"
      labelledBy="delete-thread-title" describedBy="delete-thread-detail" onClose={deleting ? undefined : onCancel}>
      <div
        className="delete-thread-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="delete-thread-icon"><Trash2 size={18} /></span>
        <div>
          <h2 id="delete-thread-title">删除“{threadTitle}”？</h2>
          <p id="delete-thread-detail">
            永久删除此任务的本地对话记录，无法撤销。
            {productivity ? "外部客户端中的会话会保留。" : ""}
          </p>
        </div>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <footer>
          <button autoFocus type="button" onClick={onCancel} disabled={deleting}>取消</button>
          <button className="danger" type="button" onClick={onConfirm} disabled={deleting}>
            {deleting ? "删除中…" : "永久删除"}
          </button>
        </footer>
      </div>
    </Modal>
  );
}

interface RemoveProjectDialogProps {
  project: Project | null;
  removing: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function RemoveProjectDialog({
  project,
  removing,
  error,
  onCancel,
  onConfirm,
}: RemoveProjectDialogProps) {
  if (!project) return null;
  return (
    <Modal open className="overlay-backdrop delete-thread-backdrop" role="alertdialog"
      labelledBy="remove-project-title" describedBy="remove-project-detail" onClose={removing ? undefined : onCancel}>
      <div
        className="delete-thread-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="delete-thread-icon"><Trash2 size={18} /></span>
        <div>
          <h2 id="remove-project-title">移除“{project.name}”？</h2>
          <p id="remove-project-detail">
            项目会从侧边栏移除，但不会删除本地文件或 Cleo 保存的历史任务。
            以后重新打开此目录即可恢复。
          </p>
        </div>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <footer>
          <button autoFocus type="button" onClick={onCancel} disabled={removing}>取消</button>
          <button className="danger" type="button" onClick={onConfirm} disabled={removing}>
            {removing ? "移除中…" : "移除项目"}
          </button>
        </footer>
      </div>
    </Modal>
  );
}

interface SettingsModalProps {
  open: boolean;
  theme: "dark" | "light";
  motionEnabled: boolean;
  onMotionChange: (enabled: boolean) => void;
  dreamAgent: MemoryOverview["dream_agent"];
  runtime: RuntimeProfile;
  runtimeThread?: { id: string; title: string } | null;
  onPermissionsChange?: (threadId: string, update: RuntimeUpdate) => Promise<void>;
  supportedEfforts: NonNullable<RuntimeProfile["effort"]>[];
  modelSettings: ModelSettings | null;
  modelSettingsLoading: boolean;
  modelSettingsError?: string | null;
  agentInstructions: AgentInstructions | null;
  agentInstructionsLoading: boolean;
  agentInstructionsError?: string | null;
  updateState: UpdateState;
  onThemeChange: (theme: "dark" | "light") => void;
  onRuntimeChange: (update: RuntimeUpdate) => void;
  onLoadModelSettings: () => Promise<ModelSettings>;
  onApplyModelSettings: ApplyModelSettings;
  onLoadAgentInstructions: () => Promise<AgentInstructions>;
  onSaveAgentInstructions: (content: string) => Promise<AgentInstructions>;
  onCheckForUpdates: (tag?: string) => Promise<UpdateState | undefined>;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
  onRevealPath: (path: string) => void;
  onCopyConfigTemplate: (kind: "cleo" | "harnesses") => void;
  onResetWorkspace: () => void;
  onClose: () => void;
}

type SettingsPage = "appearance" | "agent" | "instructions" | "models" | "models-add" | "models-dream" | "import" | "updates" | "data";
const settingsTitles: Record<SettingsPage, string> = {
  appearance: "外观", agent: "运行设置", instructions: "对话指令", models: "当前配置",
  "models-add": "新增连接", "models-dream": "记忆整理", import: "导入", updates: "软件更新", data: "数据与记忆",
};

export function SettingsModal({
  open,
  theme,
  motionEnabled,
  onMotionChange,
  dreamAgent,
  runtime,
  runtimeThread,
  onPermissionsChange,
  supportedEfforts,
  modelSettings,
  modelSettingsLoading,
  modelSettingsError,
  agentInstructions,
  agentInstructionsLoading,
  agentInstructionsError,
  updateState,
  onThemeChange,
  onRuntimeChange,
  onLoadModelSettings,
  onApplyModelSettings,
  onLoadAgentInstructions,
  onSaveAgentInstructions,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
  onRevealPath,
  onCopyConfigTemplate,
  onResetWorkspace,
  onClose,
}: SettingsModalProps) {
  const [page, setPage] = useState<SettingsPage>("appearance");
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo(0, 0); }, [open, page]);
  useEffect(() => {
    if (open) {
      void onLoadModelSettings().catch(() => {});
      void onLoadAgentInstructions().catch(() => {});
    }
  }, [open]);
  const isModels = page === "models" || page === "models-add" || page === "models-dream";
  const modelPage: ModelsPage = page === "models-add" ? "add" : page === "models-dream" ? "dream" : "current";
  return (
    <Modal open={open} className="overlay-backdrop settings-backdrop" label="设置" onClose={onClose}>
      <div className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <button className="icon-button settings-close" aria-label="关闭设置" onClick={onClose}><X size={17} /></button>
        <aside>
          <div className="settings-brand"><span>C</span><strong>设置</strong></div>
          {window.cleoDesktop?.setup && <button type="button" onClick={() => { onClose(); window.dispatchEvent(new Event("cleo:open-setup")); }}>检查运行环境</button>}
          <nav aria-label="设置导航">
            <button className={page === "appearance" ? "active" : ""} aria-current={page === "appearance" ? "page" : undefined} type="button" onClick={() => setPage("appearance")}><Sparkles size={16} />外观</button>
            <button className={page === "agent" ? "active" : ""} aria-current={page === "agent" ? "page" : undefined} type="button" onClick={() => setPage("agent")}><SlidersHorizontal size={16} />运行设置</button>
            <button className={page === "instructions" ? "active" : ""} aria-current={page === "instructions" ? "page" : undefined} type="button" onClick={() => setPage("instructions")}><FileText size={16} />对话指令</button>
            <button className="settings-model-group" type="button" onClick={() => setPage("models")}><Plus size={16} />模型</button>
            <div className="settings-model-subnav">
              <button className={page === "models" ? "active" : ""} aria-current={page === "models" ? "page" : undefined} onClick={() => setPage("models")}><SlidersHorizontal size={15} />当前配置</button>
              <button className={page === "models-add" ? "active" : ""} aria-current={page === "models-add" ? "page" : undefined} onClick={() => setPage("models-add")}><Plus size={15} />新增连接</button>
              <button className={page === "models-dream" ? "active" : ""} aria-current={page === "models-dream" ? "page" : undefined} onClick={() => setPage("models-dream")}><Moon size={15} />记忆整理</button>
            </div>
            <button className={page === "import" ? "active" : ""} aria-current={page === "import" ? "page" : undefined} type="button" onClick={() => setPage("import")}><ArrowDownToLine size={16} />导入</button>
            <button className={page === "updates" ? "active" : ""} aria-current={page === "updates" ? "page" : undefined} type="button" onClick={() => setPage("updates")}><RefreshCw size={16} />更新</button>
            <button className={page === "data" ? "active" : ""} aria-current={page === "data" ? "page" : undefined} type="button" onClick={() => setPage("data")}><Database size={16} />数据与记忆</button>
          </nav>
        </aside>
        <section className="settings-content">
          <header className="settings-header">
            <div className="settings-breadcrumb">设置<ChevronRight size={12} />{isModels && <>模型<ChevronRight size={12} /></>}<span>{settingsTitles[page]}</span></div>
            <div className="settings-heading"><h2>{settingsTitles[page]}</h2>{page === "models" && <button className="settings-primary" onClick={() => setPage("models-add")}><Plus size={15} />新增连接</button>}</div>
          </header>
          <div className="settings-scroll" ref={scrollRef}>
          <div hidden={page !== "instructions"} className="settings-instructions-container">
            {agentInstructionsError && <p className="settings-error" role="alert">{agentInstructionsError}
              <button type="button" onClick={() => void onLoadAgentInstructions().catch(() => {})}>重试</button></p>}
            <AgentInstructionsPage instructions={agentInstructions} loading={agentInstructionsLoading}
              onSave={onSaveAgentInstructions} onRevealPath={onRevealPath} />
          </div>
          <div hidden={page !== "import"}>
            <HarnessImportPage active={open && page === "import"} onRevealPath={onRevealPath} />
          </div>
          <div hidden={!isModels}>
            <ModelSettingsPanel page={modelPage} settings={modelSettings} busy={modelSettingsLoading}
              loadError={modelSettingsError} onRetry={() => void onLoadModelSettings().catch(() => {})}
              active={open && isModels} activeProfileId={runtime.profileId} onApply={onApplyModelSettings}
              onNavigate={next => setPage(next === "current" ? "models" : next === "add" ? "models-add" : "models-dream")} />
          </div>
          {page === "appearance" ? (
            <div className="settings-page">
              <SettingsRow title="主题">
                <div className="theme-options">
                  <button className={theme === "dark" ? "active" : ""} type="button" onClick={() => onThemeChange("dark")}><span className="theme-preview dark"><Moon size={16} /></span><span>深色</span>{theme === "dark" ? <Check size={14} /> : null}</button>
                  <button className={theme === "light" ? "active" : ""} type="button" onClick={() => onThemeChange("light")}><span className="theme-preview light"><Sun size={16} /></span><span>浅色</span>{theme === "light" ? <Check size={14} /> : null}</button>
                </div>
              </SettingsRow>
              <SettingsRow title="动态效果"><label className="switch"><input type="checkbox" aria-label="动态效果" checked={motionEnabled} onChange={(event) => onMotionChange(event.target.checked)} /><span /></label></SettingsRow>
            </div>
          ) : page === "agent" ? (
            <div className="settings-page">
              {runtimeThread && <p className="settings-scope">当前任务 · {runtimeThread.title}</p>}
              <SettingsRow title="服务"><span className="settings-value">{runtime.provider}</span></SettingsRow>
              <SettingsRow title="当前任务模型">{runtime.editable === false ? <span className="settings-value">{runtime.model}</span> : <select aria-label="当前任务模型" value={runtime.model} onChange={event => onRuntimeChange({ model: event.target.value })}>{(runtime.models?.length ? runtime.models : [runtime.model]).map(model => <option key={model}>{model}</option>)}</select>}</SettingsRow>
              <SettingsRow title="思考深度"><div className="segmented-control">{supportedEfforts.length ? supportedEfforts.map((effort) => <button className={runtime.effort === effort ? "active" : ""} type="button" key={effort} onClick={() => onRuntimeChange({ effort })}>{effortLabels[effort] ?? effort}</button>) : <span className="settings-value">由模型决定</span>}</div></SettingsRow>
              <RuntimePermissions key={runtimeThread?.id ?? "draft"} runtime={runtime}
                threadId={runtimeThread?.id} onChange={onPermissionsChange} />
            </div>
          ) : page === "instructions" || page === "import" || isModels ? null : page === "updates" ? (
            <UpdateSettingsPage
              active={open}
              state={updateState}
              onCheck={onCheckForUpdates}
              onDownload={onDownloadUpdate}
              onInstall={onInstallUpdate}
            />
          ) : (
            <div className="settings-page">
              <SettingsRow title="记忆整理"><span className="settings-value">{dreamStatusLabel(dreamAgent)}</span></SettingsRow>
              <details className="settings-advanced"><summary>高级设置</summary>
                <SettingsRow title="配置模板"><div className="settings-actions"><button type="button" onClick={() => onCopyConfigTemplate("cleo")}>复制 Cleo 配置</button><button type="button" onClick={() => onCopyConfigTemplate("harnesses")}>复制运行配置</button></div></SettingsRow>
                <SettingsRow title="重置工作区" description="回到本地 main，删除未提交的改动；保留配置。"><button className="settings-action danger" type="button" onClick={() => { if (window.confirm("将仓库重置到本地 main 并清理未跟踪文件？此操作不可撤销。")) onResetWorkspace(); }}>重置工作区</button></SettingsRow>
              </details>
            </div>
          )}
          </div>
        </section>
      </div>
    </Modal>
  );
}

function RuntimePermissions({ runtime, threadId, onChange }: {
  runtime: RuntimeProfile;
  threadId?: string;
  onChange?: (threadId: string, update: RuntimeUpdate) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const pending = runtime.pendingPermissions;
  const sameProvider = !pending || pending.provider === runtime.provider;
  const change = async (update: RuntimeUpdate) => {
    if (!threadId || !onChange || inFlight.current) return;
    inFlight.current = true;
    setSaving(true); setError("");
    try { await onChange(threadId, { ...update, permissionProvider: runtime.provider }); }
    catch (error) { setError(error instanceof Error ? error.message : "权限更改未保存，请重试。"); }
    finally { inFlight.current = false; setSaving(false); }
  };
  return <>
    <PermissionSelector key={runtime.provider} runtime={runtime} disabled={saving}
      onChange={threadId && onChange ? update => onChange(threadId, update) : undefined} />
    {(["access", "approval"] as const).map(field => {
      const title = field === "access" ? "文件访问" : "审批方式";
      const label = field === "access" ? accessLabel : approvalLabel;
      const choices = runtime.permissionOptions?.[field] ?? [];
      const value = (sameProvider && pending?.[field]) || runtime[field];
      const choice = choices.find(choice => choice.value === value);
      return <SettingsRow key={field} title={title} description={choice?.description}>
        {threadId && onChange && choices.length ? <select aria-label={title} value={value} disabled={saving}
          onChange={event => void change({ [field]: event.target.value })}>
          {!choice && <option value={value}>{label(value)}</option>}
          {choices.map(choice => <option key={choice.value} value={choice.value} disabled={Boolean(choice.disabledReason)}
            title={choice.disabledReason ?? choice.description}>{choice.label}{choice.disabledReason ? "（不可用）" : ""}</option>)}
        </select> : <span className="settings-value">{label(runtime[field])}</span>}
      </SettingsRow>;
    })}
    {pending && <div className="settings-permission-pending" role="status">
      <p>{sameProvider ? `下次运行使用所选权限。当前（含补充指令）：${accessLabel(runtime.access)} · ${approvalLabel(runtime.approval)}。`
        : "待生效权限属于之前的服务，请重新选择或取消更改。"}</p>
      <button className="settings-action" disabled={saving} onClick={() => void change({ discardPendingPermissions: true })}>取消更改</button>
    </div>}
    {runtime.permissionOptions?.reason && <p className="settings-scope">{runtime.permissionOptions.reason}</p>}
    {saving && <p className="settings-scope" role="status">正在保存…</p>}
    {error && <p className="settings-error" role="alert">{error}</p>}
  </>;
}

function formatBytes(value: number) {
  if (!value) return "0 MB";
  return `${(value / (1024 * 1024)).toFixed(value >= 1024 * 1024 * 100 ? 0 : 1)} MB`;
}

function updateDescription(state: UpdateState) {
  if (state.phase === "ready" && state.installBlocked) return state.installBlocked;
  if (state.phase === "ready" && state.error) return state.error;
  if (state.operationBusy && !["checking", "downloading", "installing"].includes(state.phase)) return "另一项版本操作正在进行。";
  switch (state.phase) {
    case "unsupported": return state.error || "开发模式不会连接发布服务器；安装后的 Cleo 会自动检查。";
    case "idle": return "正在获取版本信息…";
    case "checking": return "正在检查更新…";
    case "up-to-date": return state.selectedTag ? `正在使用所选版本（${state.latestVersion}）。` : state.latestVersion ? `已是最新版本（${state.latestVersion}）。` : "已是最新版本。";
    case "available": return `${state.selectedTag ? "已选择" : "可更新至"} ${state.latestVersion}${state.selectedPrerelease ? " · 预发布版" : ""}`;
    case "downloading": return `正在下载 ${formatBytes(state.downloadedBytes)} / ${formatBytes(state.totalBytes)}。`;
    case "ready": return `Cleo ${state.latestVersion} 已准备好，点击后重启安装。`;
    case "installing": return state.installStage === "restarting" ? "正在启动新版本…" : "正在校验并解压更新…";
    case "updated": return `Cleo ${state.currentVersion} 更新成功。`;
    case "install-failed": return state.error || "安装未完成，请重新检查更新。";
    case "error": return state.error || "检查或下载更新失败。";
  }
}

function UpdateSettingsPage({
  active,
  state,
  onCheck,
  onDownload,
  onInstall,
}: {
  active: boolean;
  state: UpdateState;
  onCheck: (tag?: string) => Promise<UpdateState | undefined>;
  onDownload: () => void;
  onInstall: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const inFlight = useRef(false);
  const lastAttempt = useRef(0);
  const failures = useRef(0);
  const current = useRef({ state, onCheck });
  current.current = { state, onCheck };
  useEffect(() => { if (!state.error) setCheckError(""); }, [state.checkedAt]);
  const check = async (tag?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    lastAttempt.current = Date.now();
    setChecking(true); setCheckError("");
    try {
      const result = await current.current.onCheck(tag);
      if (result?.phase === "error") failures.current += 1;
      else failures.current = 0;
    } catch (error) {
      failures.current += 1;
      setCheckError(error instanceof Error ? error.message : "无法读取版本，请重试。");
    } finally { inFlight.current = false; setChecking(false); }
  };
  useEffect(() => {
    if (!active) return;
    const refresh = () => {
      const latest = current.current.state;
      if (document.hidden || latest.operationBusy || inFlight.current
          || !["idle", "available", "up-to-date", "updated", "error"].includes(latest.phase)) return;
      const retryAfter = failures.current || latest.phase === "error"
        ? Math.min(300000, 60000 * 2 ** Math.max(0, failures.current - 1)) : 300000;
      if (Date.now() - Math.max(latest.checkedAt ?? 0, lastAttempt.current) < retryAfter) return;
      void check();
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 30000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(timer);
    };
  }, [active, state.phase, state.operationBusy]);
  const percent = state.totalBytes
    ? Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100))
    : 0;
  const busy = checking || state.operationBusy || state.phase === "checking" || state.phase === "downloading" || state.phase === "installing";
  let action: { label: string; run: () => void } | null = null;
  if (checkError || ["error", "install-failed"].includes(state.phase)) action = { label: "重试", run: () => void check() };
  else if (state.phase === "available") action = { label: "下载更新", run: onDownload };
  else if (state.phase === "ready") action = { label: "重启并安装", run: onInstall };
  else if (state.phase === "downloading") action = { label: "正在下载…", run: onDownload };
  else if (state.phase === "installing") action = { label: "正在安装…", run: onInstall };
  return (
    <div className="settings-page update-settings-page">
      <div className="update-hero">
        <div><h3>Cleo {state.currentVersion}{state.currentPrerelease ? " · 预发布版" : ""}</h3>
          <p role={checkError || ["error", "install-failed"].includes(state.phase) ? "alert" : "status"}>{checkError || updateDescription(state)}</p></div>
      </div>
      {state.phase === "downloading" ? <div className="update-progress" aria-label={`更新下载进度 ${percent}%`}><i style={{ width: `${percent}%` }} /></div> : null}
      {action && <div className="update-actions">
        <button type="button" disabled={busy || (state.phase === "ready" && Boolean(state.installBlocked))} onClick={action.run}>{action.label}</button>
      </div>}
      {["available", "ready"].includes(state.phase) && <p className="update-data-note">更新会保留聊天、记忆与配置。</p>}
      <UpdateVersionPicker state={state} busy={Boolean(busy)} onSelect={tag => void check(tag)} />
      {state.dependencies && <details className="settings-advanced"><summary>运行依赖{state.dependencies.phase === "error" ? " · 更新未完成" : ""}</summary><p>{
        state.dependencies.phase === "ready" ? "运行依赖已更新并通过检查，下次启动自动生效。"
          : state.dependencies.phase === "error" ? `依赖更新未完成，继续使用当前版本。${state.dependencies.error || ""}`
            : ["checking", "updating"].includes(state.dependencies.phase) ? "正在后台检查并更新 SDK 和浏览器工具…"
              : "当前使用已验证的运行依赖。"
      }</p></details>}
    </div>
  );
}

export function UpdateNotice({
  state,
  onDownload,
  onInstall,
}: {
  state: UpdateState;
  onDownload: () => void;
  onInstall: () => void;
}) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const result = state.phase === "updated" || state.phase === "install-failed";
  const resultKey = `${state.phase}:${state.latestVersion}:${state.error}`;
  if (result && dismissed === resultKey) return null;
  if (!(["available", "downloading", "ready", "installing", "updated", "install-failed"] as UpdateState["phase"][]).includes(state.phase)) return null;
  const percent = state.totalBytes
    ? Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100))
    : 0;
  const titles: Partial<Record<UpdateState["phase"], string>> = {
    available: `Cleo ${state.latestVersion} 可用`, ready: "更新已准备好",
    installing: "正在准备安装", updated: "更新成功", "install-failed": "更新未完成",
  };
  return (
    <aside className={`update-notice${minimized ? " update-notice-minimized" : ""}`} role="status">
      {minimized ? <button type="button" aria-label="展开更新提示" aria-expanded={false} onClick={() => setMinimized(false)}>
        <RefreshCw size={14} />{titles[state.phase] ?? `下载更新 · ${percent}%`}
      </button> : <>
      <span className="update-notice-icon"><RefreshCw size={16} /></span>
      <div>
        <strong>{titles[state.phase] ?? `正在下载更新 · ${percent}%`}</strong>
        <small>{result || state.phase === "installing" || state.phase === "ready" || state.operationBusy ? updateDescription(state) : state.phase === "available" ? "下载并校验后可安装" : `${formatBytes(state.downloadedBytes)} / ${formatBytes(state.totalBytes)}`}</small>
      </div>
      {state.phase === "available" ? <button type="button" disabled={state.operationBusy} onClick={onDownload}>下载</button> : null}
      {state.phase === "ready" ? <button type="button" disabled={state.operationBusy || Boolean(state.installBlocked)} onClick={onInstall}>重启安装</button> : null}
      {result ? <button type="button" onClick={() => setDismissed(resultKey)}>关闭</button> : null}
      <button type="button" aria-label="最小化更新提示" title="最小化更新提示" aria-expanded={true} onClick={() => setMinimized(true)}>−</button>
      </>}
    </aside>
  );
}

function AgentInstructionsPage({
  instructions,
  loading,
  onSave,
  onRevealPath,
}: {
  instructions: AgentInstructions | null;
  loading: boolean;
  onSave: (content: string) => Promise<AgentInstructions>;
  onRevealPath: (path: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [baseline, setBaseline] = useState("");
  const baselineRef = useRef("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!instructions) return;
    const previousBaseline = baselineRef.current;
    setDraft(current => current === previousBaseline ? instructions.content : current);
    baselineRef.current = instructions.content;
    setBaseline(instructions.content);
    setError(null);
  }, [instructions]);
  const dirty = draft !== baseline;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!dirty || loading) return;
    setError(null);
    try {
      const result = await onSave(draft);
      setBaseline(result.content);
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存 对话指令");
    }
  };
  return (
    <form className="settings-page agent-instructions-page" onSubmit={submit}>
      <div className="agent-instructions-intro">
        <div>
          <p>仅用于普通对话，不影响开发任务。</p>
        </div>
        <button type="button" disabled={!instructions?.path} onClick={() => instructions?.path && onRevealPath(instructions.path)}><FolderOpen size={14} />打开位置</button>
      </div>
      <code className="agent-instructions-path">{instructions?.path ?? (loading ? "正在读取…" : "尚未读取指令")}</code>
      <textarea
        aria-label="对话指令内容"
        spellCheck={false}
        value={draft}
        disabled={!instructions && loading}
        placeholder={loading ? "正在读取…" : "在这里写入 AGENTS.md 指令"}
        onChange={(event) => { setDraft(event.target.value); setSaved(false); }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <footer>
        <span className={error ? "error" : ""}>{error ?? (saved ? "已保存，后续对话生效。" : instructions?.exists === false ? "保存后会创建 AGENTS.md。" : dirty ? "有未保存修改" : "未修改")}</span>
        <div>
          <button type="button" disabled={!dirty || loading} onClick={() => { setDraft(baseline); setError(null); setSaved(false); }}><RotateCcw size={14} />撤销修改</button>
          <button className="primary" type="submit" disabled={!dirty || loading}><Save size={14} />{loading ? "保存中…" : "保存"}</button>
        </div>
      </footer>
    </form>
  );
}

function SettingsRow({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <div className="settings-row"><div><strong>{title}</strong>{description && <p>{description}</p>}</div><div className="settings-control">{children}</div></div>;
}

export function LoadingScreen({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  return (
    <div className="loading-screen">
      <div className="loading-brand"><span>C</span></div>
      {error ? <><strong>无法打开工作区</strong><p>{error}</p><button onClick={onRetry}>重试</button></> : <><div className="loading-line"><i /></div><span>正在打开本地工作区</span></>}
    </div>
  );
}

export function Toast({ message, tone = "success" }: { message: string; tone?: "success" | "error" }) {
  return (
    <div className={`toast ${tone}`} role={tone === "error" ? "alert" : "status"}>
      {tone === "error" ? <CircleAlert size={14} /> : <Check size={14} />}
      <span>{message}</span>
    </div>
  );
}

export const commandIcons = {
  plus: Plus,
  chat: MessageCircle,
  code: Code2,
  memory: Brain,
  inspector: PanelRight,
  settings: Settings2,
};

export const spaceLabels: Record<WorkspaceSpace, string> = {
  chat: "对话",
  productivity: "开发",
  memory: "记忆",
};
