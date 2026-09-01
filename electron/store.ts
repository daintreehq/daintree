// eager-import-allow: reads/writes the electron-store JSON file via sync fs (it is the synchronous store itself)
import Store from "electron-store";
import fs from "fs";
import path from "path";
import type {
  AgentSettings,
  PanelGridConfig,
  PanelKind,
  UserAgentRegistry,
  AgentUpdateSettings,
  AppAgentConfig,
} from "../shared/types/index.js";
import type { PendingUpdateInstallStage } from "./utils/updateInstallStages.js";
import type { IssueAssociation } from "../shared/types/ipc/worktree.js";
import type { InstalledPluginRecord } from "../shared/types/plugin.js";
import type { ErrorRecord } from "../shared/types/ipc/errors.js";
import type {
  AssistantTurnRecord,
  McpAuditRecord,
  McpLogRecord,
} from "../shared/types/ipc/mcpServer.js";
import { MCP_AUDIT_DEFAULT_MAX_RECORDS } from "../shared/types/ipc/mcpServer.js";
import type { PluginActionAuditRecord } from "../shared/types/ipc/pluginAudit.js";
import { PLUGIN_AUDIT_DEFAULT_MAX_RECORDS } from "../shared/types/ipc/pluginAudit.js";
import type { PluginMcpAuditRecord } from "../shared/types/ipc/pluginMcpAudit.js";
import { PLUGIN_MCP_AUDIT_DEFAULT_MAX_RECORDS } from "../shared/types/ipc/pluginMcpAudit.js";
import type { PluginMcpConsentRecord } from "../shared/types/pluginMcpConsent.js";
import type { PluginCapabilityConsentRecord } from "../shared/types/pluginCapabilityConsent.js";
import type { ProjectPluginTrustRecord } from "../shared/types/plugin.js";
import { PLUGIN_MCP_DEFAULT_MAX_TOOLS_PER_SESSION } from "../shared/types/ipc/pluginMcp.js";
import type { ForgeAuditRecord } from "../shared/types/ipc/forge.js";
import type { RunParkRecord, RunSnoozeRecord } from "../shared/types/ipc/fleet.js";
import type { RunHistoryRecord } from "../shared/types/ipc/runHistory.js";
import type { SuggestedDictionaryEntry } from "../shared/types/ipc/api.js";
import { FORGE_AUDIT_DEFAULT_MAX_RECORDS } from "../shared/types/ipc/forge.js";
import type { BuiltInAgentId } from "../shared/config/agentIds.js";
import type { AgentId } from "../shared/types/agent.js";
import { DEFAULT_AGENT_SETTINGS, DEFAULT_APP_AGENT_CONFIG } from "../shared/types/index.js";
import type { AppThemeConfig } from "../shared/types/appTheme.js";
import type {
  SettingsRecovery,
  ActionFrecencyEntry,
  ActionUsageEntry,
} from "../shared/types/ipc/app.js";
import type { HelpAssistantTier } from "../shared/types/ipc/maps.js";

interface WindowStateEntry {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
  isFullScreen?: boolean;
}

interface WindowStatesStoreSchema {
  windowStates: Record<string, WindowStateEntry>;
}

interface AuditLogsStoreSchema {
  mcpAuditLog: McpLogRecord[];
  mcpTurnOutcomeLog: AssistantTurnRecord[];
  pluginAuditLog: PluginActionAuditRecord[];
  forgeAuditLog: ForgeAuditRecord[];
  runHistoryRecords: RunHistoryRecord[];
  pluginMcpAuditLog: PluginMcpAuditRecord[];
}

