import type {
  PanelKind,
  PanelLocation,
  TerminalType,
  PanelExitBehavior,
  ViewportPresetId,
} from "./panel.js";
import type { BrowserHistory } from "./browser.js";
import type { AgentState } from "./agent.js";
import type { TerminalSpawnSource } from "./panel.js";

/** Fields shared by all panel creation requests */
export interface AddPanelOptionsBase {
  kind?: PanelKind;
  type?: TerminalType;
  title?: string;
  worktreeId?: string;
  cwd?: string;
  location?: PanelLocation;
  /** If provided, request a stable ID when spawning a new backend process */
  requestedId?: string;
  /** If provided, reconnect to existing backend process instead of spawning */
  existingId?: string;
  /** Opaque state bag for extension panels — survives the save/restore round-trip */
  extensionState?: Record<string, unknown>;
  /**
   * Extension ID of the plugin that registered this panel's kind, if applicable.
   * Preserved across save/restore so the placeholder can name the missing plugin
   * when its registration is gone.
   */
  pluginId?: string;
  /** Origin that spawned this terminal */
  spawnedBy?: TerminalSpawnSource;
  /** Bypass rate limiter during session restore (consumes main-process quota) */
  restore?: boolean;
  /** Bypass panel limit checks (used during hydration/state restoration) */
  bypassLimits?: boolean;
  // --- PTY-related fields (optional on all types, only used by PTY panel kinds) ---
  shell?: string;
  command?: string;
  /** Agent ID when kind is 'agent' */
  agentId?: string;
  agentState?: AgentState;
  lastStateChange?: number;
  /** Store command on instance but don't execute it on spawn */
  skipCommandExecution?: boolean;
  /** Restore input lock state (read-only monitor mode) */
  isInputLocked?: boolean;
  /** Environment variables to set for this terminal */
  env?: Record<string, string>;
  /** Behavior when terminal exits */
  exitBehavior?: PanelExitBehavior;
  /** Captured agent session ID from graceful shutdown (used for session resume) */
  agentSessionId?: string;
  /** Process-level flags captured at launch time, persisted for session resume */
  agentLaunchFlags?: string[];
  /** Model ID selected at launch time for per-panel model selection */
  agentModelId?: string;
  /** Preset ID selected at launch time for per-panel preset selection */
  agentPresetId?: string;
  /** Preset brand color (hex) captured at launch time for per-panel icon tinting */
  agentPresetColor?: string;
  /** Original user-selected preset ID; immutable across fallback hops. */
  originalPresetId?: string;
  /** Whether this panel is currently running on a fallback preset. */
  isUsingFallback?: boolean;
  /** Chain index consumed so far from the primary preset's fallback list. */
  fallbackChainIndex?: number;
}

/** Options for creating a terminal panel */
export interface TerminalPanelOptions extends AddPanelOptionsBase {
  kind?: "terminal";
}

/** Options for creating an agent panel */
export interface AgentPanelOptions extends AddPanelOptionsBase {
  kind: "agent";
  /** Agent ID (e.g., "claude", "gemini") — required for agent panels to prevent bare-shell spawns */
  agentId: string;
  /** Launch command — required for agent panels to prevent bare-shell spawns */
  command: string;
}

/** Options for creating a browser panel */
export interface BrowserPanelOptions extends AddPanelOptionsBase {
  kind: "browser";
  /** Initial URL for the browser pane */
  browserUrl?: string;
  /** Navigation history */
  browserHistory?: BrowserHistory;
  /** Zoom factor */
  browserZoom?: number;
  /** Whether the browser console drawer is open */
  browserConsoleOpen?: boolean;
}

/** Options for creating a dev-preview panel */
export interface DevPreviewPanelOptions extends AddPanelOptionsBase {
  kind: "dev-preview";
  /** Dev server command (e.g., 'npm run dev') */
  devCommand?: string;
  /** Current URL for the preview browser */
  browserUrl?: string;
  /** Navigation history for the preview browser */
  browserHistory?: BrowserHistory;
  /** Zoom factor for the preview browser */
  browserZoom?: number;
  /** Dev server status */
  devServerStatus?: "stopped" | "starting" | "installing" | "running" | "error";
  /** Dev server URL */
  devServerUrl?: string;
  /** Dev server error */
  devServerError?: { type: string; message: string };
  /** Terminal ID associated with dev server */
  devServerTerminalId?: string;
  /** Whether the dev-preview console drawer is open */
  devPreviewConsoleOpen?: boolean;
  /** Active viewport preset for responsive emulation (undefined = fill) */
  viewportPreset?: ViewportPresetId;
}

/**
 * Options for extension-provided panel kinds.
 *
 * NOTE: intentionally excluded from the `AddPanelOptions` union below. Including
 * `kind: string & {}` as a union member defeats discriminated-union narrowing
 * for built-in kinds (any literal string satisfies `string & {}`, so TypeScript
 * silently picks this variant and skips the stricter built-in shapes). Extensions
 * that need to spawn panels with a custom kind should widen via an explicit cast
 * at their integration boundary.
 */
export interface ExtensionPanelOptions extends AddPanelOptionsBase {
  kind: string & {};
}

/** Discriminated union of all built-in panel creation option types */
export type AddPanelOptions =
  | TerminalPanelOptions
  | AgentPanelOptions
  | BrowserPanelOptions
  | DevPreviewPanelOptions;
