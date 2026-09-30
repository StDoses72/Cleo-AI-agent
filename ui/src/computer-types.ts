/** State shared by the Electron computer broker with Cleo's computer and files panels. */

export type ComputerMode = "browser" | "host";
export type ComputerTarget = "browser" | "desktop";

export interface BrowserTabState {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoom: number;
  crashed: string | null;
  unresponsive: boolean;
  error: { code?: number; description?: string; url?: string } | null;
  dialog: { type: string; message: string; defaultPrompt: string } | null;
  fileChooser: { mode: string } | null;
}

export interface BrowserDownload {
  id: string;
  name: string;
  path: string;
  url: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  received: number;
  total: number;
  tabId: string | null;
}

export interface ComputerState {
  platform: string;
  hostSupported: boolean;
  threads: Record<string, { mode: ComputerMode; hostAuthorized: boolean }>;
  lease: { threadId: string; running: boolean } | null;
  control: Record<ComputerTarget, "agent" | "user">;
  inflight: { threadId: string; target: ComputerTarget; name: string }[];
  authorization: { id: string; threadId: string; reason: string } | null;
  stopping: boolean;
  lastStop: { at: number; source: string; threadId: string | null; released: string[]; cancelledRun: boolean; settled: boolean; hostError: string | null } | null;
  hostEngaged: boolean;
  browserEngaged: boolean;
  browser: {
    tabs: BrowserTabState[];
    activeTabId: string | null;
    size: { width: number; height: number };
    visible: boolean;
    parked: boolean;
    downloads: BrowserDownload[];
    notices: { at: number; tabId: string | null; text: string }[];
    downloadsDir: string;
  };
  stopShortcut: string;
  shortcutActive: boolean;
  shortcutError: string;
  bridgeError: string;
  stopResult?: ComputerState["lastStop"];
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "link";
}

export interface WorkspaceFilePreview {
  path: string;
  size: number;
  modified: number;
  url: string;
  kind: "text" | "markdown" | "html" | "image" | "pdf" | "binary";
  text?: string;
  truncated?: boolean;
}
