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
    __DAINTREE_E2E_FAULT__?: { renderError?: boolean };
    __DAINTREE_E2E_ERROR_STORE__?: () => Array<{
      id: string;
      source?: string;
      message: string;
      fromPreviousSession?: boolean;
    }>;
    __DAINTREE_E2E_ADD_ERROR__?: (message: string) => void;
    __DAINTREE_E2E_CLEAR_ERRORS__?: () => void;
    __DAINTREE_E2E_IPC__?: {
      getRendererListenerCount: (channel: string) => number;
    };
    __DAINTREE_E2E_MODE__?: boolean;
    __DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS__?: boolean;
  }
}

// Re-export ElectronAPI for consumers that import from this file
export type { ElectronAPI, BranchInfo, CreateWorktreeOptions, TerminalInfoPayload };
