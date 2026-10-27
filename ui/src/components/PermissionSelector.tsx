import { t as tr } from "../../electron/i18n.mjs";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown, ShieldCheck } from "lucide-react";
import type { RuntimeProfile, RuntimeUpdate } from "../types";
import { accessLabel, approvalLabel } from "../runtime-labels";
import "./permission-selector.css";

/** Purpose: Select an atomic native permission preset without optimistic activation.
 * Input: Current/pending session settings and an awaited session-bound save callback.
 * Output: A pill styled like the composer's other controls whose menu opens above it (so it
 * never runs off the bottom of the window), with arrow-key, Escape and click-outside handling;
 * the pill's tooltip explains the effective state and save errors show beside it. In a panel
 * with room below, `placement="down"` opens the menu underneath instead.
 */
export function PermissionSelector({ runtime, onChange, disabled = false, placement = "up" }: {
  runtime: RuntimeProfile;
  onChange?: (update: RuntimeUpdate) => Promise<void>;
  disabled?: boolean;
  placement?: "up" | "down";
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  const inFlight = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const presets = runtime.permissionOptions?.presets ?? [];

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  // Size the list to the room between the pill and the window edge, then focus the current choice.
  useLayoutEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const room = placement === "up" ? rect.top : window.innerHeight - rect.bottom;
      setMaxHeight(Math.max(96, Math.floor(room - 56)));
    }
    const options = listRef.current?.querySelectorAll<HTMLButtonElement>("button:enabled") ?? [];
    const current = Array.from(options).find((option) => option.getAttribute("aria-checked") === "true");
    (current ?? options[0])?.focus();
  }, [open, placement]);

  if (!presets.length || !onChange) return null;
  const pending = runtime.pendingPermissions;
  const selected = pending?.provider === runtime.provider ? {
    ...runtime, access: pending.access ?? runtime.access, approval: pending.approval ?? runtime.approval,
  } : runtime;
  const matches = (preset: typeof presets[number], settings: typeof selected) =>
    preset.update.approval === settings.approval &&
    (!preset.update.access || preset.update.access === settings.access);
  const current = presets.find(preset => matches(preset, selected));
  const effective = presets.find(preset => matches(preset, runtime));
  const actual = effective?.label ?? `${accessLabel(runtime.access)} · ${approvalLabel(runtime.approval)}`;
  const save = async (value: string) => {
    const preset = presets.find(item => item.value === value);
    if (!preset || preset.disabledReason || inFlight.current) return;
    inFlight.current = true;
    setSaving(true); setError("");
    try { await onChange({ ...preset.update, permissionProvider: runtime.provider }); }
    catch (error) { setError(error instanceof Error ? error.message : tr("permissionselector.permissions_were_not_saved_try_again")); }
    finally { inFlight.current = false; setSaving(false); }
  };
  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button:enabled") ?? []);
    if (!options.length) return;
    event.preventDefault();
    const index = options.findIndex((option) => option === document.activeElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? options.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next].focus();
  };
  return <div className="permission-selector" ref={wrapRef} onKeyDown={event => {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    setOpen(false);
    triggerRef.current?.focus();
  }}>
    <button className="text-control permission-selector-trigger" type="button" ref={triggerRef}
      aria-label={tr("permissionselector.session_permissions")} aria-haspopup="menu" aria-expanded={open} data-testid="permission-selector"
      data-value={current?.value ?? "custom"}
      title={[current?.description ?? actual, pending ? tr("permissionselector.applies_next_turn_current_value", { p0: actual }) : "", runtime.permissionOptions?.reason ?? ""].filter(Boolean).join("\n")}
      disabled={disabled || saving} onClick={() => setOpen(value => !value)}>
      <ShieldCheck size={14} />
      <span className="permission-selector-label">{current?.label ?? tr("permissionselector.custom_permissions")}</span>
      <ChevronDown size={13} />
    </button>
    {open && <div className={`permission-menu surface-popover ${placement}`} role="menu" aria-label={tr("permissionselector.choose_session_permissions")}
      data-testid="permission-menu" onKeyDown={moveFocus}>
      <div className="permission-menu-heading">{tr("permissionselector.session_permissions")}</div>
      <div className="permission-menu-list" ref={listRef} style={maxHeight ? { maxHeight } : undefined}>
        {presets.map(preset => {
          const checked = preset.value === current?.value;
          return <button key={preset.value} className={`permission-option ${checked ? "selected" : ""}`} type="button"
            role="menuitemradio" aria-checked={checked} disabled={Boolean(preset.disabledReason)}
            title={preset.disabledReason ?? preset.description} data-testid="permission-option" data-value={preset.value}
            onClick={() => { setOpen(false); triggerRef.current?.focus(); void save(preset.value); }}>
            <span className="permission-option-copy">
              <strong>{preset.label}</strong>
              {(preset.disabledReason || preset.description) && <small>{preset.disabledReason ?? preset.description}</small>}
            </span>
            {checked && <Check size={14} />}
          </button>;
        })}
      </div>
    </div>}
    {saving && <small role="status">{tr("permissionselector.checking_permissions")}</small>}
    {error && <span className="permission-selector-error" role="alert">{error}</span>}
  </div>;
}
