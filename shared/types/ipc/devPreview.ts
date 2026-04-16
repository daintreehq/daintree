import type { DevServerError } from "../../utils/devServerErrors.js";

export type DevPreviewSessionStatus = "stopped" | "starting" | "installing" | "running" | "error";

export interface DevPreviewEnsureRequest {
  panelId: string;
  projectId: string;
  cwd: string;
  devCommand: string;
  worktreeId?: string;
  env?: Record<string, string>;
  turbopackEnabled?: boolean;
}

export interface DevPreviewSessionRequest {
  panelId: string;
  projectId: string;
}

export interface DevPreviewStopByPanelRequest {
  panelId: string;
}

export interface DevPreviewSessionState {
  panelId: string;
  projectId: string;
  worktreeId?: string;
  status: DevPreviewSessionStatus;
  url: string | null;
  assignedUrl: string | null;
  error: DevServerError | null;
  terminalId: string | null;
  isRestarting: boolean;
  generation: number;
  updatedAt: number;
}

export interface DevPreviewStateChangedPayload {
  state: DevPreviewSessionState;
}

export interface DevPreviewGetByWorktreeRequest {
  worktreeId: string;
}
