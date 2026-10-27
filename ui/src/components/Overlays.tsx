import { getLanguage } from "../../electron/i18n.mjs";
import { t as tr } from "../../electron/i18n.mjs";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { dreamStatusLabel } from "../memoryStatus";
import { MemorySourcesSettings } from "./MemorySourcesSettings";
import { UpdateVersionPicker } from "./UpdateVersionPicker";
import { handleDialogKeyDown, Modal } from "./Modal";
import { PermissionSelector } from "./PermissionSelector";
import { accessLabel, approvalLabel, effortLabels, projectLabel } from "../runtime-labels";
import {
  ArrowDownToLine,
  ArrowRight,
  Boxes,
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
  Wrench,
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
  StorageEntryKind,
  StorageInventory,
  StorageReclaimResult,
  ConfigStatus,
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
    <Modal open={open} className="overlay-backdrop" label={tr("conversation.command_palette")} onClose={onClose}>
      <div className="command-palette" onMouseDown={(event) => event.stopPropagation()}>
        <label className="command-search">
          <Search size={18} />
          <input
            autoFocus
            value={query}
            aria-label={tr("overlays.search_commands")}
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
            placeholder={tr("overlays.enter_a_command_or_search")}
          />
          <kbd>Esc</kbd>
        </label>
        <div className="command-results" id="command-results" role="listbox" aria-label={tr("approvalprompt.command")}>
          <span className="command-section-label">{tr("overlays.suggestions")}</span>
          {filtered.map(({ id, label, icon: Icon, shortcut, run }, index) => (
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
              <span><strong>{label}</strong></span>
              {shortcut ? <kbd>{shortcut}</kbd> : <ArrowRight size={14} />}
            </button>
          ))}
          {!filtered.length ? <div className="command-empty">{tr("overlays.no_matching_commands")}</div> : null}
        </div>
        <footer><span><kbd>↑↓</kbd> {tr("overlays.select")}</span><span><kbd>↵</kbd> {tr("overlays.open")}</span></footer>
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
          setError(reason instanceof Error ? reason.message : tr("overlays.could_not_rename_try_again"));
        } finally {
          savingRef.current = false;
          setSaving(false);
        }
      }}>
        <h2 id="rename-title">{tr("overlays.rename_task")}</h2>
        <label htmlFor="rename-input">{tr("overlays.name")}</label>
        <input ref={inputRef} id="rename-input" autoFocus value={name} disabled={saving} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
        }} />
        {error ? <p role="alert">{error}</p> : null}
        <footer>
          <button type="button" disabled={saving} onClick={onClose}>{tr("computerpanel.cancel")}</button>
          <button className="primary" type="submit" disabled={saving || !name.trim()}>{saving ? tr("backgroundmemorysettingspanel.saving") : tr("computerpanel.save")}</button>
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
          <h2 id="delete-thread-title">{tr("overlays.delete")}{threadTitle}”？</h2>
          <p id="delete-thread-detail">
            {tr("overlays.this_action_cannot_be_undone")}{productivity ? tr("overlays.sessions_in_external_clients_will_be_preserved") : ""}
          </p>
        </div>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <footer>
          <button autoFocus type="button" onClick={onCancel} disabled={deleting}>{tr("computerpanel.cancel")}</button>
          <button className="danger" type="button" onClick={onConfirm} disabled={deleting}>
            {deleting ? tr("overlays.deleting") : tr("overlays.delete_permanently")}
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
          <h2 id="remove-project-title">{tr("overlays.remove")}{projectLabel(project)}”？</h2>
          <p id="remove-project-detail">{tr("overlays.local_files_and_historical_tasks_will_not_be_deleted")}</p>
        </div>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <footer>
          <button autoFocus type="button" onClick={onCancel} disabled={removing}>{tr("computerpanel.cancel")}</button>
          <button className="danger" type="button" onClick={onConfirm} disabled={removing}>
            {removing ? tr("overlays.removing") : tr("overlays.remove_project")}
          </button>
        </footer>
      </div>
    </Modal>
  );
}