export interface StoreSchema {
  _schemaVersion: number;
  windowState: {
    x?: number;
    y?: number;
    width: number;
    height: number;
    isMaximized: boolean;
    isFullScreen?: boolean;
  };
  terminalConfig: {
    scrollbackLines: number; // 100-10000 (user-configurable)
    performanceMode: boolean;
    hybridInputEnabled?: boolean;
    hybridInputAutoFocus?: boolean;
    screenReaderMode?: "auto" | "on" | "off";
    resourceMonitoringEnabled?: boolean;
    memoryLeakDetectionEnabled?: boolean;
    memoryLeakAutoRestartThresholdMb?: number;
    cachedProjectViews?: number;
  };
  hibernation: {
    enabled: boolean;
    inactiveThresholdHours: number;
  };
  idleTerminalNotify: {
    enabled: boolean;
    thresholdMinutes: number;
  };
  idleTerminalDismissals: Record<string, number>;
  idleTerminalNotifiedAt: Record<string, number>;
  /**
   * Park records keyed by terminal id (`RunAttentionService` is the sole
   * reader/writer). Terminal ids survive app restart — panels rehydrate and
   * respawn under the same ids — so a park set before quitting still holds
   * after relaunch. Records for ids that never come back are pruned by age.
   */
  parkedRuns: Record<string, RunParkRecord>;
  /**
   * Snooze records keyed by terminal id (`RunAttentionService` is the sole
   * reader/writer). Separate from {@link parkedRuns} because the two are
   * written on very different cadences — a snooze is cleared by any typed
   * input — and one blob would rewrite the park set on every keystroke that
   * lands on a snoozed run. Expired records are pruned at load.
   */
  snoozedRuns: Record<string, RunSnoozeRecord>;
  idleBackgroundAutoClose: {
    enabled: boolean;
    thresholdMinutes: number;
  };
  pluginBackgroundUpdateCheck: {
    enabled: boolean;
    /** Wall-clock ms of the last completed pass; null until the first runs. */
    lastCheckedAt: number | null;
  };
  appState: {
    activeWorktreeId?: string;
    sidebarWidth: number;
    focusMode?: boolean;
    focusPanelState?: {
      sidebarWidth: number;
      diagnosticsOpen: boolean;
    };
    diagnosticsHeight?: number;
    dockedPopoverHeight?: number;
    hasSeenWelcome?: boolean;
    developerMode?: {
      enabled: boolean;
      showStateDebug: boolean;
      autoOpenDiagnostics: boolean;
      focusEventsTab: boolean;
      /**
       * Persist raw (redacted) plugin-action args alongside the SHA-256 hash
       * in the plugin audit log. Off by default — the audit log stores only
       * the hash for privacy. Opt-in for plugin authors debugging dispatch.
       */
      pluginAuditPlaintext?: boolean;
    };
    terminals: Array<{
      id: string;
      kind?: PanelKind;
      launchAgentId?: AgentId;
      title: string;
      titleMode?: "default" | "custom" | "user";
      cwd?: string;
      worktreeId?: string;
      location: "grid" | "dock";
      command?: string;
      settings?: {
        autoRestart?: boolean;
      };
      isInputLocked?: boolean;
      browserUrl?: string;
      devCommand?: string;
      browserConsoleOpen?: boolean;
      devPreviewConsoleOpen?: boolean;
      agentState?: string;
      lastStateChange?: number;
    }>;
    /** @deprecated Recipes are now stored per-project. This field is kept for migration only. */
    recipes?: Array<{
      id: string;
      name: string;
      worktreeId?: string;
      terminals: Array<{
        launchAgentId?: BuiltInAgentId;
        title?: string;
        command?: string;
        env?: Record<string, string>;
      }>;
      createdAt: number;
      showInEmptyState?: boolean;
      lastUsedAt?: number;
    }>;
    panelGridConfig?: PanelGridConfig;
    mruList?: string[];
    actionMruList?: ActionUsageEntry[] | ActionFrecencyEntry[] | string[];
    actionPinnedIds?: string[];
    actionHiddenIds?: string[];
    fleetScopeMode?: "legacy" | "scoped";
  };
  /**
   * Workspace that owns the legacy pre-multi-project fields of `appState`
   * (`terminals`, `activeWorktreeId`, `focusMode`, `focusPanelState`,
   * `mruList`). Those fields belong to whichever project was open before
   * per-workspace state existed, but carry no owner identity of their own, so
   * every project row without saved terminals used to re-inherit them —
   * handing a brand-new project another project's panels and `cwd`s (#11651).
   * The first real project to hydrate stamps its id here and becomes the sole
   * heir; every later row reads its own state or clean defaults.
   *
   * Deliberately top-level rather than a field of `appState`:
   * `CrashRecoveryService.applySessionSnapshot` replaces `appState` wholesale
   * from a captured snapshot, which would roll an inner marker back to
   * unclaimed. Also keeps the marker out of the hydrate IPC payload — it is
   * main-process migration bookkeeping, not renderer state.
   */
  legacyWorkspaceStateOwnerId?: string;
  userConfig: {
    githubToken?: string;
  };
  worktreeConfig: {
    pathPattern: string;
  };
  agentSettings: AgentSettings;
  notificationSettings: {
    enabled: boolean;
    completedEnabled: boolean;
    waitingEnabled: boolean;
    soundEnabled: boolean;
    completedSoundFile: string;
    waitingSoundFile: string;
    escalationSoundFile: string;
    waitingEscalationEnabled: boolean;
    waitingEscalationDelayMs: number;
    workingPulseEnabled: boolean;
    workingPulseSoundFile: string;
    uiFeedbackSoundEnabled: boolean;
    quietHoursEnabled: boolean;
    quietHoursStartMin: number;
    quietHoursEndMin: number;
    quietHoursWeekdays: number[];
    groupByContext?: boolean;
  };
  userAgentRegistry: UserAgentRegistry;
  agentUpdateSettings: AgentUpdateSettings;
  keybindingOverrides: {
    overrides: Record<string, string[]>;
  };
  projectEnv: Record<string, string>;
  globalEnvironmentVariables: Record<string, string>;
  appAgentConfig: AppAgentConfig;
  windowStates: Record<
    string,
    {
      x?: number;
      y?: number;
      width: number;
      height: number;
      isMaximized: boolean;
      isFullScreen?: boolean;
    }
  >;
  worktreeIssueMap: Record<string, IssueAssociation>;
  /**
   * Per-worktree WSL git routing state. Key is the worktree id (UNC path on
   * Windows). `enabled` opts into routing git through `wsl.exe git`; `dismissed`
   * hides the suggestion banner without enabling. Only meaningful on Windows.
   */
  wslGitByWorktree: Record<string, { enabled: boolean; dismissed: boolean }>;
  /**
   * Permanent dismissal of the Rosetta translation warning banner. Machine-level
   * (the installed binary's architecture never changes via auto-update), so a
   * single global flag rather than per-project state.
   */
  rosettaWarningDismissed: boolean;
  appTheme: Partial<AppThemeConfig>;
  privacy: {
    telemetryLevel: "off" | "errors" | "full";
    hasSeenPrompt: boolean;
    logRetentionDays: 7 | 30 | 90 | 0;
  };
  /**
   * Agent resume journal (`agent-session-history.json`) settings. Kept as its
   * own slice rather than folded into `privacy` — it governs a distinct record
   * type (resumable agent sessions), not telemetry/log retention.
   */
  agentSessionHistory: {
    /** Retention window in days; `0` = keep forever. */
    retentionDays: 7 | 30 | 90 | 0;
  };
  voiceInput: {
    enabled: boolean;
    openaiApiKey: string;
    deepgramApiKey: string;
    language: string;
    customDictionary: string[];
    transcriptionProvider: string;
    transcriptionModel: string;
    correctionEnabled: boolean;
    correctionModel: string;
    correctionCustomInstructions: string;
    paragraphingStrategy: string;
    resolveFileLinks: boolean;
    deviceId: string;
    organizationId: string;
    projectId: string;
    recordingMode: string;
    suggestedDictionary: SuggestedDictionaryEntry[];
    learnFromCorrections: boolean;
  };
  mcpServer: {
    enabled: boolean;
    port: number | null;
    apiKey: string;
    auditEnabled: boolean;
    auditMaxRecords: number;
    /** @deprecated Moved to the audit-logs store by migration022. Read-only carryover. */
    auditLog?: McpAuditRecord[];
    /** @deprecated Moved to the audit-logs store by migration022. Read-only carryover. */
    turnOutcomeLog?: AssistantTurnRecord[];
    abusePolicyEnabled: boolean;
    abusePolicyMaxDenials: number;
    abusePolicyWindowMs: number;
  };
  /**
   * Help-assistant settings. Includes audit/permission configuration plus
   * help-session provisioning options. Fields in the provisioning subset are
   * optional to remain forward-compatible with the dedicated settings UI
   * landing in #6517 / #6522 — the service falls back to safe defaults
   * when keys are absent.
   */
  helpAssistant: {
    docSearch: boolean;
    daintreeControl: boolean;
    /**
     * MCP capability tier for the help assistant. Migrated at read time from
     * the legacy `skipPermissions` boolean — see `helpAssistant.ts`
     * `sanitizeStored` and `HelpSessionService.readSettings`.
     */
    tier: HelpAssistantTier;
    /**
     * Bypass Claude Code's per-tool confirmation prompt for help sessions.
     * Migrated at read time from the legacy `skipPermissions` boolean.
     */
    bypassPermissions: boolean;
    /**
     * Legacy field — kept in the schema for backward compatibility so old
     * stored values round-trip through the read-time migration without being
     * stripped by the typed accessor. New writes use `tier` and
     * `bypassPermissions`; this field is no longer written to.
     */
    skipPermissions?: boolean;
    auditRetention: 7 | 30 | 0;
  };
  pendingErrors: ErrorRecord[];
  errorFingerprints: Record<string, { count: number; firstSeen: number; lastSeen: number }>;
  gpu: {
    hardwareAccelerationDisabled: boolean;
  };
  crashRecovery: {
    autoRestoreOnCrash: boolean;
  };
  onboarding: {
    schemaVersion: number;
    completed: boolean;
    currentStep: string | null;
    agentSetupIds: string[];
    firstRunToastSeen: boolean;
    newsletterPromptSeen: boolean;
    waitingNudgeSeen: boolean;
    seenAgentIds: string[];
    availabilityFirstSeen: Record<string, number>;
    welcomeCardDismissed: boolean;
    setupBannerDismissed: boolean;
    checklist: {
      dismissed: boolean;
      celebrationShown: boolean;
      items: {
        openedProject: boolean;
        launchedAgent: boolean;
        createdWorktree: boolean;
        ranSecondParallelAgent: boolean;
      };
    };
  };
  orchestrationMilestones: Record<string, boolean>;
  shortcutHintCounts: Record<string, number>;
  /**
   * One-shot hover-hint keys (`actionId@count`) already shown to the user.
   * Persisted so keyboard-shortcut teaching tooltips don't reappear every
   * session. Bounded by `|actionIds| × |HINT_MILESTONES|`.
   */
  shortcutHintHoveredKeys?: string[];
  /**
   * Project paths for which the "enable forge plugin" recommendation has
   * already fired or been dismissed. Persisted so the nudge doesn't reappear
   * on every launch. Bounded by the number of distinct projects opened.
   */
  forgeEnableDismissedPaths?: Record<string, true>;
  updateChannel: "stable" | "nightly";
  dismissedUpdateVersion?: string;
  dismissedUpdateAt?: number;
  lastUpdateCheck?: number | null;
  /**
   * Persisted between `update-downloaded` and the next boot so we can detect
   * silent install failures (e.g. macOS ShipIt aborting without surfacing an
   * error, NSIS empty-directory races on Windows). Read-and-deleted on boot
   * before any await; if the stored version doesn't match `app.getVersion()`
   * the mismatch is reported via `trackEvent`. Absent means "no install
   * pending" — no migration entry required (mirrors `dismissedUpdateVersion`).
   */
  pendingUpdateVersion?: string;
  /**
   * How far the last install attempt got, written before the process hands off
   * to the installer and read alongside `pendingUpdateVersion` on the next boot.
   * Its presence is what separates "an install was tried and the version still
   * didn't move" from "a staged update simply never got installed" — an app
   * killed before `autoInstallOnAppQuit` runs leaves the version marker behind
   * too, and there the staged installer is still perfectly good. Only a stored
   * attempt promotes the boot-time mismatch from telemetry to a user-facing
   * recovery prompt.
   *
   * A closed enum, never a raw error string: electron-updater and Squirrel
   * embed absolute cache paths in their messages, which would persist the
   * user's home directory into the config file. Absent means "no install
   * attempted" — no migration entry required (mirrors `dismissedUpdateVersion`).
   */
  pendingUpdateInstallStage?: PendingUpdateInstallStage;
  /**
   * Windows Store notifier state. All fields are optional and read with `??`
   * fallbacks at the call site so an absent value behaves like a default —
   * no migration entry required (mirrors `dismissedUpdateVersion` pattern).
   */
  storeUpdateNotificationsEnabled?: boolean;
  lastNotifiedStoreVersion?: string;
  storeNotifierEtag?: string;
  /**
   * Per-logger level overrides keyed by stable `"<process>:Module"` names (or
   * `"*"` / `"<process>:*"` wildcards). Values are `"debug" | "info" | "warn"
   * | "error" | "off"`. Persisted so support sessions can reproduce boot-time
   * issues without reconfiguring on every launch.
   */
  logLevelOverrides: Record<string, string>;
  /**
   * Plugin runtime state. `disabled` lists plugin ids (manifest.name) the user
   * has disabled from Preferences — covering both built-in and user-installed
   * plugins. PluginService filters these out at startup; disabling takes effect
   * on next launch (built-ins additionally cannot be uninstalled, only
   * disabled). `disabledBuiltins` is the legacy built-ins-only field; kept as
   * an optional `@deprecated` key so `clearInvalidConfig` doesn't strip a
   * persisted value before migration021 merges it into `disabled` (the merge
   * runs after `new Store()`). New code reads `disabled`.
   */
  plugins: {
    disabled: string[];
    /** @deprecated Merged into `disabled` by migration021 (#9284). Read-only carryover. */
    disabledBuiltins?: string[];
    /** Master switch for the plugin-action audit log. Defaults to true. */
    auditEnabled: boolean;
    /** Ring-buffer cap for persisted plugin-action audit records. */
    auditMaxRecords: number;
    /** @deprecated Moved to the audit-logs store by migration023. Read-only carryover. */
    auditLog?: PluginActionAuditRecord[];
    installed: Record<string, InstalledPluginRecord>;
  };
  /**
   * Global default forge provider id for newly opened projects. `null` (or
   * absent) means "no global default — fall back to hostname auto-match"
   * per the forge resolver contract. Read with `?? null` fallback — no
   * migration entry required (mirrors `dismissedUpdateVersion` pattern).
   */
  forgeDefaultProviderId?: string | null;
  /**
   * Per-provider credential records, keyed by the canonical
   * `{pluginId}.{contributionId}` forge provider id. Each value is a
   * `JSON.stringify`-serialized `Record<string, string>` of the provider's
   * declared credential fields. Stored as a single flat top-level object —
   * never written via electron-store dot-notation paths, since provider ids
   * themselves contain dots and would silently nest. Absent means "no
   * provider credentials saved" (read with `?? {}`). Plain text, same
   * security model as `forgeDefaultProviderId` / the GitHub token (~/.gitconfig
   * equivalent) — deliberately not encrypted.
   */
  forgeCredentials?: Record<string, string>;
  /**
   * Audit ring buffer for `ForgeProviderImpl` method calls. Parallel to
   * `mcpServer.auditLog` but scoped to host-side forge invocations — slow
   * providers, credential failures, and malformed responses leave a trail
   * here. `auditLog` is the persisted ring (trimmed to `auditMaxRecords`);
   * `auditEnabled` is the kill switch. Read defensively (`?? {}` defaults
   * applied by electron-store) — the on-disk shape is owned by
   * `ForgeAuditService`.
   */
  forgeAudit: {
    auditEnabled: boolean;
    auditMaxRecords: number;
    /** @deprecated Moved to the audit-logs store by migration023. Read-only carryover. */
    auditLog?: ForgeAuditRecord[];
  };
  /**
   * Durable run-history ring buffer for recipe and fleet automation outcomes
   * (#9949). `records` is the persisted oldest-first ring, trimmed to
   * {@link RUN_HISTORY_DEFAULT_MAX_RECORDS} by `RunHistoryLog`. Lives in the
   * Main-process store (not renderer localStorage) so it survives reloads and
   * the multi-window LRU eviction. Read defensively (`?? {}` applied by
   * electron-store) — the on-disk shape is owned by `RunHistoryLog`.
   */
  runHistory: {
    /** @deprecated Moved to the audit-logs store by migration023. Read-only carryover. */
    records?: RunHistoryRecord[];
  };
  /**
   * Inbound plugin-MCP `tools/call` audit ring buffer (#9234). Parallel to
   * `plugins.auditLog` but scoped to *inbound* MCP tool calls — i.e. calls a
   * plugin's stdio MCP server makes back into the host. Records never store
   * raw args, raw tool descriptions, or raw input schemas; only SHA-256 hex
   * digests. `auditLog` is the persisted ring (trimmed to `auditMaxRecords`);
   * `auditEnabled` is the kill switch.
   */
  pluginMcpAudit: {
    auditEnabled: boolean;
    auditMaxRecords: number;
    /** @deprecated Moved to the audit-logs store by migration023. Read-only carryover. */
    auditLog?: PluginMcpAuditRecord[];
  };
  /**
   * Trust-on-first-use (TOFU) consent pins for plugin-MCP tool descriptions
   * and schemas (#9234). Re-prompting is gated on the raw-bytes hash so a
   * rug-pull payload hidden in invisible Unicode flips the pin even when the
   * displayed text looks identical.
   */
  pluginMcpConsent: {
    pins?: PluginMcpConsentRecord[];
    revoked?: string[];
  };
  /**
   * Advanced plugin-MCP tuning (#9235). `maxToolsPerSession` is the hard cap on
   * the number of tools surfaced into agent context across ALL supervised
   * servers per session — lazy tier-1 enumeration clips to this so a chatty
   * server can't flood the agent's tool budget. Additive key; absence falls
   * back to {@link PLUGIN_MCP_DEFAULT_MAX_TOOLS_PER_SESSION}.
   */
  pluginMcpConfig: {
    maxToolsPerSession: number;
  };
  /**
   * Just-in-time (JIT) consent grants for plugin host capabilities (#10524).
   * Each grant is a `(scopeKey, pluginId, capability)` triple the user approved
   * on first use of a high-risk host surface (`shell:exec`, `fs:*-write`,
   * `git:write`), so later calls run without re-prompting. Plaintext, matching
   * the `pluginMcpConsent` precedent — a grant holds no secret, only the triple
   * and a timestamp. Records written before the scope key existed have no
   * `scopeKey` field and hydrate as `"global"`.
   */
  pluginCapabilityConsent: {
    grants?: PluginCapabilityConsentRecord[];
  };
  /**
   * Per-project trust decisions for `<projectRoot>/.daintree/plugins/`, keyed by
   * `projectId`. Deliberately here and never in the repository: a decision that
   * a repository could carry would be a decision the repository makes for you,
   * and the whole gate exists because a project folder is writable by everyone
   * who can push to it — agents included.
   *
   * Absence means no decision, which means disabled: discovery still parses
   * manifests so the UI can say what is there, but nothing runs. An
   * enable-for-this-session choice is held in memory by
   * `ProjectPluginController` and never reaches this key.
   *
   * Additive key with no numbered migration, matching `forgeDefaultProviderId`,
   * `pluginMcpConfig` and `pluginCapabilityConsent` — every read goes through
   * `?? {}` and a missing key is indistinguishable from an empty one.
   */
  projectPluginTrust?: Record<string, ProjectPluginTrustRecord>;
}

