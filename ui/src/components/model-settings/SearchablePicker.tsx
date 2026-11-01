import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

export interface PickerOption { value: string; label: string; group?: string; detail?: string; disabled?: boolean }

/** Search a shared catalog without expanding every configuration in the page. */
export function SearchablePicker({ label, options, selected, multiple = false, disabled = false, placeholder = "选择模型", onChange }: {
  label: string; options: PickerOption[]; selected: string[]; multiple?: boolean; disabled?: boolean;
  placeholder?: string; onChange: (values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();
  const filtered = options.filter(item => `${item.label} ${item.group ?? ""} ${item.detail ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const selectedOptions = options.filter(item => selected.includes(item.value));
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (open) document.getElementById(`${id}-${cursor}`)?.scrollIntoView({ block: "nearest" });
  }, [cursor, open, id]);
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const choose = (item: PickerOption) => {
    if (item.disabled || disabled) return;
    onChange(multiple ? selected.includes(item.value) ? selected.filter(value => value !== item.value) : [...selected, item.value] : [item.value]);
    if (!multiple) { setOpen(false); root.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
  };
  return <div className="search-picker" ref={root}>
    <button type="button" className="search-picker-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={id} disabled={disabled}
      onClick={() => { setOpen(!open); setQuery(""); setCursor(0); }}>
      <span>{multiple ? selectedOptions.length ? `已选择 ${selectedOptions.length} 个模型` : placeholder : selectedOptions[0]?.label ?? placeholder}</span><ChevronDown size={15} />
    </button>
    {open && <div className="search-picker-popup" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); root.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setCursor(index => Math.max(0, Math.min(filtered.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))); }
      if (event.key === "Enter" && event.target === search.current) { event.preventDefault(); if (filtered[cursor]) choose(filtered[cursor]); }
    }}>
      <label className="search-picker-search"><Search size={14} /><input ref={search} aria-label={`搜索${label}`} placeholder="搜索模型或连接…" value={query} onChange={event => { setQuery(event.target.value); setCursor(0); }}
        role="combobox" aria-expanded={open} aria-controls={id} aria-autocomplete="list" aria-activedescendant={filtered[cursor] ? `${id}-${cursor}` : undefined} /></label>
      <div id={id} role="listbox" aria-label={label} aria-multiselectable={multiple || undefined} className="search-picker-options">
        {filtered.map((item, index) => <button type="button" role="option" id={`${id}-${index}`} key={item.value} aria-selected={selected.includes(item.value)} aria-disabled={item.disabled || undefined}
          data-active={index === cursor} title={item.detail} onClick={() => choose(item)}>
          <span className="search-picker-check">{selected.includes(item.value) && <Check size={14} />}</span>
          <span><strong>{item.label}</strong>{(item.group || item.detail) && <small>{[item.group, item.detail].filter(Boolean).join(" · ")}</small>}</span>
        </button>)}
        {!filtered.length && <div className="search-picker-empty">没有匹配的模型</div>}
      </div>
    </div>}
  </div>;
}
