import Store from "electron-store";
import type {
  AgentSettings,
  PanelGridConfig,
  UserAgentRegistry,
  AgentUpdateSettings,
  AppAgentConfig,
} from "../shared/types/index.js";
import type { IssueAssociation } from "../shared/types/ipc/worktree.js";
import type { AppError } from "../shared/types/ipc/errors.js";
import { DEFAULT_AGENT_SETTINGS, DEFAULT_APP_AGENT_CONFIG } from "../shared/types/index.js";
import type { AppThemeConfig } from "../shared/types/appTheme.js";

export interface StoreSchema {
  _schemaVersion: number;
  windowState: {
    x?: number;
    y?: number;
    width: number;
    height: number;
    isMaximized: boolean;
  };
  terminalConfig: {
    scrollbackLines: number; // 100-10000 (user-configurable)
    performanceMode: boolean;
    hybridInputEnabled?: boolean;
    hybridInputAutoFocus?: boolean;
  };
  hibernation: {
    enabled: boolean;
    inactiveThresholdHours: number;
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
    hasSeenWelcome?: boolean;
    developerMode?: {
      enabled: boolean;
      showStateDebug: boolean;
      autoOpenDiagnostics: boolean;
      focusEventsTab: boolean;
    };
    terminals: Array<{
      id: string;
      kind?: "terminal" | "agent" | "browser" | "notes" | "dev-preview" | string;
      type?: "terminal" | "claude" | "gemini" | "codex" | "opencode";
      agentId?: string;
      title: string;
      cwd?: string;
      worktreeId?: string;
      location: "grid" | "dock";
      command?: string;
      settings?: {
        autoRestart?: boolean;
      };
      isInputLocked?: boolean;
      browserUrl?: string;
      notePath?: string;
      noteId?: string;
      scope?: "worktree" | "project";
      createdAt?: number;
      devCommand?: string;
      devPreviewConsoleOpen?: boolean;
    }>;
    /** @deprecated Recipes are now stored per-project. This field is kept for migration only. */
    recipes?: Array<{
      id: string;
      name: string;
      worktreeId?: string;
      terminals: Array<{
        type: "terminal" | "claude" | "gemini" | "codex" | "opencode";
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
    actionMruList?: string[];
  };
  userConfig: {
    githubToken?: string;
  };
  worktreeConfig: {
    pathPattern: string;
  };
  agentSettings: AgentSettings;
  notificationSettings: {
    completedEnabled: boolean;
    waitingEnabled: boolean;
    failedEnabled: boolean;
    soundEnabled: boolean;
    soundFile: string;
  };
  userAgentRegistry: UserAgentRegistry;
  agentUpdateSettings: AgentUpdateSettings;
  keybindingOverrides: {
    overrides: Record<string, string[]>;
  };
  projectEnv: Record<string, string>;
  appAgentConfig: AppAgentConfig;
  worktreeIssueMap: Record<string, IssueAssociation>;
  appTheme: AppThemeConfig;
  telemetry: {
    enabled: boolean;
    hasSeenPrompt: boolean;
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
  pendingErrors: AppError[];
  crashRecovery: {
    autoRestoreOnCrash: boolean;
  };
  onboarding: {
    schemaVersion: number;
    completed: boolean;
    currentStep: string | null;
    firstRunToastSeen: boolean;
    newsletterPromptSeen: boolean;
    migratedFromLocalStorage: boolean;
    checklist: {
      dismissed: boolean;
      items: {
        openedProject: boolean;
        launchedAgent: boolean;
        createdWorktree: boolean;
      };
    };
  };
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
      scrollbackLines: 5000,
      performanceMode: false,
      hybridInputEnabled: true,
      hybridInputAutoFocus: true,
    },
    hibernation: {
      enabled: false,
      inactiveThresholdHours: 24,
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
      completedEnabled: false,
      waitingEnabled: false,
      failedEnabled: false,
      soundEnabled: false,
      soundFile: "chime.wav",
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
    appAgentConfig: DEFAULT_APP_AGENT_CONFIG,
    worktreeIssueMap: {},
    appTheme: {
      colorSchemeId: "canopy",
    },
    telemetry: {
      enabled: false,
      hasSeenPrompt: false,
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
    crashRecovery: {
      autoRestoreOnCrash: false,
    },
    onboarding: {
      schemaVersion: 1,
      completed: false,
      currentStep: null,
      firstRunToastSeen: false,
      newsletterPromptSeen: false,
      migratedFromLocalStorage: false,
      checklist: {
        dismissed: false,
        items: {
          openedProject: false,
          launchedAgent: false,
          createdWorktree: false,
        },
      },
    },
  },
  cwd: process.env.CANOPY_USER_DATA,
};

let storeInstance: Store<StoreSchema>;

try {
  storeInstance = new Store<StoreSchema>(storeOptions);
} catch (error) {
  console.warn(
    "[Store] Failed to initialize electron-store (likely in UtilityProcess), using in-memory fallback:",
    error
  );
  // Minimal in-memory fallback to prevent crash on import
  const memoryStore = new Map();
  storeInstance = {
    get: (key: string) => memoryStore.get(key),
    set: (key: string, value: any) => memoryStore.set(key, value),
    delete: (key: string) => memoryStore.delete(key),
    has: (key: string) => memoryStore.has(key),
    clear: () => memoryStore.clear(),
    store: {},
    path: "",
  } as unknown as Store<StoreSchema>;
}

export const store = storeInstance;
