import type { AgentId } from "../agent.js";
import type { TerminalState } from "./terminal.js";
import type { TerminalConfig } from "./config.js";
import type { ActionFrecencyEntry, ActionUsageEntry } from "../actions.js";

export type { ActionFrecencyEntry, ActionUsageEntry };

/** Saved recipe terminal */
export interface SavedRecipeTerminal {
  /** Terminal type */
  type: AgentId | "terminal";
  /** Optional title */
  title?: string;
  /** Optional command */
  command?: string;
  /** Optional environment variables */
  env?: Record<string, string>;
  /** Optional initial prompt for agent terminals */
  initialPrompt?: string;
}

/** Saved terminal recipe */
export interface SavedRecipe {
  /** Recipe ID */
  id: string;
  /** Recipe name */
  name: string;
  /** Associated worktree ID */
  worktreeId?: string;
  /** Terminal definitions */
  terminals: SavedRecipeTerminal[];
  /** Creation timestamp */
  createdAt: number;
  /** Whether this recipe should appear in the empty state as a primary launcher */
  showInEmptyState?: boolean;
  /** Timestamp of last run (milliseconds since epoch) */
  lastUsedAt?: number;
}

/** Application state for persistence */
export interface AppState {
  /** Active terminal states */
  terminals: TerminalState[];
  /** Currently active worktree ID */
  activeWorktreeId?: string;
  /** Width of the sidebar in pixels */
  sidebarWidth: number;
  /**
   * Whether focus mode is active (panels collapsed for max terminal space)
   * @deprecated Focus mode is now stored per-project in ProjectState. This field is kept for migration only.
   */
  focusMode?: boolean;
  /**
   * Saved panel state before entering focus mode (for restoration)
   * @deprecated Focus panel state is now stored per-project in ProjectState. This field is kept for migration only.
   */
  focusPanelState?: {
    sidebarWidth: number;
    diagnosticsOpen: boolean;
  };
  /** Height of the diagnostics dock in pixels */
  diagnosticsHeight?: number;
  /** Height of the docked terminal popover in pixels */
  dockedPopoverHeight?: number;
  /** @deprecated Recipes are now stored per-project via project:get-recipes IPC. This field is kept for migration only. */
  recipes?: SavedRecipe[];
  /** Whether the user has seen the welcome screen */
  hasSeenWelcome?: boolean;
  /** Developer mode settings */
  developerMode?: {
    /** Master toggle for all debug features */
    enabled: boolean;
    /** Show state debug overlays in terminal headers */
    showStateDebug: boolean;
    /** Auto-open diagnostics dock on app startup */
    autoOpenDiagnostics: boolean;
    /** Focus events tab when diagnostics opens (requires autoOpenDiagnostics) */
    focusEventsTab: boolean;
  };
  /** Panel grid layout configuration */
  panelGridConfig?: import("../config.js").PanelGridConfig;
  /** Most-recently-used ordered list of quick-switcher item IDs ("terminal:<id>" | "worktree:<id>") */
  mruList?: string[];
  /** Per-action rolling 7-day usage entries for the command palette. Legacy frecency ({score}) and string[] shapes are still accepted on read and migrated. */
  actionMruList?: ActionUsageEntry[] | ActionFrecencyEntry[] | string[];
  /** Action IDs pinned to the "Favorites" rail of the empty-query action palette. */
  actionPinnedIds?: string[];
  /** Action IDs the user has hidden from the "Recently used" rail of the action palette. */
  actionHiddenIds?: string[];
  /** Whether Fleet scope primitive is active ("scoped") or feature is disabled ("legacy", default) */
  fleetScopeMode?: "legacy" | "scoped";
}

/**
 * Build/runtime version info for the renderer — sourced from `app.getVersion()`
 * plus `process.versions` + `os.*` in the main process. Used by the "Report on
 * GitHub" affordance in the notification inbox so issue bodies carry the
 * environment lines reviewers need to triage without a follow-up round trip.
 */
export interface AppVersionInfo {
  appVersion: string;
  electron: string;
  chrome: string;
  os: string;
  /** Human-readable running architecture (e.g. "Apple Silicon", "Intel (Rosetta)", "x64"). */
  arch?: string;
}