interface SettingsModalProps {
  language: "zh-CN" | "en";
  onLanguageChange: (language: "zh-CN" | "en") => Promise<void>;
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
  onStorageInventory?: () => Promise<StorageInventory>;
  onReclaimStorage?: () => Promise<StorageReclaimResult>;
  /** Why cleanup cannot start right now (a running task); null when it can. */
  storageBlocked?: string | null;
  onRevealPath: (path: string) => void;
  onCopyConfigTemplate: (kind: "cleo" | "harnesses") => void;
  onResetWorkspace: () => void;
  onClose: () => void;
}

type SettingsPage = "appearance" | "agent" | "instructions" | "models" | "models-add" | "models-dream" | "import" | "updates" | "data";
const settingsTitles: Record<SettingsPage, string> = {
  get appearance() { return tr("overlays.appearance"); }, get agent() { return tr("overlays.run_settings"); }, get instructions() { return tr("overlays.chat_instructions"); }, get models() { return tr("overlays.current_configuration"); },
  get "models-add"() { return tr("overlays.new_connection"); }, get "models-dream"() { return tr("modelsettingspanel.memory_consolidation"); }, get import() { return tr("overlays.import"); }, get updates() { return tr("overlays.software_updates"); }, get data() { return tr("overlays.data_and_memory"); },
};

