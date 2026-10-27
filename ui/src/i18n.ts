import { useEffect, useSyncExternalStore } from "react";
import { getLanguage, setLanguage, subscribeLanguage } from "../electron/i18n.mjs";
export { getLanguage, setLanguage, t, type UiLanguage } from "../electron/i18n.mjs";

if (typeof window !== "undefined") {
  setLanguage(window.cleoWindow?.language ?? "zh-CN");
  window.cleoWindow?.onLanguageChanged?.(setLanguage);
}

export function useLanguage() {
  const language = useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  return language;
}
