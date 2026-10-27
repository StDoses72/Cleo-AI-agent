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
function message(key, params, selectedLanguage) {
  const entry = recoveryMessages[key] ?? messages[key];
  const template = entry?.[selectedLanguage] ?? entry?.en ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
}
export const t = (key, params = {}) => message(key, params, language);
export function translator(selectedLanguage) {
  if (selectedLanguage !== "zh-CN" && selectedLanguage !== "en") throw new Error("Unsupported UI language");
  return (key, params = {}) => message(key, params, selectedLanguage);
}
// Internal control templates must not change pending request hashes when the UI switches.
export const sourceText = (key, params = {}) => message(key, params, "zh-CN");