export function SettingsModal({
  language,
  onLanguageChange,
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
  onStorageInventory,
  onReclaimStorage,
  storageBlocked = null,
  onRevealPath,
  onCopyConfigTemplate,
  onResetWorkspace,
  onClose,
}: SettingsModalProps) {
  const [languageSaving, setLanguageSaving] = useState(false);
  const [languageError, setLanguageError] = useState("");
  const changeLanguage = async (value: "zh-CN" | "en") => {
    setLanguageSaving(true); setLanguageError("");
    try { await onLanguageChange(value); }
    catch (error) { setLanguageError(error instanceof Error ? error.message : tr("settings.languageSaveFailed")); }
    finally { setLanguageSaving(false); }
  };
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
    <Modal open={open} className="overlay-backdrop settings-backdrop" label={tr("overlays.settings")} onClose={onClose}>
      <div className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <button className="icon-button settings-close" aria-label={tr("overlays.close_settings")} onClick={onClose}><X size={17} /></button>
        <aside>
          <div className="settings-brand"><span aria-hidden="true" /><strong>{tr("overlays.settings")}</strong></div>
          <nav aria-label={tr("overlays.settings_navigation")}>
            <button className={page === "appearance" ? "active" : ""} aria-current={page === "appearance" ? "page" : undefined} type="button" onClick={() => setPage("appearance")}><Sparkles size={16} />{tr("overlays.appearance")}</button>
            <button className={page === "agent" ? "active" : ""} aria-current={page === "agent" ? "page" : undefined} type="button" onClick={() => setPage("agent")}><SlidersHorizontal size={16} />{tr("overlays.run_settings")}</button>
            <button className={page === "instructions" ? "active" : ""} aria-current={page === "instructions" ? "page" : undefined} type="button" onClick={() => setPage("instructions")}><FileText size={16} />{tr("overlays.chat_instructions")}</button>
            <button className="settings-model-group" type="button" onClick={() => setPage("models")}><Boxes size={16} />{tr("inspector.model")}</button>
            <div className="settings-model-subnav">
              <button className={page === "models" ? "active" : ""} aria-current={page === "models" ? "page" : undefined} onClick={() => setPage("models")}><SlidersHorizontal size={15} />{tr("overlays.current_configuration")}</button>
              <button className={page === "models-add" ? "active" : ""} aria-current={page === "models-add" ? "page" : undefined} onClick={() => setPage("models-add")}><Plus size={15} />{tr("overlays.new_connection")}</button>
              <button className={page === "models-dream" ? "active" : ""} aria-current={page === "models-dream" ? "page" : undefined} onClick={() => setPage("models-dream")}><Moon size={15} />{tr("modelsettingspanel.memory_consolidation")}</button>
            </div>
            <button className={page === "import" ? "active" : ""} aria-current={page === "import" ? "page" : undefined} type="button" onClick={() => setPage("import")}><ArrowDownToLine size={16} />{tr("overlays.import")}</button>
            <button className={page === "updates" ? "active" : ""} aria-current={page === "updates" ? "page" : undefined} type="button" onClick={() => setPage("updates")}><RefreshCw size={16} />{tr("overlays.updates")}</button>
            <button className={page === "data" ? "active" : ""} aria-current={page === "data" ? "page" : undefined} type="button" onClick={() => setPage("data")}><Database size={16} />{tr("overlays.data_and_memory")}</button>
          </nav>
          {window.cleoDesktop?.setup && <button className="settings-setup-link" type="button"
            onClick={() => { onClose(); window.dispatchEvent(new Event("cleo:open-setup")); }}><Wrench size={16} />{tr("overlays.check_runtime_environment")}</button>}
        </aside>
        <section className="settings-content">
          <header className="settings-header">
            <div className="settings-breadcrumb">{tr("overlays.settings")}<ChevronRight size={12} />{isModels && <>{tr("inspector.model")}<ChevronRight size={12} /></>}<span>{settingsTitles[page]}</span></div>
            <div className="settings-heading"><h2>{settingsTitles[page]}</h2>{page === "models" && <button className="settings-primary" onClick={() => setPage("models-add")}><Plus size={15} />{tr("overlays.new_connection")}</button>}</div>
          </header>
          <div className="settings-scroll" ref={scrollRef}>
          <div hidden={page !== "instructions"} className="settings-instructions-container">
            {agentInstructionsError && <p className="settings-error" role="alert">{agentInstructionsError}
              <button type="button" onClick={() => void onLoadAgentInstructions().catch(() => {})}>{tr("app.retry")}</button></p>}
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
              <SettingsRow title={tr("settings.language")}><select aria-label={tr("settings.language")} value={language} disabled={languageSaving}
                onChange={event => void changeLanguage(event.target.value as "zh-CN" | "en")}>
                <option value="zh-CN">{tr("overlays.label")}</option><option value="en">English</option>
              </select></SettingsRow>
              {languageError && <p className="settings-error" role="alert">{languageError}</p>}
              <SettingsRow title={tr("overlays.theme")}>
                <div className="theme-options">
                  <button className={theme === "dark" ? "active" : ""} type="button" onClick={() => onThemeChange("dark")}><span className="theme-preview dark"><Moon size={16} /></span><span>{tr("overlays.dark")}</span>{theme === "dark" ? <Check size={14} /> : null}</button>
                  <button className={theme === "light" ? "active" : ""} type="button" onClick={() => onThemeChange("light")}><span className="theme-preview light"><Sun size={16} /></span><span>{tr("overlays.light")}</span>{theme === "light" ? <Check size={14} /> : null}</button>
                </div>
              </SettingsRow>
              <SettingsRow title={tr("overlays.motion_effects")}><label className="switch"><input type="checkbox" aria-label={tr("overlays.motion_effects")} checked={motionEnabled} onChange={(event) => onMotionChange(event.target.checked)} /><span /></label></SettingsRow>
            </div>
          ) : page === "agent" ? (
            <div className="settings-page">
              {runtimeThread && <p className="settings-scope">{tr("overlays.current_task")}{runtimeThread.title}</p>}
              <SettingsRow title={tr("conversation.provider")}><span className="settings-value">{runtime.provider}</span></SettingsRow>
              <SettingsRow title={tr("overlays.current_task_model")}>{runtime.editable === false ? <span className="settings-value">{runtime.model}</span> : <select aria-label={tr("overlays.current_task_model")} value={runtime.model} onChange={event => onRuntimeChange({ model: event.target.value })}>{(runtime.models?.length ? runtime.models : [runtime.model]).map(model => <option key={model}>{model}</option>)}</select>}</SettingsRow>
              <SettingsRow title={tr("conversation.reasoning_effort")}><div className="segmented-control">{supportedEfforts.length ? supportedEfforts.map((effort) => <button className={runtime.effort === effort ? "active" : ""} type="button" key={effort} onClick={() => onRuntimeChange({ effort })}>{effortLabels[effort] ?? effort}</button>) : <span className="settings-value">{tr("conversation.determined_by_the_model")}</span>}</div></SettingsRow>
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
              <SettingsRow title={tr("modelsettingspanel.memory_consolidation")}><span className="settings-value">{dreamStatusLabel(dreamAgent)}</span></SettingsRow>
              <MemorySourcesSettings active={open} />
              {onStorageInventory && <StorageSettings active={open} onInventory={onStorageInventory} onReclaim={onReclaimStorage}
                blocked={storageBlocked} onRevealPath={onRevealPath} />}
              <details className="settings-advanced"><summary>{tr("connectionwizard.advanced_settings")}</summary>
                <SettingsRow title={tr("overlays.configuration_templates")}><div className="settings-actions"><button type="button" onClick={() => onCopyConfigTemplate("cleo")}>{tr("overlays.copy_cleo_configuration")}</button><button type="button" onClick={() => onCopyConfigTemplate("harnesses")}>{tr("overlays.copy_runtime_configuration")}</button></div></SettingsRow>
                <SettingsRow title={tr("overlays.reset_workspace")}><button className="settings-action danger" type="button" onClick={() => { if (window.confirm(tr("overlays.reset_the_repository_to_local_main_and_remove_untracked_files_this_action_cannot_be_u"))) onResetWorkspace(); }}>{tr("overlays.reset_workspace")}</button></SettingsRow>
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
    catch (error) { setError(error instanceof Error ? error.message : tr("overlays.permission_changes_were_not_saved_try_again")); }
    finally { inFlight.current = false; setSaving(false); }
  };
  return <>
    <PermissionSelector key={runtime.provider} runtime={runtime} disabled={saving} placement="down"
      onChange={threadId && onChange ? update => onChange(threadId, update) : undefined} />
    {(["access", "approval"] as const).map(field => {
      const title = field === "access" ? tr("overlays.file_access") : tr("overlays.approval_policy");
      const label = field === "access" ? accessLabel : approvalLabel;
      const choices = runtime.permissionOptions?.[field] ?? [];
      const value = (sameProvider && pending?.[field]) || runtime[field];
      const choice = choices.find(choice => choice.value === value);
      return <SettingsRow key={field} title={title}>
        {threadId && onChange && choices.length ? <select aria-label={title} title={choice?.description} value={value} disabled={saving}
          onChange={event => void change({ [field]: event.target.value })}>
          {!choice && <option value={value}>{label(value)}</option>}
          {choices.map(choice => <option key={choice.value} value={choice.value} disabled={Boolean(choice.disabledReason)}
            title={choice.disabledReason ?? choice.description}>{choice.label}{choice.disabledReason ? tr("overlays.unavailable") : ""}</option>)}
        </select> : <span className="settings-value">{label(runtime[field])}</span>}
      </SettingsRow>;
    })}
    {pending && <div className="settings-permission-pending" role="status">
      <p>{sameProvider ? tr("overlays.applies_next_run_current_value_value", { p0: accessLabel(runtime.access), p1: approvalLabel(runtime.approval) })
        : tr("overlays.pending_permissions_belong_to_the_previous_provider_choose_them_again_or_discard_the_")}</p>
      <button className="settings-action" disabled={saving} onClick={() => void change({ discardPendingPermissions: true })}>{tr("backgroundmemorysettingspanel.discard_changes")}</button>
    </div>}
    {runtime.permissionOptions?.reason && <p className="settings-scope">{runtime.permissionOptions.reason}</p>}
    {saving && <p className="settings-scope" role="status">{tr("overlays.saving")}</p>}
    {error && <p className="settings-error" role="alert">{error}</p>}
  </>;
}