const storeOptions = {
  defaults: {
    _schemaVersion: 0,
    windowState: {
      x: undefined,
      y: undefined,
      width: 1200,
      height: 800,
      isMaximized: false,
    },
    terminalConfig: {
      scrollbackLines: 1000,
      performanceMode: false,
      hybridInputEnabled: true,
      hybridInputAutoFocus: true,
      screenReaderMode: "auto" as const,
    },
    hibernation: {
      enabled: false,
      inactiveThresholdHours: 24,
    },
    idleTerminalNotify: {
      enabled: true,
      thresholdMinutes: 60,
    },
    idleTerminalDismissals: {},
    idleTerminalNotifiedAt: {},
    parkedRuns: {},
    snoozedRuns: {},
    // Auto-close defaults OFF: it's a structural change to project lifecycle
    // (frees the renderer + workspace host), so users opt in. 15-min default
    // threshold matches the issue spec.
    idleBackgroundAutoClose: {
      enabled: false,
      thresholdMinutes: 15,
    },
    // Background plugin update checks default OFF (#10893): a periodic network
    // re-fetch of every URL-installed plugin is an opt-in behavior, not a default.
    pluginBackgroundUpdateCheck: {
      enabled: false,
      lastCheckedAt: null,
    },
    appState: {
      sidebarWidth: 350,
      focusMode: false,
      terminals: [],
      recipes: [],
      hasSeenWelcome: false,
      panelGridConfig: { strategy: "automatic" as const, value: 3 },
    },
    userConfig: {},
    worktreeConfig: {
      pathPattern: "{parent-dir}/{base-folder}-worktrees/{branch-slug}",
    },
    agentSettings: DEFAULT_AGENT_SETTINGS,
    notificationSettings: {
      enabled: true,
      completedEnabled: false,
      waitingEnabled: true,
      soundEnabled: true,
      completedSoundFile: "complete.wav",
      waitingSoundFile: "waiting.wav",
      escalationSoundFile: "ping.wav",
      waitingEscalationEnabled: false,
      waitingEscalationDelayMs: 180_000,
      workingPulseEnabled: false,
      workingPulseSoundFile: "pulse.wav",
      uiFeedbackSoundEnabled: false,
      quietHoursEnabled: false,
      quietHoursStartMin: 22 * 60,
      quietHoursEndMin: 8 * 60,
      quietHoursWeekdays: [],
      groupByContext: false,
    },
    userAgentRegistry: {},
    agentUpdateSettings: {
      autoCheck: true,
      checkFrequencyHours: 24,
      lastAutoCheck: null,
    },
    keybindingOverrides: {
      overrides: {},
    },
    projectEnv: {},
    globalEnvironmentVariables: {},
    appAgentConfig: DEFAULT_APP_AGENT_CONFIG,
    windowStates: {},
    worktreeIssueMap: {},
    wslGitByWorktree: {},
    rosettaWarningDismissed: false,
    appTheme: {},
    privacy: {
      telemetryLevel: "off" as const,
      hasSeenPrompt: false,
      logRetentionDays: 30 as const,
    },
    agentSessionHistory: {
      retentionDays: 30 as const,
    },
    voiceInput: {
      enabled: false,
      openaiApiKey: "",
      deepgramApiKey: "",
      language: "en",
      customDictionary: [],
      transcriptionProvider: "openai",
      transcriptionModel: "gpt-live-transcribe",
      correctionEnabled: false,
      correctionModel: "gpt-5.6-luna",
      correctionCustomInstructions: "",
      paragraphingStrategy: "spoken-command",
      resolveFileLinks: true,
      deviceId: "",
      organizationId: "",
      projectId: "",
      recordingMode: "toggle",
      suggestedDictionary: [],
      learnFromCorrections: true,
    },
    mcpServer: {
      enabled: false,
      port: 45454,
      apiKey: "",
      auditEnabled: true,
      auditMaxRecords: MCP_AUDIT_DEFAULT_MAX_RECORDS,
      abusePolicyEnabled: false,
      abusePolicyMaxDenials: 5,
      abusePolicyWindowMs: 60_000,
    },
    helpAssistant: {
      docSearch: true,
      daintreeControl: true,
      tier: "action" as const,
      bypassPermissions: false,
      auditRetention: 7 as const,
    },
    pendingErrors: [],
    errorFingerprints: {},
    gpu: {
      hardwareAccelerationDisabled: false,
    },
    crashRecovery: {
      autoRestoreOnCrash: true,
    },
    onboarding: {
      schemaVersion: 2,
      completed: false,
      currentStep: null,
      agentSetupIds: [],
      firstRunToastSeen: false,
      newsletterPromptSeen: false,
      waitingNudgeSeen: false,
      seenAgentIds: [],
      availabilityFirstSeen: {},
      welcomeCardDismissed: false,
      setupBannerDismissed: false,
      checklist: {
        dismissed: false,
        celebrationShown: false,
        items: {
          openedProject: false,
          launchedAgent: false,
          createdWorktree: false,
          ranSecondParallelAgent: false,
        },
      },
    },
    orchestrationMilestones: {},
    shortcutHintCounts: {},
    shortcutHintHoveredKeys: [],
    forgeEnableDismissedPaths: {},
    updateChannel: "stable" as const,
    lastUpdateCheck: null,
    logLevelOverrides: {},
    plugins: {
      disabled: [],
      auditEnabled: true,
      auditMaxRecords: PLUGIN_AUDIT_DEFAULT_MAX_RECORDS,
      installed: {},
    },
    forgeAudit: {
      auditEnabled: true,
      auditMaxRecords: FORGE_AUDIT_DEFAULT_MAX_RECORDS,
    },
    runHistory: {},
    pluginMcpAudit: {
      auditEnabled: true,
      auditMaxRecords: PLUGIN_MCP_AUDIT_DEFAULT_MAX_RECORDS,
    },
    pluginMcpConsent: {},
    pluginMcpConfig: {
      maxToolsPerSession: PLUGIN_MCP_DEFAULT_MAX_TOOLS_PER_SESSION,
    },
    pluginCapabilityConsent: {},
    projectPluginTrust: {},
  },
  cwd: process.env.DAINTREE_USER_DATA,
};

