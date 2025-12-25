export type DevPreviewStatus = "installing" | "starting" | "running" | "error" | "stopped";

export interface DevPreviewStatusPayload {
  panelId: string;
  status: DevPreviewStatus;
  message: string;
  timestamp: number;
  error?: string;
}

export interface DevPreviewUrlPayload {
  panelId: string;
  url: string;
}
