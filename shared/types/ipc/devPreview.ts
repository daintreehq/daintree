import type { DevServerError } from "../../utils/devServerErrors.js";

export interface DevPreviewUrlDetectedPayload {
  terminalId: string;
  url: string;
  worktreeId?: string;
}

export interface DevPreviewErrorDetectedPayload {
  terminalId: string;
  error: DevServerError;
  worktreeId?: string;
}