/**
 * Why hardware acceleration is disabled: "crash" is the automatic fallback
 * after repeated GPU crashes; "user" is the Settings > Troubleshooting toggle.
 * Legacy timestamp-only flag files (written before reason tracking) report
 * "crash" so the version-change auto-retry can recover them.
 */
export type GpuDisabledReason = "crash" | "user";

/** Describes how the settings store recovered from corruption at startup */
export type SettingsRecovery =
  | { kind: "restored-from-backup"; quarantinedPath?: string }
  | { kind: "reset-to-defaults"; quarantinedPath?: string };

/**
 * Describes how the SQLite database recovered from corruption at startup.
 * `quarantinedPath` is absent when the corrupt file could not be preserved.
 */
export type DatabaseRecovery =
  | { kind: "restored-from-backup"; quarantinedPath?: string }
  | { kind: "reset-to-fresh"; quarantinedPath?: string };

/** Describes a per-project state file that was quarantined due to corruption */
export interface ProjectStateRecovery {
  quarantinedPath: string;
}

/** Describes a crash-loop state file that was quarantined due to corruption */
export interface CrashLoopStateRecovery {
  quarantinedPath: string;
}

/**
 * Combined cold-start payload — collapses the three independent IPC round-trips
 * the renderer used to fire on mount (`crash-recovery:get-pending`,
 * `crash-recovery:get-config`, `app:hydrate`) into one. The `terminalConfig`
 * already present in `HydrateResult` also obsoletes the separate
 * `terminal-config:get` invoked by `usePanelStoreBootstrap`.
 */
export interface BootResult extends HydrateResult {
  /** Pending crash recovery state, or null when there is no crash to recover from. */
  crashPending: import("./crashRecovery.js").PendingCrash | null;
  /** Live crash recovery configuration (auto-restore toggle, thresholds). */
  crashConfig: import("./crashRecovery.js").CrashRecoveryConfig;
  /**
   * Persisted app theme config folded into the boot payload so the renderer
   * seeds custom schemes, accent override, and color-vision mode without a
   * post-mount `app-theme:get` round-trip. Undefined when the stored config
   * still needs first-run defaulting or legacy customSchemes migration — the
   * renderer falls back to the live IPC call, which performs both.
   */
  appTheme?: import("../appTheme.js").AppThemeConfig;
}

