import messages from "./locales.json";
import recoveryMessages from "./recovery-locales.json";
export type UiLanguage = "zh-CN" | "en";
export type MessageKey = keyof typeof messages | keyof typeof recoveryMessages;
export function getLanguage(): UiLanguage;
export function relativeTime(count: number, unit: "minute" | "hour" | "day"): string;
export function setLanguage(value: UiLanguage): void;
export function subscribeLanguage(listener: () => void): () => void;
export function t(key: MessageKey, params?: Record<string, unknown>): string;
