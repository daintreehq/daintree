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
    __DAINTREE_E2E_REFRESH_GITHUB_CONFIG__?: () => Promise<void>;
    __DAINTREE_E2E_TRIGGER_RECIPE_CONFLICT__?: (recipeName: string) => void;
    __DAINTREE_E2E_IPC__?: {
      getRendererListenerCount: (channel: string) => number;
    };
    __DAINTREE_E2E_MODE__?: boolean;
    __DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS__?: boolean;
    /** Persisted color scheme id seeded by preload for first-paint theming (#9169). */
    __DAINTREE_INITIAL_THEME__?: { colorSchemeId: string };
    /** Destination project id seeded by preload, replacing the `?projectId=` query string (#9162). */
    __DAINTREE_INITIAL_PROJECT__?: { id: string };
    __daintreeDispatchAction?: (
      actionId: string,
      args?: unknown,
      options?: { source?: string; confirmed?: boolean }
    ) => unknown;
  }
}

// Re-export ElectronAPI for consumers that import from this file
export type { ElectronAPI, BranchInfo, CreateWorktreeOptions, TerminalInfoPayload };
