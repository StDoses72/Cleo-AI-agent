/// <reference types="vite/client" />

interface Window {
  cleoWindow?: {
    platform?: string;
    setTheme(theme: "dark" | "light"): void;
  };
  cleoDesktop?: {
    onCompanionThread?(listener: (thread: import("./types").Thread) => void): () => void;
    setup?(action: "startup" | "status" | "scan" | "install" | "dismiss", params?: Record<string, unknown>): Promise<import("./components/DependencySetup").SetupState>;
    computerDesktop(action?: "status" | "start" | "take" | "release" | "stop" | "text" | "select", text?: string): Promise<import("./components/ComputerPreview").DesktopState>;
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
