import { t as tr } from "../../electron/i18n.mjs";
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, LoaderCircle, RefreshCw } from "lucide-react";
import type { ProductivityModelCatalog, ReasoningEffort, RuntimeCatalog, RuntimeProfile } from "../types";
import { checkHarnessConnections } from "../connected-harnesses";
import { effortLabels } from "../runtime-labels";
import "./runtime-picker.css";

/** Close a popover on a click outside it or on Escape, handing focus back to its trigger. */
function useDismiss(open: boolean, close: () => void, wrap: RefObject<HTMLElement | null>, trigger: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) close(); };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const inside = wrap.current?.contains(document.activeElement);
      close();
      if (inside) { event.preventDefault(); event.stopPropagation(); trigger.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
}

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
  serviceTier?: "default" | "fast" | null;
  supportsFastMode?: boolean;
  onServiceTierChange?: (tier: "default" | "fast") => void;
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
  const showSpeed = supportsFastMode && Boolean(onServiceTierChange);
  const fast = showSpeed && serviceTier === "fast";

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
  const canReset = (defaultEffort !== null && defaultEffort !== shownEffort) || fast;
  const reset = () => {
    if (defaultEffort !== null && defaultEffort !== shownEffort) chooseEffort(defaultEffort);
    if (fast) onServiceTierChange?.("default");
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
          data-speed={showSpeed ? serviceTier ?? "" : undefined}
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
      {supportedEfforts.length > 0 || showSpeed ? (
        <EffortChip label={shownEffort ? effortLabels[shownEffort] ?? shownEffort : tr("conversation.fast_mode")}
          fast={fast} locked={locked} disabled={switching} levels={supportedEfforts} value={shownEffort} onChoose={chooseEffort}
          canReset={canReset} onReset={reset}
          speed={showSpeed ? { fast, onChange: (next) => onServiceTierChange?.(next ? "fast" : "default") } : null} />
      ) : null}
    </>
  );
}

/** Purpose: Reasoning effort as a chip of its own beside the model chip.
 * Input: the levels the model supports, the current one and what to do on a pick; the speed
 * switch when the harness has one. Output: the chip (the current level) and a short menu of the
 * levels, with the speed switch under them.
 */
function EffortChip({ label, fast, locked, disabled, levels, value, onChoose, canReset, onReset, speed }: {
  label: string;
  fast: boolean;
  locked: boolean;
  disabled: boolean;
  levels: ReasoningEffort[];
  value: ReasoningEffort | "";
  onChoose: (level: ReasoningEffort) => void;
  canReset: boolean;
  onReset: () => void;
  speed: { fast: boolean; onChange: (fast: boolean) => void } | null;
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
  return (
    <div className="runtime-picker rp-effort" ref={wrapRef}>
      <button ref={triggerRef} className="text-control runtime-selector-trigger" type="button" disabled={disabled}
        aria-label={tr("conversation.reasoning_effort")} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((current) => !current)} data-testid="effort-selector" data-value={value}
        data-options={JSON.stringify(levels)}>
        <span>{label}</span>
        {fast && value ? <small className="runtime-selector-extra">{tr("conversation.fast")}</small> : null}
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
                aria-checked={level === value} onClick={() => { onChoose(level); setOpen(false); triggerRef.current?.focus(); }}>
                <span>{effortLabels[level] ?? level}</span>
                {level === value ? <Check size={14} /> : null}
              </button>
            ))}
          </div>
          {speed ? (
            <div className="rp-section">
              <label className="rp-row rp-toggle">
                <span>{tr("conversation.fast_mode")}</span>
                <span className="switch"><input type="checkbox" role="switch" checked={speed.fast} disabled={locked}
                  data-testid="speed-toggle" onChange={(event) => speed.onChange(event.target.checked)} /><span /></span>
              </label>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
