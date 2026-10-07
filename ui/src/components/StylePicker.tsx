import { useEffect, useState } from "react";
import { Palette } from "lucide-react";

export const STYLE_STORAGE_KEY = "cleo-style";

export const styleOptions = [
  { id: "", label: "现有" },
  { id: "paper", label: "纸墨" },
  { id: "console", label: "终端" },
  { id: "slate", label: "墨蓝" },
  { id: "linen", label: "亚麻" },
] as const;

export type StyleId = (typeof styleOptions)[number]["id"];

/** Purpose: Apply a visual style variant to the document root and remember it. */
export function applyStyle(style: string) {
  if (style) document.documentElement.dataset.style = style;
  else delete document.documentElement.dataset.style;
  try {
    if (style) localStorage.setItem(STYLE_STORAGE_KEY, style);
    else localStorage.removeItem(STYLE_STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Purpose: Resolve the initial style from the URL (?style=) or storage. */
export function initialStyle(): string {
  const fromQuery = new URLSearchParams(window.location.search).get("style");
  if (fromQuery !== null) return fromQuery;
  try {
    return localStorage.getItem(STYLE_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Purpose: Floating review-only switcher for comparing style variants and themes in the browser preview. */
export function StylePicker() {
  const [style, setStyle] = useState(() => document.documentElement.dataset.style ?? "");
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "dark");
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme ?? "dark"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  const choose = (next: string) => {
    applyStyle(next);
    setStyle(next);
  };
  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    localStorage.setItem("cleo-theme", next);
    window.location.reload();
  };
  return (
    <div className="style-picker" role="group" aria-label="风格预览">
      <Palette size={14} />
      {styleOptions.map((option) => (
        <button
          key={option.id || "default"}
          type="button"
          className={style === option.id ? "active" : ""}
          onClick={() => choose(option.id)}
        >
          {option.label}
        </button>
      ))}
      <span className="style-picker-divider" />
      <button type="button" onClick={toggleTheme}>{theme === "light" ? "浅色" : "深色"}</button>
    </div>
  );
}
