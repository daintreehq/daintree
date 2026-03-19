/**
 * Types are imported from the shared types module.
 */

import type {
  ElectronAPI,
  BranchInfo,
  CreateWorktreeOptions,
  TerminalInfoPayload,
} from "@shared/types";

declare global {
  interface Window {
    electron: ElectronAPI;
    __CANOPY_E2E_FAULT__?: { renderError?: boolean };
    __CANOPY_E2E_ERROR_STORE__?: () => Array<{ id: string; source?: string; message: string }>;
  }
}

// Re-export ElectronAPI for consumers that import from this file
export type { ElectronAPI, BranchInfo, CreateWorktreeOptions, TerminalInfoPayload };