function getElectronUserDataPath(): string | undefined {
  try {
    // Dynamic require to avoid breaking tests that mock electron
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron");
    return electron.app?.getPath("userData");
  } catch {
    return undefined;
  }
}

function resolveConfigPath(cwd: string | undefined): string | null {
  const dir = cwd ?? getElectronUserDataPath();
  if (!dir) return null;
  return path.join(dir, "config.json");
}

// On the valid path, `rawBuffer` carries the bytes already read here so the
// caller can use them as the pre-construction wipe-detection snapshot instead
// of reading config.json a second time. It is absent only on the fail-open
// branch below, where no usable bytes were obtained.
type ConfigPreflightResult =
  { status: "valid"; rawBuffer?: Buffer } | { status: "missing" } | { status: "corrupt" };

function preflightValidateConfig(configPath: string): ConfigPreflightResult {
  if (!fs.existsSync(configPath)) return { status: "missing" };
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { status: "corrupt" };
    }
    // Re-encode the bytes preflight just decoded so the caller can use them as
    // the pre-construction wipe snapshot without reading the file again. For
    // well-formed UTF-8 (BOM-free — a BOM throws SyntaxError above) this is
    // byte-identical to fs.readFileSync(configPath) raw. The lone edge is a
    // file with invalid UTF-8 byte sequences that still parses as JSON: those
    // bytes round-trip through U+FFFD, so rawBuffer matches what electron-store
    // itself decodes and rewrites — which is exactly what detectStoreWipe needs.
    return { status: "valid", rawBuffer: Buffer.from(raw, "utf8") };
  } catch (err) {
    if (err instanceof SyntaxError) return { status: "corrupt" };
    return { status: "valid" };
  }
}

