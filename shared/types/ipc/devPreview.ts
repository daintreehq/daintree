export type DevPreviewStatus = "installing" | "starting" | "running" | "error" | "stopped";

export interface DevPreviewStatusPayload {
  panelId: string;
  status: DevPreviewStatus;
  message: string;
  timestamp: number;
  error?: string;
  /** PTY ID for the dev server terminal (empty string in browser-only mode) */
  ptyId: string;
}

export interface DevPreviewUrlPayload {
  panelId: string;
  url: string;
}
