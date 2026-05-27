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
    __DAINTREE_E2E_IPC__?: {
      getRendererListenerCount: (channel: string) => number;
    };
    __DAINTREE_E2E_MODE__?: boolean;
    __DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS__?: boolean;
    /** Persisted color scheme id seeded by preload for first-paint theming (#9169). */
    __DAINTREE_INITIAL_THEME__?: { colorSchemeId: string };
    __daintreeDispatchAction?: (
      actionId: string,
      args?: unknown,
      options?: { source?: string; confirmed?: boolean }
    ) => unknown;
    /**
     * Per-view query of the renderer ActionService registry. Lets the plugin
     * lifecycle-sync spec (#9285) assert that a revived view has (or no longer
     * has) a plugin-registered action. E2E-gated like __daintreeDispatchAction.
     */
    __daintreeHasAction?: (actionId: string) => boolean;
  }
}

// Re-export ElectronAPI for consumers that import from this file
export type { ElectronAPI, BranchInfo, CreateWorktreeOptions, TerminalInfoPayload };