function quarantineCorruptConfig(configPath: string): string | null {
  try {
    const quarantinePath = `${configPath}.corrupted.${Date.now()}`;
    fs.renameSync(configPath, quarantinePath);
    // The quarantined file inherits the original (potentially 0o644) inode mode
    // and may contain partial secrets; tighten before it lingers on disk.
    tightenFilePermissions(quarantinePath);
    console.log(`[Store] Quarantined corrupt config to ${quarantinePath}`);
    return quarantinePath;
  } catch (err) {
    console.warn("[Store] Failed to quarantine corrupt config:", err);
    return null;
  }
}

function restoreFromBackup(configPath: string): boolean {
  const backupPath = `${configPath}.bak`;
  try {
    if (!fs.existsSync(backupPath)) return false;
    const raw = fs.readFileSync(backupPath, "utf8");
    JSON.parse(raw);
    fs.copyFileSync(backupPath, configPath);
    // copyFileSync's mode propagation varies across platforms/filesystems and
    // a subsequent Store constructor failure would leave the restored file at
    // the backup's original mode — tighten unconditionally.
    tightenFilePermissions(configPath);
    console.log("[Store] Restored config from backup");
    return true;
  } catch {
    console.warn("[Store] Backup is missing or corrupt, cannot restore");
    return false;
  }
}

