export type DevPreviewStatus = "installing" | "starting" | "running" | "error" | "stopped";

export interface DevPreviewStatusPayload {
  panelId: string;
  sessionId: string;
  status: DevPreviewStatus;
  message: string;
  timestamp: number;
  error?: string;
  /** PTY ID for the dev server terminal (empty string in browser-only mode) */
  ptyId: string;
  worktreeId?: string;
}

export interface DevPreviewUrlPayload {
  panelId: string;
  sessionId: string;
  url: string;
  worktreeId?: string;
}

export interface DevPreviewAttachSnapshot {
  sessionId: string;
  status: DevPreviewStatus;
  message: string;
  url: string | null;
  ptyId: string;
  timestamp: number;
  error?: string;
  worktreeId?: string;
}
