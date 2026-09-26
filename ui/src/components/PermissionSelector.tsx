import { useRef, useState } from "react";
import type { RuntimeProfile, RuntimeUpdate } from "../types";
import { accessLabel, approvalLabel } from "../runtime-labels";
import "./permission-selector.css";

/** Purpose: Select an atomic native permission preset without optimistic activation.
 * Input: Current/pending session settings and an awaited session-bound save callback.
 * Output: A compact selector, effective-state explanation and visible save errors.
 */
export function PermissionSelector({ runtime, onChange, disabled = false }: {
  runtime: RuntimeProfile;
  onChange?: (update: RuntimeUpdate) => Promise<void>;
  disabled?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const presets = runtime.permissionOptions?.presets ?? [];
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
    catch (error) { setError(error instanceof Error ? error.message : "权限设置未保存，请重试。"); }
    finally { inFlight.current = false; setSaving(false); }
  };
  return <div className="permission-selector">
    <select className="text-control" aria-label="会话权限" data-testid="permission-selector"
      title={`${current?.description ?? actual}\n${runtime.permissionOptions?.reason ?? ""}`}
      value={current?.value ?? "custom"} disabled={disabled || saving}
      onChange={event => void save(event.target.value)}>
      {!current && <option value="custom" disabled>自定义权限</option>}
      {presets.map(preset => <option key={preset.value} value={preset.value}
        disabled={Boolean(preset.disabledReason)} title={preset.disabledReason ?? preset.description}>
        {preset.label}{preset.disabledReason ? `（${preset.disabledReason}）` : ""}
      </option>)}
    </select>
    {saving && <small role="status">正在核对权限…</small>}
    {pending && <small role="status" title={`当前：${actual}`}>下轮生效 · 当前：{actual}</small>}
    {error && <span className="permission-selector-error" role="alert">{error}</span>}
  </div>;
}