function refreshBackup(configPath: string): void {
  try {
    if (fs.existsSync(configPath)) {
      const backupPath = `${configPath}.bak`;
      fs.copyFileSync(configPath, backupPath);
      tightenFilePermissions(backupPath);
    }
  } catch (err) {
    console.warn("[Store] Failed to create config backup:", err);
  }
}

// Restrict the user-data store file (and its sidecar backup) to owner-only
// read/write. The store persists secrets — github tokens, voice/MCP API keys —
// and conf's default 0o666 lands at 0o644 after the typical umask, leaving the
// file world-readable on multi-user macOS/Linux machines. Windows ignores
// POSIX mode bits, so the platform guard keeps the call a no-op there.
function tightenFilePermissions(filePath: string): void {
  if (process.platform === "win32") return;
  if (!filePath) return;
  try {
    if (!fs.existsSync(filePath)) return;
    fs.chmodSync(filePath, 0o600);
  } catch (err) {
    console.warn("[Store] Failed to tighten file permissions:", filePath, err);
  }
}

function readRawSnapshot(filePath: string): Buffer | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

// A "wipe" is an electron-store rewrite that loses user data (clearInvalidConfig
// path). A "merge" is an electron-store rewrite that adds missing default keys
// while preserving every user value. Byte-equality cannot tell them apart, so
// we parse pre/post and check whether every key from pre survives in post with
// an identical value. Any dropped or changed user value means the file was
// wiped.
function detectStoreWipe(pre: Buffer, post: Buffer | null): boolean {
  if (post === null) return true;
  if (pre.equals(post)) return false;
  let preObj: unknown;
  let postObj: unknown;
  try {
    preObj = JSON.parse(pre.toString("utf8"));
  } catch {
    // Pre-content was not parseable JSON; preflight should have caught this,
    // but if we got here the safest move is to treat the rewrite as a wipe.
    return true;
  }
  try {
    postObj = JSON.parse(post.toString("utf8"));
  } catch {
    return true;
  }
  if (typeof preObj !== "object" || preObj === null || Array.isArray(preObj)) {
    return false;
  }
  if (typeof postObj !== "object" || postObj === null || Array.isArray(postObj)) {
    return true;
  }
  const preRecord = preObj as Record<string, unknown>;
  const postRecord = postObj as Record<string, unknown>;
  for (const key of Object.keys(preRecord)) {
    if (!Object.prototype.hasOwnProperty.call(postRecord, key)) return true;
    if (JSON.stringify(preRecord[key]) !== JSON.stringify(postRecord[key])) return true;
  }
  return false;
}

function createInMemoryFallback(): Store<StoreSchema> {
  const memoryStore = new Map();
  return {
    get: (key: string) => memoryStore.get(key),
    set: (key: string, value: unknown) => memoryStore.set(key, value),
    delete: (key: string) => memoryStore.delete(key),
    has: (key: string) => memoryStore.has(key),
    clear: () => memoryStore.clear(),
    store: {},
    path: "",
  } as unknown as Store<StoreSchema>;
}

let pendingSettingsRecovery: SettingsRecovery | null = null;

export function consumePendingSettingsRecovery(): SettingsRecovery | null {
  const value = pendingSettingsRecovery;
  pendingSettingsRecovery = null;
  return value;
}

export function _resetPendingSettingsRecovery(): void {
  pendingSettingsRecovery = null;
}

let storeInstance: Store<StoreSchema> | undefined;

/**
 * In-memory snapshot of the on-disk store. electron-store v11 (conf) has no
 * cache of its own — every `get()` re-reads and re-parses config.json from
 * disk. The proxy below populates this snapshot lazily on the first read and
 * serves all subsequent reads from memory, invalidating synchronously BEFORE
 * any mutation is delegated (main is single-threaded, so a pre-write snapshot
 * can never be served after the write — cf. the agentSettingsClient
 * write-window precedent). Only the main process writes config.json (the
 * pty-host and workspace-host subprocesses never import this module), so no
 * cross-process invalidation channel is needed.
 */
let storeValueCache: Record<string, unknown> | null = null;

/**
 * Drop the cached store snapshot. The proxy invalidates automatically for all
 * mutations routed through it; this export exists for the rare paths that
 * replace config.json behind electron-store's back (MigrationRunner's
 * restore-from-backup file swap) and for tests.
 */
export function invalidateStoreValueCache(): void {
  storeValueCache = null;
}

/** Dot-path lookup mirroring conf's `accessPropertiesByDotNotation` reads. */
function getCachedValue(snapshot: Record<string, unknown>, key: string): unknown {
  let node: unknown = snapshot;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, part)) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/**
 * Refreshing the `.bak` copy (and tightening its permissions) is recovery
 * housekeeping, not boot-critical work — but it ran synchronously inside
 * `initializeStore()` on the bootstrap critical path. `initializeStore()` now
 * stashes the work here and `bootstrap.ts` schedules it after main.js has
 * loaded. Until it runs, the previous session's `.bak` remains valid for
 * corrupt-config recovery, so the deferral window loses nothing.
 */
let deferredBackupTask: (() => void) | null = null;

