/**
 * Types are imported from the shared types module.
 */

import type {
  ElectronAPI,
  BranchInfo,
  CreateWorktreeOptions,
  TerminalInfoPayload,
} from "@shared/types";
import type { NotificationsE2EApi } from "@/lib/e2eNotificationBackdoor";

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
    __DAINTREE_E2E_WORKTREES__?: () => Array<{
      id: string;
      branch?: string;
      resourceConnectCommand?: string;
    }>;
    __DAINTREE_E2E_REFRESH_GITHUB_CONFIG__?: () => Promise<void>;
    __DAINTREE_E2E_TRIGGER_RECIPE_CONFLICT__?: (recipeName: string) => void;
    /** Per-window store accessors for the multi-window isolation spec (#9599). */
    __DAINTREE_E2E_DIAGNOSTICS_STATE__?: () => { isOpen: boolean };
    __DAINTREE_E2E_OPEN_DIAGNOSTICS__?: () => void;
    __DAINTREE_E2E_PERF_METRICS_STATE__?: () => {
      fps: number | null;
      lafCount30s: number;
      cls30s: number;
    };
    __DAINTREE_E2E_SET_PERF_METRIC__?: (fps: number) => void;
    __DAINTREE_E2E_PERF_MODE_STATE__?: () => { performanceMode: boolean };
    __DAINTREE_E2E_SET_PERF_MODE__?: (enabled: boolean) => void;
    __DAINTREE_E2E_IPC__?: {
      getRendererListenerCount: (channel: string) => number;
    };
    __DAINTREE_E2E_MODE__?: boolean;
    __DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS__?: boolean;
    /** Persisted color scheme id seeded by preload for first-paint theming (#9169). */
    __DAINTREE_INITIAL_THEME__?: { colorSchemeId: string };
    /** Destination project id seeded by preload, replacing the `?projectId=` query string (#9162). */
    __DAINTREE_INITIAL_PROJECT__?: { id: string };
    /** Instance role seeded by preload — worker instances suppress automatic background GitHub polling (#10123). */
    __DAINTREE_INSTANCE_ROLE__?: { role: "attended" | "worker" };
    /** Paint-fabric surface-host role seeded by preload — non-null surfaceId mounts the minimal surface-host root (Phase 1V). */
    __DAINTREE_SURFACE_HOST__?: { surfaceId: string | null };
    __daintreeDispatchAction?: (
      actionId: string,
      args?: unknown,
      options?: { source?: string; confirmed?: boolean }
    ) => unknown;
    __daintreeHybridInputE2E?: {
      setText: (terminalId: string, text: string) => boolean;
      getText: (terminalId: string) => string | null;
      listIds?: () => string[];
    };
    /** E2E-only notification driver, attached by `src/lib/e2eNotificationBackdoor.ts` under DAINTREE_E2E_MODE. */
    __daintreeNotificationsE2E?: NotificationsE2EApi;
  }
}

// Re-export ElectronAPI for consumers that import from this file
export type { ElectronAPI, BranchInfo, CreateWorktreeOptions, TerminalInfoPayload };
