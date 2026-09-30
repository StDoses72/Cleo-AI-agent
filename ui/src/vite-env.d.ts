/// <reference types="vite/client" />

interface Window {
  cleoWindow?: {
    platform?: string;
    setTheme(theme: "dark" | "light"): void;
  };
  cleoDesktop?: {
    onCompanionThread?(listener: (thread: import("./types").Thread) => void): () => void;
    setup?(action: "startup" | "status" | "scan" | "install" | "dismiss", params?: Record<string, unknown>): Promise<import("./components/DependencySetup").SetupState>;
    computer?(action: "state" | "viewport" | "browser" | "mode" | "authorize" | "takeover" | "handback" | "stop" | "shortcut" | "preview", params?: Record<string, unknown>): Promise<import("./computer-types").ComputerState>;
    onComputerState?(listener: (state: import("./computer-types").ComputerState) => void): () => void;
    files?<T = unknown>(op: "list" | "read" | "locate", params: Record<string, unknown>): Promise<T>;
    request<T = unknown>(method: string, params?: Record<string, unknown>, streamId?: string | null): Promise<T>;
    onStreamEvent(listener: (payload: { streamId: string; event: unknown }) => void): () => void;
    pickAttachments(): Promise<import("./types").Attachment[]>;
    prepareAttachments(files: File[]): Promise<import("./types").Attachment[]>;
    pickWorkspace(): Promise<string | null>;
    copyText(value: string): Promise<void>;
    revealPath(value: string): Promise<void>;
    openLocalPath(href: string, workspacePath: string): Promise<void>;
    getEvolutionState(): Promise<import("./evolution-types").EvolutionState>;
    evolutionAction<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T>;
    onEvolutionState(listener: (state: import("./evolution-types").EvolutionState) => void): () => void;
    confirmHealthy(): Promise<void>;
    getUpdateState(): Promise<import("./types").UpdateState>;
    checkForUpdates(tag?: string): Promise<import("./types").UpdateState>;
    downloadUpdate(): Promise<import("./types").UpdateState>;
    installUpdate(): Promise<boolean>;
    onUpdateState(listener: (state: import("./types").UpdateState) => void): () => void;
  };
}
