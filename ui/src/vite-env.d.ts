/// <reference types="vite/client" />

interface Window {
  cleoDesktop?: {
    request<T = unknown>(method: string, params?: Record<string, unknown>, streamId?: string | null): Promise<T>;
    onStreamEvent(listener: (payload: { streamId: string; event: unknown }) => void): () => void;
    pickAttachments(): Promise<import("./types").Attachment[]>;
    pickWorkspace(): Promise<string | null>;
    copyText(value: string): Promise<void>;
    revealPath(value: string): Promise<void>;
    getUpdateState(): Promise<import("./types").UpdateState>;
    checkForUpdates(): Promise<import("./types").UpdateState>;
    downloadUpdate(): Promise<import("./types").UpdateState>;
    installUpdate(): Promise<boolean>;
    onUpdateState(listener: (state: import("./types").UpdateState) => void): () => void;
  };
}