/** Result from app hydration */
export interface HydrateResult {
  appState: AppState;
  terminalConfig: TerminalConfig;
  project: import("../project.js").Project | null;
  agentSettings: import("../agentSettings.js").AgentSettings;
  gpuWebGLHardware: boolean;
  gpuHardwareAccelerationDisabled: boolean;
  /**
   * Why hardware acceleration is disabled, or null when it is enabled. Lets
   * the renderer suppress the "disabled after repeated GPU crashes" boot
   * notification when the user disabled acceleration deliberately.
   */
  gpuDisabledReason: GpuDisabledReason | null;
  /**
   * True when the app is running with ANGLE/Vulkan fallback rendering after a
   * prior GPU crash (the `gpu-angle-fallback.flag` file exists in userData).
   * Surfaced so the renderer can show a Tier 2 inline warning explaining the
   * degraded backend; re-enabling hardware acceleration clears the flag.
   */
  gpuAngleFallbackActive: boolean;
  safeMode: boolean;
  /**
   * True when running inside an MSIX/AppX (Microsoft Store) container, where
   * update delivery is owned by the OS. Mirrors `process.windowsStore` from
   * the main process and is `false` for NSIS installs and non-Windows builds.
   */
  isWindowsStore: boolean;
  /**
   * True when this is an x64 build translated by Rosetta on an Apple Silicon
   * Mac. Darwin-only by construction — the equivalent Windows-ARM translation
   * is deliberately excluded so the renderer's "download the Apple Silicon
   * build" warning never shows on Windows. Optional for backward compat with
   * older main processes.
   */
  runningUnderRosetta?: boolean;
  /** True when the user permanently dismissed the Rosetta translation warning. */
  rosettaWarningDismissed?: boolean;
  /** Number of saved panels skipped due to safe-mode boot (0 when safe mode is inactive). */
  skippedPanelCount?: number;
  /**
   * Per-panel quarantine entries surfaced when safe mode is active. Each entry
   * is a panel the suspect ledger has flagged on enough consecutive crashed
   * boots to cross the quarantine threshold; those panels are skipped from
   * restore while the rest of the saved session is preserved. Empty array (or
   * absent) when no panels are quarantined.
   */
  quarantinedPanels?: import("./crashRecovery.js").QuarantinedPanelSummary[];
  /** Consecutive recent unclean launches counted by the crash-loop guard. */
  crashCount?: number;
  /** Timestamp (ms since epoch) of the most recent unclean launch prior to this boot. */
  lastCrashAt?: number;
  settingsRecovery?: SettingsRecovery | null;
  projectStateRecovery?: ProjectStateRecovery | null;
  /**
   * Populated for the first hydrate after a boot where the SQLite database was
   * found corrupt and either restored from its backup or recreated empty.
   * One-shot: `DatabaseMaintenanceService.consumeRecovery()` clears it.
   */
  databaseRecovery?: DatabaseRecovery | null;
  /**
   * Populated only when the crash-loop state file was corrupt AND the boot
   * also tripped safe mode — the renderer banner gates on `safeMode === true`
   * to avoid surfacing a silent reset that didn't affect the user. Silent
   * corruption with no safe-mode trip is log-only.
   */
  crashLoopStateRecovery?: CrashLoopStateRecovery | null;
  /**
   * System temp directory (`os.tmpdir()`), folded into the batched boot payload
   * so the renderer can derive the clipboard directory without a standalone
   * `system:get-tmp-dir` IPC round-trip on the panel-restore critical path.
   * Optional for backward compatibility: when absent (older main process, or the
   * React 19 `use()` safe-boot fallback), the renderer falls back to the IPC call.
   */
  systemTmpDir?: string;
  /**
   * Per-project layout state folded into the hydrate payload so the renderer
   * skips the standalone `getTabGroups`/`getTerminalSizes`/`getDraftInputs`
   * round-trips on the panel-restore critical path. Populated (with the same
   * null-state defaults as the standalone handlers) whenever a project is
   * resolved; undefined on the no-project fallback branch and older payloads,
   * where the renderer falls back to the standalone IPC calls.
   */
  tabGroups?: import("../panel.js").TabGroup[];
  terminalSizes?: Record<string, { cols: number; rows: number }>;
  draftInputs?: Record<string, string>;
  /**
   * In-repo agent presets (`.daintree/presets/`) folded into the hydrate
   * payload so the renderer skips the standalone `project:get-inrepo-presets`
   * round-trip + repo disk read on the panel-restore critical path. Populated
   * whenever a project is resolved; undefined on the no-project fallback
   * branch and older payloads, where the renderer falls back to the
   * standalone IPC call.
   */
  projectPresets?: Record<string, import("../../config/agentRegistry.js").AgentPreset[]>;
  /**
   * Full project list folded into the hydrate payload so the Toolbar's mount
   * effect skips its `project:get-all` + `project:get-current` round-trips
   * during the boot window. Optional for backward compatibility: when absent
   * (older main process, or the safe-boot fallback), the renderer falls back
   * to the standalone IPC calls.
   */
  projects?: import("../project.js").Project[];
  /**
   * Persisted keybinding overrides folded into the hydrate payload so the
   * hydration bootstrap skips the standalone `keybinding:get-overrides`
   * round-trip. Same validation as the standalone handler. Undefined on older
   * payloads and the safe-boot fallback, where the renderer falls back to IPC.
   */
  keybindingOverrides?: Record<string, string[]>;
  /**
   * Sanitized user-agent registry folded into the hydrate payload so the
   * hydration bootstrap skips the standalone `user-agent-registry:get`
   * round-trip. Same sanitization as the standalone handler. Undefined on
   * older payloads and the safe-boot fallback, where the renderer falls back
   * to IPC.
   */
  userAgentRegistry?: import("../userAgentRegistry.js").UserAgentRegistry;
}