export function runDeferredStoreBackup(): void {
  const task = deferredBackupTask;
  deferredBackupTask = null;
  task?.();
}

/**
 * True when no config.json existed on disk when initializeStore() ran — a
 * brand-new install (or wiped profile). The migration runner uses this to
 * stamp the latest schema version directly instead of replaying the full
 * migration chain against an empty store, which costs one atomic config
 * write per migration on the boot-critical path. Defaults to false so any
 * ambiguous state (in-memory fallback, unresolved path) takes the safe
 * migrate-everything route.
 */
let storeWasFreshAtBoot = false;

export function wasStoreFreshAtBoot(): boolean {
  return storeWasFreshAtBoot;
}

export function initializeStore(options: typeof storeOptions = storeOptions): Store<StoreSchema> {
  if (storeInstance) return storeInstance;

  const configPath = resolveConfigPath(options.cwd);
  storeWasFreshAtBoot = configPath !== null && !fs.existsSync(configPath);

  const preflight = configPath ? preflightValidateConfig(configPath) : null;
  if (preflight?.status === "corrupt") {
    console.warn("[Store] Detected corrupt config.json");
    const quarantinedPath = quarantineCorruptConfig(configPath!) ?? undefined;
    const restored = restoreFromBackup(configPath!);
    pendingSettingsRecovery = restored
      ? { kind: "restored-from-backup", quarantinedPath }
      : { kind: "reset-to-defaults", quarantinedPath };
  }

  try {
    // Reuse the bytes preflight already read on the valid path; the corrupt
    // branch mutated the file (quarantine + restore), so fall through to a
    // fresh read there so the snapshot reflects the post-recovery bytes.
    const preSnapshot =
      preflight?.status === "valid" && preflight.rawBuffer
        ? preflight.rawBuffer
        : configPath
          ? readRawSnapshot(configPath)
          : null;
    const created = new Store<StoreSchema>({
      ...options,
      clearInvalidConfig: true,
      configFileMode: 0o600,
    });
    const postSnapshot = configPath ? readRawSnapshot(configPath) : null;
    const wipedDuringConstruction =
      preSnapshot !== null && detectStoreWipe(preSnapshot, postSnapshot);
    if (wipedDuringConstruction) {
      console.warn(
        "[Store] electron-store silently replaced config.json during construction; preserving .bak"
      );
      // Don't clobber a more specific recovery state already set by preflight.
      if (pendingSettingsRecovery === null) {
        pendingSettingsRecovery = { kind: "reset-to-defaults" };
      }
    }
    // Migrate existing 0o644 files (created before configFileMode landed) to
    // 0o600 even when the user never triggers a write this session. The live
    // config carries secrets, so this stays synchronous; the .bak refresh and
    // its chmod are deferred off the boot path (see runDeferredStoreBackup).
    tightenFilePermissions(created.path);
    const configFilePath = created.path;
    deferredBackupTask = () => {
      // Wipe detection above means the on-disk config no longer reflects the
      // user's data — never overwrite the last-good .bak with it.
      if (!wipedDuringConstruction) {
        refreshBackup(configFilePath);
      }
      tightenFilePermissions(`${configFilePath}.bak`);
    };
    storeInstance = created;
    return created;
  } catch (error) {
    console.warn("[Store] Failed to initialize electron-store, using in-memory fallback:", error);
    pendingSettingsRecovery = { kind: "reset-to-defaults" };
    // An unreadable/unwritable config path can look "fresh" (existsSync false)
    // while real data still exists on disk. The in-memory fallback is an
    // ambiguous state — never let it claim the fresh-install migration
    // fast path.
    storeWasFreshAtBoot = false;
    const fallback = createInMemoryFallback();
    storeInstance = fallback;
    return fallback;
  }
}

export function _resetStoreInstance(): void {
  storeInstance = undefined;
  storeValueCache = null;
  deferredBackupTask = null;
  storeWasFreshAtBoot = false;
}

export function _peekStoreInstance(): Store<StoreSchema> | undefined {
  return storeInstance;
}

function getOrLazyInitInstance(): Store<StoreSchema> {
  // In production, bootstrap.ts calls initializeStore() explicitly before
  // any module reads the store, so this branch is unreachable. The lazy
  // fallback exists for tests that import services using `store` without
  // mocking it: they get the in-memory fallback that the previous
  // module-load `export const store = initializeStore()` provided implicitly.
  return storeInstance ?? initializeStore();
}

/**
 * Batched read-mutate-set helpers for `wslGitByWorktree` (#9926). Every
 * `store.set("wslGitByWorktree", …)` re-serializes the whole electron-store
 * file, and `set(undefined)` throws on electron-store v11 — so per-key writes
 * or `delete` is not safe. The host drives both the per-removal and
 * bulk-load self-heal paths, so the host emits `clear-wsl-git-opt-in` events
 * and main invokes these helpers from `WorkspaceHostEventRouter`.
 *
 * Legacy persisted entries may have been written with mixed-case UNC paths
 * (Windows is case-insensitive but the in-memory map is keyed by whatever
 * the renderer sent). The lookup here is case-insensitive on win32 so a host
 * emit with the canonical lowercase form still finds the legacy key.
 */
export function clearWslGitEntry(worktreeId: string): void {
  if (typeof worktreeId !== "string" || !worktreeId) return;
  const current = store.get("wslGitByWorktree");
  if (!current || typeof current !== "object") return;
  const map = current as Record<string, { enabled: boolean; dismissed: boolean }>;

  // Prefer an exact match; fall back to case-insensitive on win32 for legacy
  // mixed-case keys. POSIX stays case-sensitive — the in-memory host key is
  // also case-sensitive there, so a mismatch would be a real bug, not a
  // legacy artifact.
  let matchedKey: string | undefined;
  if (Object.prototype.hasOwnProperty.call(map, worktreeId)) {
    matchedKey = worktreeId;
  } else if (process.platform === "win32") {
    const target = worktreeId.toLowerCase();
    matchedKey = Object.keys(map).find((k) => k.toLowerCase() === target);
  }
  if (!matchedKey) return;

  const next = { ...map };
  delete next[matchedKey];
  // Always write the full (possibly empty) object — never `undefined` — so
  // electron-store v11 doesn't throw and the on-disk shape stays consistent.
  store.set("wslGitByWorktree", next);
}

