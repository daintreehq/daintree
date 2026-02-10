import type { DevServerError } from "../../utils/devServerErrors.js";

export type DevPreviewSessionStatus = "stopped" | "starting" | "installing" | "running" | "error";

export interface DevPreviewEnsureRequest {
  panelId: string;
  projectId: string;
  cwd: string;
  devCommand: string;
  worktreeId?: string;
  env?: Record<string, string>;
}

export interface DevPreviewSessionRequest {
  panelId: string;
  projectId: string;
}

export interface DevPreviewSessionState {
  panelId: string;
  projectId: string;
  worktreeId?: string;
  status: DevPreviewSessionStatus;
  url: string | null;
  error: DevServerError | null;
  terminalId: string | null;
  isRestarting: boolean;
  generation: number;
  updatedAt: number;
}

export interface DevPreviewStateChangedPayload {
  state: DevPreviewSessionState;
}

/** @deprecated Replaced by `dev-preview:state-changed` payload. */
export interface DevPreviewUrlDetectedPayload {
  terminalId: string;
  url: string;
  worktreeId?: string;
}

/** @deprecated Replaced by `dev-preview:state-changed` payload. */
export interface DevPreviewErrorDetectedPayload {
  terminalId: string;
  error: DevServerError;
  worktreeId?: string;
}