function formatStorage(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(value >= 1024 ** 3 * 10 ? 1 : 2)} GB`;
  return formatBytes(value);
}

const storageKindLabels: Record<StorageEntryKind, string> = {
  get "runtime-namespace"() { return tr("overlays.dependency_snapshots"); }, get "online-runtime"() { return tr("dependencysetup.runtime_setup"); }, get "package-cache"() { return tr("overlays.download_cache"); }, get "install-scratch"() { return tr("overlays.temporary_installation_directories"); },
  get "release-download"() { return tr("overlays.installation_packages"); }, get build() { return tr("overlays.retained_programs"); }, get backup() { return tr("overlays.data_backups"); }, get "user-data"() { return tr("overlays.user_data"); }, get unknown() { return tr("overlays.other"); },
};
const storageKindOrder = Object.keys(storageKindLabels) as StorageEntryKind[];

/** Purpose: Show how much Cleo occupies, what can be reclaimed and why the rest stays; cleanup only on request. */
function StorageSettings({ active, onInventory, onReclaim, blocked, onRevealPath }: {
  active: boolean;
  onInventory: () => Promise<StorageInventory>;
  onReclaim?: () => Promise<StorageReclaimResult>;
  blocked: string | null;
  onRevealPath: (path: string) => void;
}) {
  const [inventory, setInventory] = useState<StorageInventory | null>(null);
  const [busy, setBusy] = useState<"inventory" | "reclaim" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const current = useRef({ onInventory, onReclaim });
  current.current = { onInventory, onReclaim };
  const load = async () => {
    if (busy) return;
    setBusy("inventory"); setError("");
    try { setInventory(await current.current.onInventory()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : tr("overlays.could_not_calculate_storage_usage")); }
    finally { setBusy(null); }
  };
  useEffect(() => { if (active && !inventory && !busy) void load(); }, [active]);
  const reclaim = async () => {
    if (busy || !inventory || !current.current.onReclaim) return;
    const confirmed = window.confirm(tr("overlays.delete_approximately_value_of_reclaimable_data_dependency_snapshots_left_by_deleted_p", { p0: formatStorage(inventory.reclaimableBytes) }));
    if (!confirmed) return;
    setBusy("reclaim"); setError(""); setNotice("");
    try {
      const result = await current.current.onReclaim();
      setInventory(result.inventory);
      setNotice(result.failed.length
        ? tr("overlays.freed_value_value_items_were_in_use_and_could_not_be_deleted_they_will_be_retried_on_", { p0: formatStorage(result.freedBytes), p1: result.failed.length })
        : tr("overlays.freed_value", { p0: formatStorage(result.freedBytes) }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr("overlays.cleanup_failed_try_again")); }
    finally { setBusy(null); }
  };
  const groups = useMemo(() => {
    if (!inventory) return [];
    const totals = new Map<StorageEntryKind, { bytes: number; count: number; reclaim: number }>();
    for (const entry of inventory.entries) {
      const group = totals.get(entry.kind) ?? { bytes: 0, count: 0, reclaim: 0 };
      group.bytes += entry.bytes; group.count += 1;
      if (entry.action === "reclaim") group.reclaim += entry.bytes;
      totals.set(entry.kind, group);
    }
    return storageKindOrder.filter(kind => totals.has(kind)).map(kind => ({ kind, ...totals.get(kind)! }));
  }, [inventory]);
  const listed = useMemo(() => inventory ? [...inventory.entries]
    .filter(entry => entry.kind !== "user-data")
    .sort((a, b) => Number(b.action === "reclaim") - Number(a.action === "reclaim") || b.bytes - a.bytes) : [], [inventory]);
  const description = !inventory ? (busy === "inventory" ? tr("overlays.calculating_storage_used_by_cleo_owned_files") : tr("overlays.measures_dependency_snapshots_runtimes_installers_backups_and_user_data"))
    : tr("overlays.total_value_reclaimable_valuevalue", { p0: formatStorage(inventory.totalBytes), p1: formatStorage(inventory.reclaimableBytes), p2: inventory.pending.length ? tr("overlays.value_items_could_not_be_deleted_last_time_and_will_be_retried_automatically", { p0: inventory.pending.length }) : "" });
  return (
    <section className="storage-settings" aria-label={tr("overlays.storage_usage")}>
      <SettingsRow title={tr("overlays.storage_usage")} description={description}>
        <div className="settings-actions">
          <button type="button" onClick={() => void load()} disabled={Boolean(busy)}>{busy === "inventory" ? tr("overlays.calculating") : inventory ? tr("overlays.recalculate") : tr("overlays.calculate_usage")}</button>
          {inventory && onReclaim && inventory.reclaimableBytes > 0 && (
            <button type="button" onClick={() => void reclaim()} disabled={Boolean(busy) || Boolean(blocked)}
              title={blocked ?? undefined}>{busy === "reclaim" ? tr("overlays.cleaning") : tr("overlays.reclaim_value", { p0: formatStorage(inventory.reclaimableBytes) })}</button>
          )}
        </div>
      </SettingsRow>
      {blocked && inventory && inventory.reclaimableBytes > 0 && <p className="settings-scope">{blocked}</p>}
      {error && <p className="settings-error" role="alert">{error}</p>}
      {notice && <p className="settings-scope" role="status">{notice}</p>}
      {inventory && inventory.lastCleanup && !notice && <p className="settings-scope">{tr("overlays.last_cleanup")}{new Date(inventory.lastCleanup.at).toLocaleString(getLanguage())} {tr("overlays.freed")}{formatStorage(inventory.lastCleanup.freedBytes)}{inventory.lastCleanup.failed ? tr("overlays.value_items_awaiting_retry", { p0: inventory.lastCleanup.failed }) : ""}</p>}
      {inventory && (
        <details className="settings-advanced storage-details">
          <summary>{tr("overlays.storage_breakdown")}</summary>
          <table className="storage-table">
            <thead><tr><th>{tr("overlays.category")}</th><th>{tr("overlays.entries")}</th><th>{tr("overlays.reclaimable")}</th><th>{tr("overlays.used")}</th></tr></thead>
            <tbody>{groups.map(group => <tr key={group.kind}><td>{storageKindLabels[group.kind]}</td><td>{group.count}</td><td>{group.reclaim ? formatStorage(group.reclaim) : "—"}</td><td>{formatStorage(group.bytes)}</td></tr>)}</tbody>
          </table>
          <ul className="storage-entries">
            {listed.map(entry => (
              <li key={entry.id} className={entry.action}>
                <strong>{entry.action === "reclaim" ? tr("overlays.reclaimable") : tr("overlays.retained")} · {storageKindLabels[entry.kind]}{entry.version ? ` ${entry.version}` : ""} · {formatStorage(entry.bytes)}</strong>
                <span>{entry.reason}{entry.action === "reclaim" && entry.policy === "manual" ? tr("overlays.manual_cleanup_only") : ""}</span>
                <button type="button" onClick={() => onRevealPath(entry.path)}><code>{entry.path}</code></button>
              </li>
            ))}
          </ul>
          <p className="settings-scope">{tr("overlays.data_directory")}{inventory.dataHome} {tr("overlays.program_directory")}{inventory.controlRoot}{tr("overlays.sizes_are_approximate_recursive_file_totals")}</p>
        </details>
      )}
    </section>
  );
}

function formatBytes(value: number) {
  if (!value) return "0 MB";
  return `${(value / (1024 * 1024)).toFixed(value >= 1024 * 1024 * 100 ? 0 : 1)} MB`;
}

function updateDescription(state: UpdateState) {
  if (state.phase === "ready" && state.installBlocked) return state.installBlocked;
  if (state.phase === "ready" && state.error) return state.error;
  if (state.operationBusy && !["checking", "downloading", "installing"].includes(state.phase)) return tr("overlays.another_version_operation_is_in_progress");
  switch (state.phase) {
    case "unsupported": return state.error || tr("overlays.development_builds_do_not_check_for_updates");
    case "idle": return tr("overlays.loading_version_information");
    case "checking": return tr("overlays.checking_for_updates");
    case "up-to-date": return state.selectedTag ? tr("overlays.you_are_using_the_selected_version_value", { p0: state.latestVersion }) : state.latestVersion ? tr("overlays.you_have_the_latest_version_value", { p0: state.latestVersion }) : tr("overlays.you_have_the_latest_version");
    case "available": return `${state.selectedTag ? tr("overlays.selected") : tr("overlays.update_available")} ${state.latestVersion}${state.selectedPrerelease ? tr("overlays.pre_release") : ""}`;
    case "downloading": return tr("overlays.downloading_value_value", { p0: formatBytes(state.downloadedBytes), p1: formatBytes(state.totalBytes) });
    case "ready": return tr("overlays.cleo_value_is_ready_click_to_restart_and_install", { p0: state.latestVersion });
    case "installing": return state.installStage === "restarting" ? tr("overlays.starting_the_new_version") : tr("overlays.verifying_and_extracting_the_update");
    case "updated": return tr("overlays.cleo_value_updated_successfully", { p0: state.currentVersion });
    case "install-failed": return state.error || tr("overlays.installation_did_not_complete_check_for_updates_again");
    case "error": return state.error || tr("overlays.could_not_check_for_or_download_updates");
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
      setCheckError(error instanceof Error ? error.message : tr("overlays.could_not_read_the_version_try_again"));
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
  if (checkError || ["error", "install-failed"].includes(state.phase)) action = { label: tr("app.retry"), run: () => void check() };
  else if (state.phase === "available") action = { label: tr("overlays.download_update"), run: onDownload };
  else if (state.phase === "ready") action = { label: tr("overlays.restart_and_install"), run: onInstall };
  else if (state.phase === "downloading") action = { label: tr("overlays.downloading"), run: onDownload };
  else if (state.phase === "installing") action = { label: tr("overlays.installing"), run: onInstall };
  return (
    <div className="settings-page update-settings-page">
      <div className="update-hero">
        <div><h3>Cleo {state.currentVersion}{state.currentPrerelease ? tr("overlays.pre_release") : ""}</h3>
          <p role={checkError || ["error", "install-failed"].includes(state.phase) ? "alert" : "status"}>{checkError || updateDescription(state)}</p></div>
      </div>
      {state.phase === "downloading" ? <div className="update-progress" aria-label={tr("overlays.update_download_progress_value", { p0: percent })}><i style={{ width: `${percent}%` }} /></div> : null}
      {action && <div className="update-actions">
        <button type="button" disabled={busy || (state.phase === "ready" && Boolean(state.installBlocked))} onClick={action.run}>{action.label}</button>
      </div>}
      <UpdateVersionPicker state={state} busy={Boolean(busy)} onSelect={tag => void check(tag)} />
      {state.dependencies && <details className="settings-advanced"><summary>{tr("overlays.runtime_dependencies")}{state.dependencies.phase === "error" ? tr("overlays.update_incomplete") : ""}</summary><p>{
        state.dependencies.phase === "ready" ? tr("overlays.runtime_dependencies_were_updated_and_verified_they_will_take_effect_on_the_next_laun")
          : state.dependencies.phase === "error" ? tr("overlays.dependency_update_did_not_complete_continuing_with_the_current_version_value", { p0: state.dependencies.error || "" })
            : ["checking", "updating"].includes(state.dependencies.phase) ? tr("overlays.checking_and_updating_sdks_and_browser_tools_in_the_background")
              : tr("overlays.using_verified_runtime_dependencies")
      }</p></details>}
    </div>
  );
}

export function ConfigNotice({ status, onRecheck }: { status: ConfigStatus | null; onRecheck: () => void }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!status || (!status.error && !status.restartRequired)) return null;
  const key = `${status.version}:${status.error}:${status.restartRequired}`;
  if (dismissed === key) return null;
  const detail = status.error ?? tr("overlays.data_directory_changes_were_saved_and_will_take_effect_after_restarting_cleo");
  return (
    <aside className="update-notice config-notice" role="status">
      <span className="update-notice-icon"><CircleAlert size={16} /></span>
      <div>
        <strong>{status.error ? tr("overlays.configuration_was_not_fully_applied") : tr("overlays.restart_cleo_to_apply_changes")}</strong>
        <small title={detail}>{detail}</small>
      </div>
      <button type="button" onClick={onRecheck}>{tr("dependencysetup.check_again")}</button>
      <button type="button" className="config-notice-close" aria-label={tr("overlays.dismiss_configuration_notice")} title={tr("overlays.dismiss_configuration_notice")} onClick={() => setDismissed(key)}><X size={14} /></button>
    </aside>
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
    available: tr("overlays.cleo_value_is_available", { p0: state.latestVersion }), ready: tr("overlays.update_ready"),
    installing: tr("overlays.preparing_installation"), updated: tr("overlays.update_successful"), "install-failed": tr("overlays.update_incomplete_2"),
  };
  return (
    <aside className={`update-notice${minimized ? " update-notice-minimized" : ""}`} role="status">
      {minimized ? <button type="button" aria-label={tr("overlays.expand_update_notice")} aria-expanded={false} onClick={() => setMinimized(false)}>
        <RefreshCw size={14} />{titles[state.phase] ?? tr("overlays.download_update_value", { p0: percent })}
      </button> : <>
      <span className="update-notice-icon"><RefreshCw size={16} /></span>
      <div>
        <strong>{titles[state.phase] ?? tr("overlays.downloading_update_value", { p0: percent })}</strong>
        {state.phase !== "available" || state.operationBusy ? <small>{result || state.phase === "installing" || state.phase === "ready" || state.operationBusy ? updateDescription(state) : `${formatBytes(state.downloadedBytes)} / ${formatBytes(state.totalBytes)}`}</small> : null}
      </div>
      {state.phase === "available" ? <button type="button" disabled={state.operationBusy} onClick={onDownload}>{tr("computerpanel.downloads")}</button> : null}
      {state.phase === "ready" ? <button type="button" disabled={state.operationBusy || Boolean(state.installBlocked)} onClick={onInstall}>{tr("overlays.restart_to_install")}</button> : null}
      {result ? <button type="button" onClick={() => setDismissed(resultKey)}>{tr("app.close")}</button> : null}
      <button type="button" aria-label={tr("overlays.minimize_update_notice")} title={tr("overlays.minimize_update_notice")} aria-expanded={true} onClick={() => setMinimized(true)}>−</button>
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
      setError(reason instanceof Error ? reason.message : tr("overlays.could_not_save_chat_instructions"));
    }
  };
  return (
    <form className="settings-page agent-instructions-page" onSubmit={submit}>
      <div className="agent-instructions-intro">
        <code className="agent-instructions-path">{instructions?.path ?? (loading ? tr("overlays.loading") : tr("overlays.instructions_have_not_loaded"))}</code>
        <button type="button" disabled={!instructions?.path} onClick={() => instructions?.path && onRevealPath(instructions.path)}><FolderOpen size={14} />{tr("overlays.open_location")}</button>
      </div>
      <textarea
        aria-label={tr("overlays.chat_instruction_content")}
        spellCheck={false}
        value={draft}
        disabled={!instructions && loading}
        placeholder={loading ? tr("overlays.loading") : tr("overlays.write_agents_md_instructions_here")}
        onChange={(event) => { setDraft(event.target.value); setSaved(false); }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <footer>
        <span className={error ? "error" : ""}>{error ?? (saved ? tr("overlays.saved") : dirty ? tr("overlays.unsaved_changes") : "")}</span>
        <div>
          <button type="button" disabled={!dirty || loading} onClick={() => { setDraft(baseline); setError(null); setSaved(false); }}><RotateCcw size={14} />{tr("overlays.discard_edits")}</button>
          <button className="primary" type="submit" disabled={!dirty || loading}><Save size={14} />{loading ? tr("backgroundmemorysettingspanel.saving") : tr("computerpanel.save")}</button>
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
      <div className="loading-brand" role="img" aria-label="Cleo" />
      {error ? <><strong>{tr("overlays.could_not_open_the_workspace")}</strong><p>{error}</p><button onClick={onRetry}>{tr("app.retry")}</button></> : <><div className="loading-line"><i /></div><span>{tr("overlays.opening_the_local_workspace")}</span></>}
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
  get chat() { return tr("app.chat"); },
  get productivity() { return tr("app.development"); },
  get memory() { return tr("app.memory"); },
};
