import messages from "./locales.json" with { type: "json" };
import recoveryMessages from "./recovery-locales.json" with { type: "json" };

let language = "zh-CN";
const listeners = new Set();

export const getLanguage = () => language;
export const relativeTime = (count, unit) => new Intl.RelativeTimeFormat(language, { numeric: "always" }).format(-count, unit);
export function setLanguage(value) {
  if (value !== "zh-CN" && value !== "en") throw new Error("Unsupported UI language");
  if (language === value) return;
  language = value;
  for (const listener of listeners) listener();
}
export function subscribeLanguage(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function t(key, params = {}) {
  const entry = recoveryMessages[key] ?? messages[key];
  const template = entry?.[language] ?? entry?.en ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
}
