import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Brain,
  Check,
  Code2,
  Command,
  Database,
  MessageCircle,
  Moon,
  PanelRight,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import type {
  MemoryOverview,
  ModelProfileInput,
  ModelSettings,
  RuntimeProfile,
  WorkspaceSpace,
} from "../types";

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
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQuery("");
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
          <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入命令或搜索…" />
          <kbd>Esc</kbd>
        </label>
        <div className="command-results">
          <span className="command-section-label">建议</span>
          {filtered.map(({ id, label, hint, icon: Icon, shortcut, run }, index) => (
            <button
              className={index === 0 ? "focused" : ""}
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

interface SettingsModalProps {
  open: boolean;
  theme: "dark" | "light";
  runtime: RuntimeProfile;
  memoryOverview: MemoryOverview;
  modelSettings: ModelSettings | null;
  modelSettingsLoading: boolean;
  onThemeChange: (theme: "dark" | "light") => void;
  onRuntimeChange: (update: Partial<RuntimeProfile>) => void;
  onLoadModelSettings: () => Promise<ModelSettings>;
  onSaveModelProfile: (profile: ModelProfileInput) => Promise<ModelSettings>;
  onCopyConfigTemplate: (kind: "cleo" | "harnesses") => void;
  onResetWorkspace: () => void;
  onClose: () => void;
}

type SettingsPage = "appearance" | "agent" | "models" | "data";

export function SettingsModal({
  open,
  theme,
  runtime,
  memoryOverview,
  modelSettings,
  modelSettingsLoading,
  onThemeChange,
  onRuntimeChange,
  onLoadModelSettings,
  onSaveModelProfile,
  onCopyConfigTemplate,
  onResetWorkspace,
  onClose,
}: SettingsModalProps) {
  const [page, setPage] = useState<SettingsPage>("appearance");
  useEffect(() => {
    if (open) void onLoadModelSettings();
  }, [open]);
  if (!open) return null;
  return (
    <div className="overlay-backdrop settings-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="settings-modal" role="dialog" aria-label="设置" onMouseDown={(event) => event.stopPropagation()}>
        <aside>
          <div className="settings-brand"><span>C</span><strong>设置</strong></div>
          <nav>
            <button className={page === "appearance" ? "active" : ""} type="button" onClick={() => setPage("appearance")}><Sparkles size={16} />外观</button>
            <button className={page === "agent" ? "active" : ""} type="button" onClick={() => setPage("agent")}><SlidersHorizontal size={16} />Agent</button>
            <button className={page === "models" ? "active" : ""} type="button" onClick={() => setPage("models")}><Plus size={16} />模型</button>
            <button className={page === "data" ? "active" : ""} type="button" onClick={() => setPage("data")}><Database size={16} />数据与记忆</button>
          </nav>
          <small>Cleo Desktop · Preview</small>
        </aside>
        <section className="settings-content">
          <header><div><span className="eyebrow">PREFERENCES</span><h2>{page === "appearance" ? "外观" : page === "agent" ? "Agent" : page === "models" ? "模型与 API" : "数据与记忆"}</h2></div><button className="icon-button" type="button" aria-label="关闭" onClick={onClose}><X size={17} /></button></header>
          {page === "appearance" ? (
            <div className="settings-page">
              <SettingsRow title="主题" description="选择更适合当前环境的界面亮度。">
                <div className="theme-options">
                  <button className={theme === "dark" ? "active" : ""} type="button" onClick={() => onThemeChange("dark")}><span className="theme-preview dark"><Moon size={16} /></span><span>夜色</span>{theme === "dark" ? <Check size={14} /> : null}</button>
                  <button className={theme === "light" ? "active" : ""} type="button" onClick={() => onThemeChange("light")}><span className="theme-preview light"><Sun size={16} /></span><span>雾白</span>{theme === "light" ? <Check size={14} /> : null}</button>
                </div>
              </SettingsRow>
              <SettingsRow title="信息密度" description="当前使用适合桌面工作区的紧凑布局。"><span className="settings-value">紧凑</span></SettingsRow>
              <SettingsRow title="动态效果" description="保留 thread 切换、面板展开与状态反馈。"><label className="switch"><input type="checkbox" defaultChecked /><span /></label></SettingsRow>
            </div>
          ) : page === "agent" ? (
            <div className="settings-page">
              <SettingsRow title="Provider" description="来自当前 thread 的真实 harness session。"><span className="settings-value">{runtime.provider}</span></SettingsRow>
              <SettingsRow title="默认模型" description={runtime.editable === false ? "Cleo 对话模型来自当前 agent profile。" : "应用到当前 productivity thread。"}><select disabled={runtime.editable === false} value={runtime.model} onChange={(event) => onRuntimeChange({ model: event.target.value })}>{(runtime.models?.length ? runtime.models : [runtime.model]).map((model) => <option key={model}>{model}</option>)}</select></SettingsRow>
              <SettingsRow title="推理强度" description="更高强度适合复杂代码任务。"><div className="segmented-control">{(["低", "中", "高"] as RuntimeProfile["effort"][]).map((effort) => <button className={runtime.effort === effort ? "active" : ""} type="button" key={effort} onClick={() => onRuntimeChange({ effort })}>{effort}</button>)}</div></SettingsRow>
              <SettingsRow title="文件访问" description="每个 turn 都会明确显示实际 sandbox。"><span className="settings-value mono">{runtime.access}</span></SettingsRow>
            </div>
          ) : page === "models" ? (
            <ModelSettingsPage
              settings={modelSettings}
              loading={modelSettingsLoading}
              onSave={onSaveModelProfile}
            />
          ) : (
            <div className="settings-page">
              <SettingsRow title="本地优先" description="会话、配置和记忆只保存在 Cleo 数据目录。"><span className="status-good">已启用</span></SettingsRow>
              <SettingsRow title="DreamAgent" description="thread 完成后在后台整理可持久化知识。"><label className="switch"><input type="checkbox" defaultChecked /><span /></label></SettingsRow>
              <SettingsRow title="记忆作用域" description="普通对话与开发任务严格分区。"><span className="settings-value">已隔离</span></SettingsRow>
              <SettingsRow title="语义筛选模型" description={`配置项 ${memoryOverview.gate.configuration_key}；接入配置编辑后可直接替换。`}>
                <div className="memory-model-setting"><span>Sentence Transformer</span><code>{memoryOverview.gate.model}</code></div>
              </SettingsRow>
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

const emptyModelProfile: ModelProfileInput = {
  name: "",
  provider: "openai",
  model: "",
  apiKey: "",
  baseUrl: "",
  maxTokens: 128000,
  activateAgent: true,
  activateDreamAgent: false,
};

function ModelSettingsPage({
  settings,
  loading,
  onSave,
}: {
  settings: ModelSettings | null;
  loading: boolean;
  onSave: (profile: ModelProfileInput) => Promise<ModelSettings>;
}) {
  const [draft, setDraft] = useState<ModelProfileInput>(emptyModelProfile);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const selectProfile = (name: string) => {
    const profile = settings?.profiles.find((item) => item.name === name);
    if (!profile) {
      setDraft(emptyModelProfile);
      return;
    }
    setDraft({
      name: profile.name,
      provider: profile.provider,
      model: profile.model,
      apiKey: "",
      baseUrl: profile.baseUrl ?? "",
      maxTokens: profile.maxTokens,
      activateAgent: settings?.activeAgent === profile.name,
      activateDreamAgent: settings?.activeDreamAgent === profile.name,
    });
    setError(null);
    setSaved(false);
  };
  useEffect(() => {
    if (settings?.profiles.length && !draft.name) {
      selectProfile(settings.activeAgent || settings.profiles[0].name);
    }
  }, [settings]);
  const update = <K extends keyof ModelProfileInput>(key: K, value: ModelProfileInput[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await onSave(draft);
      setDraft((current) => ({ ...current, apiKey: "" }));
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存模型配置");
    }
  };
  const selectedIsSaved = settings?.profiles.some((item) => item.name === draft.name) ?? false;
  return (
    <div className="settings-page model-settings-page">
      <div className="model-profile-toolbar">
        <label>
          <span>已保存 Profile</span>
          <select value={selectedIsSaved ? draft.name : ""} onChange={(event) => selectProfile(event.target.value)}>
            <option value="">新建 Profile</option>
            {settings?.profiles.map((profile) => <option value={profile.name} key={profile.name}>{profile.name} · {profile.model}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => { setDraft(emptyModelProfile); setError(null); setSaved(false); }}><Plus size={14} />新增</button>
      </div>
      <form className="model-profile-form" onSubmit={submit}>
        <label><span>Profile 名称</span><input required value={draft.name} onChange={(event) => update("name", event.target.value)} placeholder="例如 moonshot" /></label>
        <label><span>Provider</span><input required list="cleo-provider-options" value={draft.provider} onChange={(event) => update("provider", event.target.value)} placeholder="openai" /><datalist id="cleo-provider-options"><option value="openai" /><option value="anthropic" /><option value="google_genai" /></datalist></label>
        <label className="wide"><span>模型名称</span><input required value={draft.model} onChange={(event) => update("model", event.target.value)} placeholder="例如 gpt-5.6" /></label>
        <label className="wide"><span>API Key</span><input type="password" autoComplete="new-password" value={draft.apiKey} onChange={(event) => update("apiKey", event.target.value)} placeholder={selectedIsSaved ? "已配置；留空则保持不变" : "必填，只保存在本地"} /></label>
        <label className="wide"><span>Base URL（可选）</span><input type="url" value={draft.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.example.com/v1" /></label>
        <label><span>上下文长度</span><input type="number" min={1} value={draft.maxTokens} onChange={(event) => update("maxTokens", Number(event.target.value))} /></label>
        <div className="model-profile-roles"><label><input type="checkbox" checked={draft.activateAgent} onChange={(event) => update("activateAgent", event.target.checked)} />设为 Cleo 当前模型</label><label><input type="checkbox" checked={draft.activateDreamAgent} onChange={(event) => update("activateDreamAgent", event.target.checked)} />设为 DreamAgent 模型</label></div>
        <div className="model-profile-submit"><span>{error ? <em>{error}</em> : saved ? "已保存并重新加载后端" : "API Key 不会返回到界面或日志"}</span><button type="submit" disabled={loading}>{loading ? "保存中…" : "保存并应用"}</button></div>
      </form>
    </div>
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

export function Toast({ message }: { message: string }) {
  return <div className="toast" role="status"><Check size={14} /><span>{message}</span></div>;
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
