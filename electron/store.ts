import Store from "electron-store";
import fs from "fs";
import path from "path";
import type {
  AgentSettings,
  PanelGridConfig,
  UserAgentRegistry,
  AgentUpdateSettings,
  AppAgentConfig,
} from "../shared/types/index.js";
import type { IssueAssociation } from "../shared/types/ipc/worktree.js";
import type { ErrorRecord } from "../shared/types/ipc/errors.js";
import type { BuiltInAgentId } from "../shared/config/agentIds.js";
import type { AgentId } from "../shared/types/agent.js";
import { DEFAULT_AGENT_SETTINGS, DEFAULT_APP_AGENT_CONFIG } from "../shared/types/index.js";
import type { AppThemeConfig } from "../shared/types/appTheme.js";
import type { SettingsRecovery, ActionFrecencyEntry } from "../shared/types/ipc/app.js";

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
  appState: {
    activeWorktreeId?: string;
    sidebarWidth: number;
    focusMode?: boolean;
    focusPanelState?: {
      sidebarWidth: number;
      diagnosticsOpen: boolean;
    };
    diagnosticsHeight?: number;
    hasSeenWelcome?: boolean;
    developerMode?: {
      enabled: boolean;
      showStateDebug: boolean;
      autoOpenDiagnostics: boolean;
      focusEventsTab: boolean;
    };
    terminals: Array<{
      id: string;
      kind?: "terminal" | "browser" | "dev-preview" | string;
      launchAgentId?: AgentId;
      title: string;
      titleMode?: "default" | "custom";
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
    actionMruList?: ActionFrecencyEntry[] | string[];
    fleetScopeMode?: "legacy" | "scoped";
  };
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
  appTheme: Partial<AppThemeConfig>;
  privacy: {
    telemetryLevel: "off" | "errors" | "full";
    hasSeenPrompt: boolean;
    logRetentionDays: 7 | 30 | 90 | 0;
  };
  voiceInput: {
    enabled: boolean;
    apiKey: string;
    language: string;
    customDictionary: string[];
    transcriptionModel: string;
    correctionEnabled: boolean;
    correctionModel: string;
    correctionCustomInstructions: string;
    paragraphingStrategy: string;
  };
  mcpServer: {
    enabled: boolean;
    port: number | null;
    apiKey: string;
  };
  pendingErrors: ErrorRecord[];
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
  updateChannel: "stable" | "nightly";
  dismissedUpdateVersion?: string;
  dismissedUpdateAt?: number;
  /**
   * Per-logger level overrides keyed by stable `"<process>:Module"` names (or
   * `"*"` / `"<process>:*"` wildcards). Values are `"debug" | "info" | "warn"
   * | "error" | "off"`. Persisted so support sessions can reproduce boot-time
   * issues without reconfiguring on every launch.
   */
  logLevelOverrides: Record<string, string>;
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
    appTheme: {},
    privacy: {
      telemetryLevel: "off" as const,
      hasSeenPrompt: false,
      logRetentionDays: 30 as const,
    },
    voiceInput: {
      enabled: false,
      apiKey: "",
      language: "en",
      customDictionary: [],
      transcriptionModel: "nova-3",
      correctionEnabled: false,
      correctionModel: "gpt-5-mini",
      correctionCustomInstructions: "",
      paragraphingStrategy: "spoken-command",
    },
    mcpServer: {
      enabled: false,
      port: 45454,
      apiKey: "",
    },
    pendingErrors: [],
    gpu: {
      hardwareAccelerationDisabled: false,
    },
    crashRecovery: {
      autoRestoreOnCrash: false,
    },
    onboarding: {
      schemaVersion: 1,
      completed: false,
      currentStep: null,
      agentSetupIds: [],
      firstRunToastSeen: false,
      newsletterPromptSeen: false,
      waitingNudgeSeen: false,
      seenAgentIds: [],
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
    updateChannel: "stable" as const,
    logLevelOverrides: {},
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

function preflightValidateConfig(configPath: string): "valid" | "missing" | "corrupt" {
  if (!fs.existsSync(configPath)) return "missing";
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "corrupt";
    }
    return "valid";
  } catch (err) {
    if (err instanceof SyntaxError) return "corrupt";
    return "valid";
  }
}

function quarantineCorruptConfig(configPath: string): string | null {
  try {
    const quarantinePath = `${configPath}.corrupted.${Date.now()}`;
    fs.renameSync(configPath, quarantinePath);
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
      fs.copyFileSync(configPath, `${configPath}.bak`);
    }
  } catch (err) {
    console.warn("[Store] Failed to create config backup:", err);
  }
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

export function initializeStore(options: typeof storeOptions = storeOptions): Store<StoreSchema> {
  const configPath = resolveConfigPath(options.cwd);

  if (configPath) {
    const status = preflightValidateConfig(configPath);
    if (status === "corrupt") {
      console.warn("[Store] Detected corrupt config.json");
      const quarantinedPath = quarantineCorruptConfig(configPath) ?? undefined;
      const restored = restoreFromBackup(configPath);
      pendingSettingsRecovery = restored
        ? { kind: "restored-from-backup", quarantinedPath }
        : { kind: "reset-to-defaults", quarantinedPath };
    }
  }

  try {
    const instance = new Store<StoreSchema>({
      ...options,
      clearInvalidConfig: true,
    });
    refreshBackup(instance.path);
    return instance;
  } catch (error) {
    console.warn("[Store] Failed to initialize electron-store, using in-memory fallback:", error);
    pendingSettingsRecovery = { kind: "reset-to-defaults" };
    return createInMemoryFallback();
  }
}

export const store = initializeStore();

export {
  resolveConfigPath,
  preflightValidateConfig,
  quarantineCorruptConfig,
  restoreFromBackup,
  refreshBackup,
  createInMemoryFallback,
};
