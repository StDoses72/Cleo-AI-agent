import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Brain,
  Check,
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
  UpdateState,
  WorkspaceSpace,
} from "../types";
import { ModelSettingsPanel, type ModelsPage } from "./model-settings/ModelSettingsPanel";

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
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 30);
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
    <div className="overlay-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="command-palette" role="dialog" aria-label="命令面板" onMouseDown={(event) => event.stopPropagation()}>
        <label className="command-search">
          <Search size={18} />
          <input
            ref={inputRef}
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
    </div>
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
    dialogRef.current?.showModal();
    inputRef.current?.select();
  }, []);
  return (
    <dialog ref={dialogRef} className="rename-dialog" aria-labelledby="rename-title" onCancel={(event) => {
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
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteThreadDialog({
  threadTitle,
  productivity,
  deleting,
  onCancel,
  onConfirm,
}: DeleteThreadDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (threadTitle) window.setTimeout(() => cancelRef.current?.focus(), 30);
  }, [threadTitle]);
  if (!threadTitle) return null;
  return (
    <div className="overlay-backdrop delete-thread-backdrop" role="presentation" onMouseDown={deleting ? undefined : onCancel}>
      <div
        className="delete-thread-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-thread-title"
        aria-describedby="delete-thread-detail"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="delete-thread-icon"><Trash2 size={18} /></span>
        <div>
          <span className="eyebrow">DELETE THREAD</span>
          <h2 id="delete-thread-title">删除“{threadTitle}”？</h2>
          <p id="delete-thread-detail">
            此操作会永久删除 Cleo 保存的 thread 与本地历史记录，无法撤销。
            {productivity ? " SDK / ACP 中的原生会话不会被远程删除。" : ""}
          </p>
        </div>
        <footer>
          <button ref={cancelRef} type="button" onClick={onCancel} disabled={deleting}>取消</button>
          <button className="danger" type="button" onClick={onConfirm} disabled={deleting}>
            {deleting ? "删除中…" : "永久删除"}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface RemoveProjectDialogProps {
  project: Project | null;
  removing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function RemoveProjectDialog({
  project,
  removing,
  onCancel,
  onConfirm,
}: RemoveProjectDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (project) window.setTimeout(() => cancelRef.current?.focus(), 30);
  }, [project]);
  if (!project) return null;
  return (
    <div className="overlay-backdrop delete-thread-backdrop" role="presentation" onMouseDown={removing ? undefined : onCancel}>
      <div
        className="delete-thread-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="remove-project-title"
        aria-describedby="remove-project-detail"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="delete-thread-icon"><Trash2 size={18} /></span>
        <div>
          <span className="eyebrow">REMOVE PROJECT</span>
          <h2 id="remove-project-title">移除“{project.name}”？</h2>
          <p id="remove-project-detail">
            项目会从侧边栏移除，但不会删除本地文件或 Cleo 保存的历史任务。
            以后重新打开此目录即可恢复。
          </p>
        </div>
        <footer>
          <button ref={cancelRef} type="button" onClick={onCancel} disabled={removing}>取消</button>
          <button className="danger" type="button" onClick={onConfirm} disabled={removing}>
            {removing ? "移除中…" : "移除项目"}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface SettingsModalProps {
  open: boolean;
  theme: "dark" | "light";
  motionEnabled: boolean;
  onMotionChange: (enabled: boolean) => void;
  dreamAgent: MemoryOverview["dream_agent"];
  runtime: RuntimeProfile;
  supportedEfforts: NonNullable<RuntimeProfile["effort"]>[];
  modelSettings: ModelSettings | null;
  modelSettingsLoading: boolean;
  agentInstructions: AgentInstructions | null;
  agentInstructionsLoading: boolean;
  updateState: UpdateState;
  onThemeChange: (theme: "dark" | "light") => void;
  onRuntimeChange: (update: Partial<RuntimeProfile>) => void;
  onLoadModelSettings: () => Promise<ModelSettings>;
  onApplyModelSettings: ApplyModelSettings;
  onLoadAgentInstructions: () => Promise<AgentInstructions>;
  onSaveAgentInstructions: (content: string) => Promise<AgentInstructions>;
  onCheckForUpdates: () => void;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
  onRevealPath: (path: string) => void;
  onCopyConfigTemplate: (kind: "cleo" | "harnesses") => void;
  onResetWorkspace: () => void;
  onClose: () => void;
}

type SettingsPage = "appearance" | "agent" | "instructions" | "models" | "models-add" | "models-dream" | "updates" | "data";

export function SettingsModal({
  open,
  theme,
  motionEnabled,
  onMotionChange,
  dreamAgent,
  runtime,
  supportedEfforts,
  modelSettings,
  modelSettingsLoading,
  agentInstructions,
  agentInstructionsLoading,
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
  useEffect(() => {
    if (open) {
      void onLoadModelSettings();
      void onLoadAgentInstructions();
    }
  }, [open]);
  if (!open) return null;
  const isModels = page === "models" || page === "models-add" || page === "models-dream";
  const modelPage: ModelsPage = page === "models-add" ? "add" : page === "models-dream" ? "dream" : "current";
  return (
    <div className="overlay-backdrop settings-backdrop" role="presentation" onMouseDown={onClose}>
      <div className={`settings-modal ${isModels ? "settings-models" : ""}`} role="dialog" aria-label="设置" onMouseDown={(event) => event.stopPropagation()}>
        {isModels && <button className="icon-button model-settings-close" aria-label="关闭设置" onClick={onClose}><X size={17} /></button>}
        <aside>
          <div className="settings-brand"><span>C</span><strong>设置</strong></div>
          <nav>
            <button className={page === "appearance" ? "active" : ""} type="button" onClick={() => setPage("appearance")}><Sparkles size={16} />外观</button>
            <button className={page === "agent" ? "active" : ""} type="button" onClick={() => setPage("agent")}><SlidersHorizontal size={16} />Agent</button>
            <button className={page === "instructions" ? "active" : ""} type="button" onClick={() => setPage("instructions")}><FileText size={16} />Agent 指令</button>
            <button className={isModels ? "active" : ""} type="button" onClick={() => setPage("models")}><Plus size={16} />模型</button>
            {isModels && <div className="settings-model-subnav">
              <button className={page === "models" ? "active" : ""} onClick={() => setPage("models")}><SlidersHorizontal size={15} />当前配置</button>
              <button className={page === "models-add" ? "active" : ""} onClick={() => setPage("models-add")}><Plus size={15} />新增连接</button>
              <button className={page === "models-dream" ? "active" : ""} onClick={() => setPage("models-dream")}><Moon size={15} />DreamAgent</button>
            </div>}
            <button className={page === "updates" ? "active" : ""} type="button" onClick={() => setPage("updates")}><RefreshCw size={16} />更新</button>
            <button className={page === "data" ? "active" : ""} type="button" onClick={() => setPage("data")}><Database size={16} />数据与记忆</button>
          </nav>
          <small>Cleo Desktop · Preview</small>
        </aside>
        <section className="settings-content">
          <header><div><span className="eyebrow">PREFERENCES</span><h2>{page === "appearance" ? "外观" : page === "agent" ? "Agent" : page === "instructions" ? "Agent 指令" : page === "models" ? "模型与 API" : page === "updates" ? "软件更新" : "数据与记忆"}</h2></div><button className="icon-button" type="button" aria-label="关闭" onClick={onClose}><X size={17} /></button></header>
          {page === "appearance" ? (
            <div className="settings-page">
              <SettingsRow title="主题" description="选择更适合当前环境的界面亮度。">
                <div className="theme-options">
                  <button className={theme === "dark" ? "active" : ""} type="button" onClick={() => onThemeChange("dark")}><span className="theme-preview dark"><Moon size={16} /></span><span>夜色</span>{theme === "dark" ? <Check size={14} /> : null}</button>
                  <button className={theme === "light" ? "active" : ""} type="button" onClick={() => onThemeChange("light")}><span className="theme-preview light"><Sun size={16} /></span><span>雾白</span>{theme === "light" ? <Check size={14} /> : null}</button>
                </div>
              </SettingsRow>
              <SettingsRow title="信息密度" description="当前使用适合桌面工作区的紧凑布局。"><span className="settings-value">紧凑</span></SettingsRow>
              <SettingsRow title="动态效果" description="控制面板切换与动画；同时遵循系统的减少动态效果偏好。"><label className="switch"><input type="checkbox" aria-label="动态效果" checked={motionEnabled} onChange={(event) => onMotionChange(event.target.checked)} /><span /></label></SettingsRow>
            </div>
          ) : page === "agent" ? (
            <div className="settings-page">
              <SettingsRow title="Provider" description="来自当前 thread 的真实 harness session。"><span className="settings-value">{runtime.provider}</span></SettingsRow>
              <SettingsRow title="默认模型" description={runtime.editable === false ? "Cleo 对话模型来自当前 agent profile。" : "应用到当前 productivity thread。"}><select disabled={runtime.editable === false} value={runtime.model} onChange={(event) => onRuntimeChange({ model: event.target.value })}>{(runtime.models?.length ? runtime.models : [runtime.model]).map((model) => <option key={model}>{model}</option>)}</select></SettingsRow>
              <SettingsRow title="推理强度" description="更高强度适合复杂代码任务。"><div className="segmented-control">{supportedEfforts.length ? supportedEfforts.map((effort) => <button className={runtime.effort === effort ? "active" : ""} type="button" key={effort} onClick={() => onRuntimeChange({ effort })}>{effort}</button>) : <button type="button" disabled>default</button>}</div></SettingsRow>
              <SettingsRow title="文件访问" description="每个 turn 都会明确显示实际 sandbox。"><span className="settings-value mono">{runtime.access}</span></SettingsRow>
            </div>
          ) : page === "instructions" ? (
            <AgentInstructionsPage
              instructions={agentInstructions}
              loading={agentInstructionsLoading}
              onSave={onSaveAgentInstructions}
              onRevealPath={onRevealPath}
            />
          ) : isModels ? (
            <ModelSettingsPanel page={modelPage} settings={modelSettings} busy={modelSettingsLoading}
              activeProfileId={runtime.profileId}
              onApply={onApplyModelSettings}
              onNavigate={next => setPage(next === "current" ? "models" : next === "add" ? "models-add" : "models-dream")} />
          ) : page === "updates" ? (
            <UpdateSettingsPage
              state={updateState}
              onCheck={onCheckForUpdates}
              onDownload={onDownloadUpdate}
              onInstall={onInstallUpdate}
            />
          ) : (
            <div className="settings-page">
              <SettingsRow title="本地优先" description="会话、配置和记忆只保存在 Cleo 数据目录。"><span className="status-good">已启用</span></SettingsRow>
              <SettingsRow title="DreamAgent" description="在记忆页查看整理结果和待确认来源。"><span className="settings-value">{dreamAgent.status === "running" ? "正在整理" : dreamAgent.status === "attention" ? "有来源需要查看" : dreamAgent.last_processed_at ? "已完成最近整理" : "等待首次整理"}</span></SettingsRow>
              <SettingsRow title="记忆作用域" description="普通对话与开发任务严格分区。"><span className="settings-value">已隔离</span></SettingsRow>
              <SettingsRow title="配置模板" description="复制与 CLI --print-config-template 相同的模板。"><div className="settings-actions"><button type="button" onClick={() => onCopyConfigTemplate("cleo")}>复制 Cleo</button><button type="button" onClick={() => onCopyConfigTemplate("harnesses")}>复制 Harness</button></div></SettingsRow>
              <SettingsRow title="重置工作区" description="对应 CLI --reset-to-main；保留 Cleo 配置。"><button className="settings-action danger" type="button" onClick={() => { if (window.confirm("将仓库重置到本地 main 并清理未跟踪文件？此操作不可撤销。")) onResetWorkspace(); }}>重置到 main</button></SettingsRow>
              <div className="settings-note"><Brain size={17} /><p>当前页面直接读取本地 Cleo backend；会话、记忆、模型与运行参数均来自持久化状态。</p></div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function formatBytes(value: number) {
  if (!value) return "0 MB";
  return `${(value / (1024 * 1024)).toFixed(value >= 1024 * 1024 * 100 ? 0 : 1)} MB`;
}

function updateDescription(state: UpdateState) {
  switch (state.phase) {
    case "unsupported": return state.error || "开发模式不会连接发布服务器；安装后的 Cleo 会自动检查。";
    case "idle": return "尚未检查更新。";
    case "checking": return "正在检查 GitHub Release…";
    case "up-to-date": return state.latestVersion ? `已是最新版本（${state.latestVersion}）。` : "已是最新版本。";
    case "available": return `发现 Cleo ${state.latestVersion}，下载后会校验 SHA-256。`;
    case "downloading": return `正在下载 ${formatBytes(state.downloadedBytes)} / ${formatBytes(state.totalBytes)}。中断后重试会续传。`;
    case "ready": return `Cleo ${state.latestVersion} 已下载并通过校验，下次启动自动安装。`;
    case "installing": return "正在启动独立更新窗口。安装进度会持续显示，完成后自动打开 Cleo。";
    case "updated": return `Cleo ${state.currentVersion} 更新成功。`;
    case "install-failed": return state.error || "安装未完成，请重新检查更新。";
    case "error": return state.error || "检查或下载更新失败。";
  }
}

function UpdateSettingsPage({
  state,
  onCheck,
  onDownload,
  onInstall,
}: {
  state: UpdateState;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
}) {
  const percent = state.totalBytes
    ? Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100))
    : 0;
  const busy = state.phase === "checking" || state.phase === "downloading" || state.phase === "installing";
  const action = state.phase === "available"
    ? { label: "下载更新", run: onDownload }
    : state.phase === "ready"
      ? { label: "重启并安装", run: onInstall }
      : { label: state.phase === "checking" ? "检查中…" : "检查更新", run: onCheck };
  return (
    <div className="settings-page update-settings-page">
      <div className="update-hero">
        <span className="update-mark"><RefreshCw size={22} /></span>
        <div><span className="eyebrow">CLEO DESKTOP</span><h3>版本 {state.currentVersion}</h3><p>{updateDescription(state)}</p></div>
      </div>
      {state.phase === "downloading" ? <div className="update-progress" aria-label={`更新下载进度 ${percent}%`}><i style={{ width: `${percent}%` }} /></div> : null}
      <div className="update-actions">
        <button type="button" disabled={busy || state.phase === "unsupported"} onClick={state.phase === "up-to-date" ? onCheck : action.run}>{state.phase === "up-to-date" ? "重新检查" : action.label}</button>
      </div>
      <div className="settings-note"><Brain size={17} /><p>更新只替换程序目录。配置、会话、记忆和模型缓存仍保存在 Cleo 数据目录中；安装失败时会恢复旧版本。</p></div>
      {state.dependencies ? <div className="settings-note"><RefreshCw size={17} /><p>{
        state.dependencies.phase === "ready" ? "运行依赖已更新并通过检查，下次启动自动生效。"
          : state.dependencies.phase === "error" ? `依赖更新未完成，继续使用当前版本。${state.dependencies.error || ""}`
            : ["checking", "updating"].includes(state.dependencies.phase) ? "正在后台检查并更新 SDK 和浏览器工具…"
              : "每天自动检查 SDK 和浏览器工具更新；界面与 Electron 随 Cleo 更新。"
      }</p></div> : null}
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
    <aside className="update-notice" role="status">
      <span className="update-notice-icon"><RefreshCw size={16} /></span>
      <div>
        <strong>{titles[state.phase] ?? `正在下载更新 · ${percent}%`}</strong>
        <small>{result || state.phase === "installing" ? updateDescription(state) : state.phase === "available" ? "完整包会在后台下载并校验" : state.phase === "ready" ? "点击后显示安装进度，完成后自动打开新版本" : `${formatBytes(state.downloadedBytes)} / ${formatBytes(state.totalBytes)}`}</small>
      </div>
      {state.phase === "available" ? <button type="button" onClick={onDownload}>下载</button> : null}
      {state.phase === "ready" ? <button type="button" onClick={onInstall}>重启安装</button> : null}
      {result ? <button type="button" onClick={() => setDismissed(resultKey)}>关闭</button> : null}
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
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!instructions) return;
    setDraft(instructions.content);
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
      setError(reason instanceof Error ? reason.message : "无法保存 Agent 指令");
    }
  };
  return (
    <form className="settings-page agent-instructions-page" onSubmit={submit}>
      <div className="agent-instructions-intro">
        <div>
          <strong>Non-productivity 系统指令</strong>
          <p>供 Cleo 普通对话读取；不会传给 Codex、Claude 或 OpenCode productivity harness。</p>
        </div>
        <button type="button" disabled={!instructions?.path} onClick={() => instructions?.path && onRevealPath(instructions.path)}><FolderOpen size={14} />打开位置</button>
      </div>
      <code className="agent-instructions-path">{instructions?.path ?? "正在读取 AGENTS.md…"}</code>
      <textarea
        aria-label="Non-productivity Agent 指令"
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
        <span className={error ? "error" : ""}>{error ?? (saved ? "已保存；后续 non-productivity 对话将读取新指令。" : instructions?.exists === false ? "保存后会创建 AGENTS.md。" : dirty ? "有未保存修改" : "未修改")}</span>
        <div>
          <button type="button" disabled={!dirty || loading} onClick={() => { setDraft(baseline); setError(null); setSaved(false); }}><RotateCcw size={14} />撤销修改</button>
          <button className="primary" type="submit" disabled={!dirty || loading}><Save size={14} />{loading ? "保存中…" : "保存"}</button>
        </div>
      </footer>
    </form>
  );
}

function SettingsRow({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <div className="settings-row"><div><strong>{title}</strong><p>{description}</p></div><div className="settings-control">{children}</div></div>;
}

export function LoadingScreen({ error }: { error: string | null }) {
  return (
    <div className="loading-screen">
      <div className="loading-brand"><span>C</span></div>
      {error ? <><strong>无法打开工作区</strong><p>{error}</p></> : <><div className="loading-line"><i /></div><span>正在打开本地工作区</span></>}
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