export function writeWslGitMap(
  map: Record<string, { enabled: boolean; dismissed: boolean }>
): void {
  const safe = map && typeof map === "object" ? map : {};
  store.set("wslGitByWorktree", safe);
}

/**
 * Methods that mutate the backing file. The proxy nulls the value cache
 * before delegating so a same-tick read after a write always re-snapshots.
 * Every production write goes through this proxy — it is the module's only
 * exported handle — so proxy-level invalidation is the primary (and
 * sufficient) path; `invalidateStoreValueCache()` covers the lone file-swap
 * bypass in MigrationRunner.
 */
const STORE_MUTATING_METHODS = new Set(["set", "delete", "clear", "reset"]);

export const store = new Proxy({} as Store<StoreSchema>, {
  get(_target, prop) {
    const instance = getOrLazyInitInstance();
    const value = Reflect.get(instance as object, prop, instance);
    if (typeof value !== "function") return value;
    const bound = (value as (...args: unknown[]) => unknown).bind(instance);
    // Cached read path. Skipped for the in-memory fallback (path === ""),
    // whose Map-backed `store` property is always empty.
    if (prop === "get" && instance.path !== "") {
      return (key: string, defaultValue?: unknown) => {
        if (storeValueCache === null) {
          // One disk read + parse; every get until the next write is a memory hit.
          storeValueCache = instance.store as unknown as Record<string, unknown>;
        }
        const resolved = getCachedValue(storeValueCache, key);
        if (resolved === undefined) return defaultValue;
        // conf returns a freshly-parsed object per get; clone so a caller
        // mutating the returned value can't corrupt the shared snapshot.
        return typeof resolved === "object" && resolved !== null
          ? structuredClone(resolved)
          : resolved;
      };
    }
    if (STORE_MUTATING_METHODS.has(prop as string)) {
      return (...args: unknown[]) => {
        storeValueCache = null;
        return bound(...args);
      };
    }
    return bound;
  },
  set(_target, prop, value) {
    storeValueCache = null;
    const instance = getOrLazyInitInstance();
    return Reflect.set(instance as object, prop, value, instance);
  },
  has(_target, prop) {
    const instance = getOrLazyInitInstance();
    return Reflect.has(instance as object, prop);
  },
});

let windowStatesInstance: Store<WindowStatesStoreSchema> | undefined;

function initializeWindowStatesStore(): Store<WindowStatesStoreSchema> {
  if (windowStatesInstance) return windowStatesInstance;
  try {
    const created = new Store<WindowStatesStoreSchema>({
      name: "window-states",
      cwd: storeOptions.cwd,
      defaults: { windowStates: {} },
      clearInvalidConfig: true,
      configFileMode: 0o600,
    });
    tightenFilePermissions(created.path);
    windowStatesInstance = created;
    return created;
  } catch (error) {
    console.warn(
      "[Store] Failed to initialize window-states store, using in-memory fallback:",
      error
    );
    const memoryStore = new Map();
    const fallback = {
      get: (key: string) => memoryStore.get(key),
      set: (key: string, value: unknown) => memoryStore.set(key, value),
      delete: (key: string) => memoryStore.delete(key),
      has: (key: string) => memoryStore.has(key),
      clear: () => memoryStore.clear(),
      store: {},
      path: "",
    } as unknown as Store<WindowStatesStoreSchema>;
    windowStatesInstance = fallback;
    return fallback;
  }
}

// Lazy like the main `store` Proxy: defers the sync read+parse of
// window-states.json past the single-instance lock check, so a losing second
// instance never constructs it.
export const windowStatesStore = new Proxy({} as Store<WindowStatesStoreSchema>, {
  get(_target, prop) {
    const instance = initializeWindowStatesStore();
    const value = Reflect.get(instance as object, prop, instance);
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(instance)
      : value;
  },
  set(_target, prop, value) {
    const instance = initializeWindowStatesStore();
    return Reflect.set(instance as object, prop, value, instance);
  },
  has(_target, prop) {
    const instance = initializeWindowStatesStore();
    return Reflect.has(instance as object, prop);
  },
});

let auditLogsInstance: Store<AuditLogsStoreSchema> | undefined;

function initializeAuditLogsStore(): Store<AuditLogsStoreSchema> {
  if (auditLogsInstance) return auditLogsInstance;
  try {
    const created = new Store<AuditLogsStoreSchema>({
      name: "audit-logs",
      cwd: storeOptions.cwd,
      defaults: {
        mcpAuditLog: [],
        mcpTurnOutcomeLog: [],
        pluginAuditLog: [],
        forgeAuditLog: [],
        runHistoryRecords: [],
        pluginMcpAuditLog: [],
      },
      clearInvalidConfig: true,
      configFileMode: 0o600,
    });
    tightenFilePermissions(created.path);
    auditLogsInstance = created;
    return created;
  } catch (error) {
    console.warn("[Store] Failed to initialize audit-logs store, using in-memory fallback:", error);
    const memoryStore = new Map();
    const fallback = {
      get: (key: string) => memoryStore.get(key),
      set: (key: string, value: unknown) => memoryStore.set(key, value),
      delete: (key: string) => memoryStore.delete(key),
      has: (key: string) => memoryStore.has(key),
      clear: () => memoryStore.clear(),
      store: {},
      path: "",
    } as unknown as Store<AuditLogsStoreSchema>;
    auditLogsInstance = fallback;
    return fallback;
  }
}

// Lazy like the main `store` Proxy: the audit rings can grow to multiple MB
// and are only needed when an MCP audit consumer reads or flushes — never
// during bootstrap, so the sync read+parse of audit-logs.json is deferred.
export const auditLogsStore = new Proxy({} as Store<AuditLogsStoreSchema>, {
  get(_target, prop) {
    const instance = initializeAuditLogsStore();
    const value = Reflect.get(instance as object, prop, instance);
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(instance)
      : value;
  },
  set(_target, prop, value) {
    const instance = initializeAuditLogsStore();
    return Reflect.set(instance as object, prop, value, instance);
  },
  has(_target, prop) {
    const instance = initializeAuditLogsStore();
    return Reflect.has(instance as object, prop);
  },
});

export type { WindowStateEntry };

export {
  resolveConfigPath,
  preflightValidateConfig,
  quarantineCorruptConfig,
  restoreFromBackup,
  refreshBackup,
  createInMemoryFallback,
  tightenFilePermissions,
};
