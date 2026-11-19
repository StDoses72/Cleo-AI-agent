import { t as tr } from "../../electron/i18n.mjs";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, LoaderCircle, RefreshCw } from "lucide-react";
import type { ProductivityModelCatalog, ReasoningEffort, RuntimeCatalog, RuntimeProfile, ServiceTier, ServiceTierOption } from "../types";
import { checkHarnessConnections } from "../connected-harnesses";
import { effortLabels } from "../runtime-labels";
import { useDismiss } from "./useDismiss";
import "./runtime-picker.css";

/** Arrow keys walk a menu's enabled rows, from the search field too. */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-row]:not(:disabled)")];
  if (!rows.length) return;
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "ArrowDown" ? (at + 1) % rows.length : at <= 0 ? rows.length - 1 : at - 1;
  event.preventDefault();
  rows[next].focus();
}

type Connection = "checking" | "connected" | "unavailable";

/** Purpose: Choose how a development task runs, in the order the choice is made: a harness, then
 * one of the models that harness offers, with reasoning effort as a chip of its own beside it.
 * Input: the live catalog, the task's runtime and what to do on a pick. Output: the model chip
 * ("harness · model") with its menu, and the effort chip when the model has levels or a speed
 * switch. The model menu opens on the current harness's models; its heading leads to the harness
 * list, and the menu opens on that list when the current harness has no models to offer. A
 * harness that fails its check stays listed, marked as not connected. A menu is as tall as what
 * it lists, up to most of the conversation's height, and scrolls beyond that.
 */
