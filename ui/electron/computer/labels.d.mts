import type { MessageKey } from "../i18n.mjs";
export function stepLabel(name: string, detail?: string): string;
export function phaseLabel(phase: string, current?: string | null, detail?: string): string;
export const MODE_LABEL_KEYS: Record<"browser" | "user" | "host", MessageKey>;
