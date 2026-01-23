import Store from "electron-store";
import type { Project } from "./types/index.js";
import type {
  AgentSettings,
  PanelGridConfig,
  UserAgentRegistry,
  AgentUpdateSettings,
} from "../shared/types/index.js";
import { DEFAULT_AGENT_SETTINGS } from "../shared/types/index.js";

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
    dockCollapsed?: boolean;
    dockMode?: "expanded" | "compact" | "slim" | "hidden";
    dockBehavior?: "auto" | "manual";
    dockAutoHideWhenEmpty?: boolean;
    compactDockMinimal?: boolean;
  };
  projects: {
    list: Project[];
    currentProjectId?: string;
  };
  userConfig: {
    githubToken?: string;
  };
  worktreeConfig: {
    pathPattern: string;
  };
  agentSettings: AgentSettings;
  userAgentRegistry: UserAgentRegistry;
  agentUpdateSettings: AgentUpdateSettings;
  keybindingOverrides: {
    overrides: Record<string, string[]>;
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
      dockCollapsed: false,
      dockMode: "hidden" as const,
      dockBehavior: "auto" as const,
      dockAutoHideWhenEmpty: false,
    },
    projects: {
      list: [],
      currentProjectId: undefined,
    },
    userConfig: {},
    worktreeConfig: {
      pathPattern: "{parent-dir}/{base-folder}-worktrees/{branch-slug}",
    },
    agentSettings: DEFAULT_AGENT_SETTINGS,
    userAgentRegistry: {},
    agentUpdateSettings: {
      autoCheck: true,
      checkFrequencyHours: 24,
      lastAutoCheck: null,
    },
    keybindingOverrides: {
      overrides: {},
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