export function RuntimePicker({
  runtime,
  catalog,
  productivityModels,
  running,
  switching,
  pendingSwitch = false,
  onLoadModels,
  onSelectProductivityRuntime,
  effort = "",
  supportedEfforts = [],
  defaultEffort = null,
  onEffortChange,
  serviceTier = null,
  supportsFastMode = false,
  serviceTiers,
  onServiceTierChange,
}: {
  runtime: RuntimeProfile;
  catalog: RuntimeCatalog | null;
  productivityModels: Record<string, ProductivityModelCatalog>;
  running: boolean;
  switching: boolean;
  /** A harness pick awaits the next message; the chip reads as it will after the handoff. */
  pendingSwitch?: boolean;
  onLoadModels: (provider: string, refresh?: boolean, background?: boolean) => Promise<ProductivityModelCatalog>;
  onSelectProductivityRuntime: (provider: string, model: string) => void;
  effort?: ReasoningEffort | "";
  supportedEfforts?: ReasoningEffort[];
  defaultEffort?: ReasoningEffort | null;
  onEffortChange?: (effort: ReasoningEffort) => void | Promise<void>;
  serviceTier?: ServiceTier | null;
  supportsFastMode?: boolean;
  /** The current model's speeds beyond standard; absent when the harness catalog does not say. */
  serviceTiers?: ServiceTierOption[];
  onServiceTierChange?: (tier: ServiceTier) => void;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<"models" | "harnesses">("models");
  // The harness whose models are listed; picking one of them switches the task to it.
  const [viewed, setViewed] = useState(runtime.provider);
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<Record<string, ProductivityModelCatalog | null>>({});
  const [checkVersion, setCheckVersion] = useState(0);
  // A picked effort shows at once; it yields to the committed one when the backend answers.
  const [previewEffort, setPreviewEffort] = useState<ReasoningEffort | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const loadModelsRef = useRef(onLoadModels);
  loadModelsRef.current = onLoadModels;

  const locked = running || switching;
  const providers = catalog?.productivityProviders ?? [];
  const shownEffort = previewEffort ?? effort;
  const speed = speedState(supportsFastMode && Boolean(onServiceTierChange), serviceTier, serviceTiers);

  // What is known about a harness: this check's answer once it is in (a failed check offers no
  // models), the last loaded list while it runs.
  const modelsOf = (id: string) => (id in checked ? checked[id] : productivityModels[id])?.models ?? [];
  const connectionOf = (id: string): Connection => id in checked
    ? (checked[id] ? "connected" : "unavailable")
    : modelsOf(id).length ? "connected" : "checking";
  const checking = providers.some((provider) => !(provider.id in checked));
  const modelLabel = (id: string, model: string) => modelsOf(id).find((entry) => entry.id === model)?.label ?? model;
  const defaultModelOf = (id: string) => modelsOf(id).find((model) => model.isDefault)?.id
    ?? providers.find((provider) => provider.id === id)?.defaultModel ?? modelsOf(id)[0]?.id ?? "";
  const models = modelsOf(viewed);

  useEffect(() => { setPreviewEffort(null); }, [effort]);
  useEffect(() => {
    if (!open) return;
    setViewed(runtime.provider);
    setQuery("");
    setPage("models");
  }, [open]);
  // Every harness is checked when the menu opens; results arrive one by one.
  useEffect(() => {
    if (!open || !catalog) return;
    let cancelled = false;
    setChecked({});
    const settle = (id: string, loaded: ProductivityModelCatalog | null) => {
      if (!cancelled) setChecked((current) => ({ ...current, [id]: loaded }));
    };
    void checkHarnessConnections(catalog.productivityProviders,
      (provider) => loadModelsRef.current(provider, true, true),
      (provider, loaded) => settle(provider.id, loaded),
      (provider) => settle(provider.id, null));
    return () => { cancelled = true; };
  }, [open, catalog, checkVersion]);
  // Nothing to pick under the listed harness: the menu becomes the harness list.
  useEffect(() => {
    if (open && page === "models" && connectionOf(viewed) === "unavailable") setPage("harnesses");
  }, [open, page, viewed, checked]);
  useDismiss(open, () => setOpen(false), wrapRef, triggerRef);
  // Each page places the keyboard once, on its current choice, so the arrow keys and Enter act on
  // the menu. `placementDone` says that turn is over; `placedFocus` is where the menu itself put
  // focus. A list that arrives late moves focus again only while it is still where the menu put
  // it: once the user has it (inside the menu, back in the composer, anywhere) it is left alone.
  const placementDone = useRef(false);
  const placedFocus = useRef<HTMLElement | null>(null);
  useEffect(() => { placementDone.current = false; placedFocus.current = null; }, [open, page, viewed]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const menu = wrapRef.current?.querySelector<HTMLElement>(".runtime-picker-menu");
      if (!menu) return;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const first = !placementDone.current;
      if (first && active && active !== document.body && active !== triggerRef.current) {
        // Already on a control of their own choosing: the placement turn is the user's.
        placementDone.current = true;
        return;
      }
      if (!first && (!placedFocus.current || active !== placedFocus.current)) return;
      const target = menu.querySelector<HTMLElement>("[data-row][aria-current='true']:not(:disabled)")
        ?? (first ? menu.querySelector<HTMLElement>("[data-row]:not(:disabled)") ?? menu.querySelector<HTMLElement>("button:not(:disabled)") : null);
      if (!target) return;
      if (target !== active) target.focus();
      placementDone.current = true;
      placedFocus.current = target;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, page, viewed, models.length > 0]);

  // The picked effort shows at once and lasts until its update settles: the committed effort
  // arrives with it, and a rejected update falls back to the effort the task still has (so the
  // same level can be picked again).
  const effortCommit = useRef<object | null>(null);
  const chooseEffort = (value: ReasoningEffort) => {
    if (locked || value === shownEffort) return;
    const commit = {};
    effortCommit.current = commit;
    setPreviewEffort(value);
    void Promise.resolve(onEffortChange?.(value)).catch(() => undefined).then(() => {
      if (effortCommit.current !== commit) return;
      effortCommit.current = null;
      setPreviewEffort(null);
    });
  };
  const speedChanged = speed !== null && (speed.effective !== "default" || speed.unavailable !== null);
  const canReset = (defaultEffort !== null && defaultEffort !== shownEffort) || speedChanged;
  const reset = () => {
    if (defaultEffort !== null && defaultEffort !== shownEffort) chooseEffort(defaultEffort);
    if (speedChanged) onServiceTierChange?.("default");
  };
  const pickModel = (model: string) => {
    onSelectProductivityRuntime(viewed, model);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const needle = query.trim().toLowerCase();
  const visibleModels = needle ? models.filter((model) => `${model.label} ${model.id}`.toLowerCase().includes(needle)) : models;
  const visibleProviders = needle ? providers.filter((provider) => provider.id.toLowerCase().includes(needle)) : providers;

  return (
    <>
      <div className="runtime-selector runtime-picker" ref={wrapRef}>
        <button
          ref={triggerRef}
          className="text-control runtime-selector-trigger"
          type="button"
          disabled={switching || !catalog}
          aria-label={tr("conversation.change_runtime_or_model")}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          data-testid="runtime-selector"
          data-effort={effort || undefined}
          data-speed={speed ? serviceTier ?? "" : undefined}
          data-pending-switch={pendingSwitch ? "true" : undefined}
        >
          <span>{runtime.provider} · {modelLabel(runtime.provider, runtime.model)}</span>
          <ChevronDown size={13} />
        </button>
        {open ? (
          <div className="runtime-picker-menu surface-popover" role="dialog" aria-label={tr("conversation.change_runtime_or_model")}
            data-testid="runtime-menu" data-page={page} onKeyDown={moveFocus}>
            {page === "harnesses" ? (
              <>
                <div className="rp-head">
                  <strong>{tr("conversation.switch_harness")}</strong>
                  <button type="button" className="rp-icon" disabled={checking} onClick={() => setCheckVersion((value) => value + 1)}
                    aria-label={tr("runtimepicker.check_again")} title={tr("runtimepicker.check_again")} data-testid="runtime-recheck">
                    {checking ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
                  </button>
                </div>
                {providers.length > 6 ? <input className="rp-search" type="search" value={query} placeholder={tr("runtimepicker.search_harnesses")}
                  aria-label={tr("runtimepicker.search_harnesses")} onChange={(event) => setQuery(event.target.value)} /> : null}
                <div className="rp-list" data-testid="runtime-harness-list">
                  {visibleProviders.map((provider) => {
                    const connection = connectionOf(provider.id);
                    const current = provider.id === runtime.provider;
                    return (
                      <button type="button" key={provider.id} className="rp-item rp-harness" data-row data-connection={connection}
                        data-testid="runtime-harness" aria-current={current} disabled={connection === "unavailable"}
                        onClick={() => { setViewed(provider.id); setQuery(""); setPage("models"); }}>
                        <span className="rp-dot" aria-hidden="true" />
                        <strong>{provider.id}</strong>
                        <small>{connection === "unavailable" ? tr("runtimepicker.unavailable")
                          : connection === "checking" ? tr("runtimepicker.checking")
                            : modelLabel(provider.id, current ? runtime.model : defaultModelOf(provider.id))}</small>
                        {current ? <Check size={14} /> : connection === "unavailable" ? null : <ChevronRight size={14} />}
                      </button>
                    );
                  })}
                  {!visibleProviders.length ? <p className="rp-status">{tr("runtimepicker.no_matching_harnesses")}</p> : null}
                </div>
              </>
            ) : (
              <>
                {/* The heading names the harness whose models are listed, and is the way back to the others. */}
                <button type="button" className="rp-head rp-back" onClick={() => { setQuery(""); setPage("harnesses"); }}
                  aria-label={tr("conversation.switch_harness")} data-testid="runtime-harness-back">
                  <ChevronLeft size={14} />
                  <strong>{viewed}</strong>
                  <small>{tr("conversation.switch_harness")}</small>
                </button>
                {models.length > 8 ? <input className="rp-search" type="search" value={query} placeholder={tr("conversation.search_models")}
                  aria-label={tr("conversation.search_models")} onChange={(event) => setQuery(event.target.value)} data-testid="runtime-model-search" /> : null}
                <div className="rp-list" data-testid="runtime-model-list">
                  {visibleModels.map((model) => {
                    const selected = viewed === runtime.provider && runtime.model === model.id;
                    return (
                      <button type="button" key={model.id} className="rp-item" data-row aria-current={selected} disabled={locked}
                        data-testid="runtime-model" onClick={() => pickModel(model.id)}>
                        <span>{model.label}</span>
                        {selected ? <Check size={14} /> : null}
                      </button>
                    );
                  })}
                  {models.length && !visibleModels.length ? <p className="rp-status">{tr("conversation.no_matching_models")}</p> : null}
                  {!models.length ? <p className="rp-status" role="status"><LoaderCircle className="spin" size={13} />{tr("conversation.loading_models")}</p> : null}
                </div>
              </>
            )}
          </div>
        ) : null}
      </div>
      {supportedEfforts.length > 0 || speed ? (
        <EffortChip label={shownEffort ? effortLabels[shownEffort] ?? shownEffort
          : speed?.mode === "list" ? tierLabel(speed.effective) : tr("conversation.fast_mode")}
          locked={locked} disabled={switching} levels={supportedEfforts} value={shownEffort} onChoose={chooseEffort}
          canReset={canReset} onReset={reset} model={modelLabel(runtime.provider, runtime.model)}
          speed={speed} onSpeedChange={(tier) => onServiceTierChange?.(tier)} />
      ) : null}
    </>
  );
}

type SpeedState = {
  /** "list" when the model offers Ultrafast, "toggle" for Fast alone, null for no choice. */
  mode: "list" | "toggle" | null;
  offered: ServiceTierOption[];
  /** The speed a turn runs at: the saved one when the model offers it, standard otherwise. */
  effective: ServiceTier;
  /** A saved speed the current model does not offer. */
  unavailable: ServiceTier | null;
};

const tierLabel = (tier: ServiceTier) => tr(tier === "ultrafast" ? "conversation.speed_ultrafast"
  : tier === "fast" ? "conversation.speed_fast" : "conversation.speed_standard");

/** Purpose: What the speed control shows for the current model.
 * Input: whether the harness has speeds, the saved speed and the model's catalog speeds (absent
 * when the catalog does not say, which leaves Fast as the one choice, as before Ultrafast).
 * Output: the state, or null when there is neither a choice nor a saved speed to report.
 */
function speedState(enabled: boolean, saved: ServiceTier | null, catalog: ServiceTierOption[] | undefined): SpeedState | null {
  if (!enabled) return null;
  const offered: ServiceTierOption[] = catalog ?? [{ id: "fast", label: tierLabel("fast"), description: "" }];
  const tier = saved ?? "default";
  const effective = tier === "default" || offered.some((option) => option.id === tier) ? tier : "default";
  const unavailable = tier === effective ? null : tier;
  const mode = offered.some((option) => option.id === "ultrafast") ? "list"
    : offered.some((option) => option.id === "fast") ? "toggle" : null;
  return mode || unavailable ? { mode, offered, effective, unavailable } : null;
}

/** Purpose: Reasoning effort as a chip of its own beside the model chip.
 * Input: the levels the model supports, the current one and what to do on a pick; the model's
 * speeds when the harness has them. Output: the chip (the current level and a non-standard
 * speed) and a short menu of the levels with the speed under them: a switch for Fast alone, a
 * list of Standard, Fast and Ultrafast when the model offers Ultrafast. A saved speed the model
 * does not offer is named in the menu and the chip reads Standard.
 */
function EffortChip({ label, locked, disabled, levels, value, onChoose, canReset, onReset, model, speed, onSpeedChange }: {
  label: string;
  locked: boolean;
  disabled: boolean;
  levels: ReasoningEffort[];
  value: ReasoningEffort | "";
  onChoose: (level: ReasoningEffort) => void;
  canReset: boolean;
  onReset: () => void;
  model: string;
  speed: SpeedState | null;
  onSpeedChange: (tier: ServiceTier) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useDismiss(open, () => setOpen(false), wrapRef, triggerRef);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const menu = wrapRef.current?.querySelector<HTMLElement>(".runtime-picker-menu");
      (menu?.querySelector<HTMLElement>("[data-row][aria-checked='true']:not(:disabled)")
        ?? menu?.querySelector<HTMLElement>("[data-row]:not(:disabled)"))?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const choose = (pick: () => void) => { pick(); setOpen(false); triggerRef.current?.focus(); };
  const unavailableNote = speed?.unavailable
    ? tr("conversation.speed_unavailable", { p0: tierLabel(speed.unavailable), p1: model }) : null;
  const extra = !value || !speed ? null
    : speed.unavailable ? `· ${tr("conversation.speed_standard")}`
      : speed.effective === "fast" ? tr("conversation.fast")
        : speed.effective === "ultrafast" ? tr("conversation.ultrafast") : null;
  return (
    <div className="runtime-picker rp-effort" ref={wrapRef}>
      <button ref={triggerRef} className="text-control runtime-selector-trigger" type="button" disabled={disabled}
        aria-label={tr("conversation.reasoning_effort")} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((current) => !current)} data-testid="effort-selector" data-value={value}
        data-options={JSON.stringify(levels)} data-speed={speed?.effective}
        data-speed-unavailable={speed?.unavailable ?? undefined} title={unavailableNote ?? undefined}>
        <span>{label}</span>
        {extra ? <small className="runtime-selector-extra" data-unavailable={speed?.unavailable ? "true" : undefined}>{extra}</small> : null}
        <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="runtime-picker-menu rp-effort-menu surface-popover" role="menu" aria-label={tr("conversation.reasoning_effort")}
          data-testid="effort-menu" onKeyDown={moveFocus}>
          <div className="rp-head">
            <strong>{tr("conversation.reasoning_effort")}</strong>
            {canReset ? <button type="button" className="rp-link" disabled={locked} onClick={onReset}
              data-testid="runtime-reset">{tr("conversation.restore_defaults")}</button> : null}
          </div>
          <div className="rp-list">
            {levels.map((level) => (
              <button type="button" role="menuitemradio" key={level} className="rp-item" data-row disabled={locked}
                aria-checked={level === value} onClick={() => choose(() => onChoose(level))}>
                <span>{effortLabels[level] ?? level}</span>
                {level === value ? <Check size={14} /> : null}
              </button>
            ))}
          </div>
          {speed?.mode === "list" ? (
            <div className="rp-section rp-speed" role="group" aria-label={tr("conversation.speed")} data-testid="speed-menu">
              {unavailableNote ? <p className="rp-note" role="status" data-testid="speed-unavailable">{unavailableNote}</p> : null}
              {[{ id: "default" as const, label: tierLabel("default"), description: tr("conversation.speed_standard_description") },
                ...speed.offered.map((option) => ({ ...option, label: tierLabel(option.id) }))].map((option) => (
                <button type="button" role="menuitemradio" key={option.id} className="rp-item rp-tier" data-row disabled={locked}
                  aria-checked={option.id === speed.effective} data-testid="speed-option" data-tier={option.id}
                  onClick={() => choose(() => { if (option.id !== speed.effective || speed.unavailable) onSpeedChange(option.id); })}>
                  <span className="rp-tier-text">
                    <span>{option.label}</span>
                    {option.description ? <small>{option.description}</small> : null}
                  </span>
                  {option.id === speed.effective ? <Check size={14} /> : null}
                </button>
              ))}
            </div>
          ) : speed ? (
            <div className="rp-section">
              {unavailableNote ? <p className="rp-note" role="status" data-testid="speed-unavailable">{unavailableNote}</p> : null}
              {speed.mode === "toggle" ? (
                <label className="rp-row rp-toggle">
                  <span>{tr("conversation.fast_mode")}</span>
                  <span className="switch"><input type="checkbox" role="switch" checked={speed.effective === "fast"} disabled={locked}
                    data-testid="speed-toggle" onChange={(event) => onSpeedChange(event.target.checked ? "fast" : "default")} /><span /></span>
                </label>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
