import { describe, it, expect, beforeAll, vi } from "vitest";
import type { AnyActionDefinition, ActionRegistry } from "../../actionTypes";

// Minimum mocks so every definition file can import without side-effect errors.
// Factory bodies are lazy — they only touch clients/stores/services inside `run()`,
// which this test never calls. We only need imports to resolve.
vi.mock("@/clients", () => ({
  projectClient: { getSettings: vi.fn(), saveSettings: vi.fn() },
  worktreeClient: {},
  githubClient: {},
  appClient: {},
  terminalClient: {},
  copyTreeClient: {},
  systemClient: {},
  errorsClient: {},
  eventInspectorClient: {},
  logsClient: {},
  filesClient: {},
  slashCommandsClient: {},
  agentSettingsClient: {},
}));
vi.mock("@/clients/appThemeClient", () => ({ appThemeClient: {} }));
vi.mock("@/clients/notesClient", () => ({ notesClient: {} }));
vi.mock("@/services/ActionService", () => ({
  actionService: { list: () => [], dispatch: vi.fn() },
}));
vi.mock("@/services/KeybindingService", () => ({
  keybindingService: { loadOverrides: vi.fn(), getAllBindings: () => [] },
}));
vi.mock("@/services/VoiceRecordingService", () => ({
  voiceRecordingService: {},
}));
vi.mock("@/services/terminal/TerminalInstanceService", () => ({
  terminalInstanceService: {},
}));
vi.mock("@/services/terminal/panelDuplicationService", () => ({
  buildPanelDuplicateOptions: vi.fn(),
}));
vi.mock("@shared/theme", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getBuiltInAppSchemeForType: vi.fn(),
    resolveAppTheme: vi.fn(),
  };
});
vi.mock("@/store", () => ({ useProjectStore: { getState: () => ({}) } }));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({}) },
}));
vi.mock("@/store/portalStore", () => ({
  usePortalStore: { getState: () => ({}) },
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => ({}) },
}));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: () => ({}) },
}));
vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({ getState: () => ({ worktrees: new Map() }) }),
}));
vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: { getState: () => ({}) },
}));
vi.mock("@/store/githubConfigStore", () => ({
  useGitHubConfigStore: { getState: () => ({}) },
}));
vi.mock("@/store/userAgentRegistryStore", () => ({
  useUserAgentRegistryStore: { getState: () => ({ refresh: vi.fn() }) },
}));
vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: { getState: () => ({ refresh: vi.fn() }) },
}));
vi.mock("@/store/agentPreferencesStore", () => ({
  useAgentPreferencesStore: { getState: () => ({}) },
}));
vi.mock("@/store/appThemeStore", () => ({
  useAppThemeStore: { getState: () => ({}) },
}));
vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: { getState: () => ({}) },
}));
vi.mock("@/store/cachedProjectViewsStore", () => ({
  useCachedProjectViewsStore: { getState: () => ({}) },
}));
vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: { getState: () => ({}) },
}));
vi.mock("@/store/diagnosticsStore", () => ({
  useDiagnosticsStore: { getState: () => ({}) },
}));
vi.mock("@/store/errorStore", () => ({
  useErrorStore: { getState: () => ({}) },
}));
vi.mock("@/store/eventStore", () => ({
  useEventStore: { getState: () => ({}) },
}));
vi.mock("@/store/fleetArmingStore", () => ({
  useFleetArmingStore: { getState: () => ({}) },
  isFleetArmEligible: vi.fn(() => false),
}));
vi.mock("@/store/fleetPendingActionStore", () => ({
  useFleetPendingActionStore: { getState: () => ({ pending: null }) },
}));
vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: { getState: () => ({}) },
}));
vi.mock("@/store/layoutConfigStore", () => ({
  useLayoutConfigStore: { getState: () => ({}) },
}));
vi.mock("@/store/layoutUndoStore", () => ({
  useLayoutUndoStore: { getState: () => ({}) },
}));
vi.mock("@/store/logsStore", () => ({
  useLogsStore: { getState: () => ({}) },
}));
vi.mock("@/store/performanceModeStore", () => ({
  usePerformanceModeStore: { getState: () => ({}) },
}));
vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: { getState: () => ({}) },
}));
vi.mock("@/store/screenReaderStore", () => ({
  useScreenReaderStore: { getState: () => ({}) },
}));
vi.mock("@/store/scrollbackStore", () => ({
  useScrollbackStore: { getState: () => ({}) },
}));
vi.mock("@/store/terminalFontStore", () => ({
  useTerminalFontStore: { getState: () => ({}) },
}));
vi.mock("@/store/terminalInputStore", () => ({
  useTerminalInputStore: { getState: () => ({}) },
  triggerPopStash: vi.fn(),
  triggerStashInput: vi.fn(),
}));
vi.mock("@/store/persistence/persistedStoreRegistry", () => ({
  listPersistedStores: () => [],
}));
vi.mock("@/store/persistence/safeStorage", () => ({
  readLocalStorageItemSafely: vi.fn(() => null),
}));
vi.mock("@/lib/portalBounds", () => ({
  getPortalPlaceholderBounds: vi.fn(),
}));
vi.mock("@/lib/terminalLayout", () => ({
  computeGridColumns: vi.fn(() => 1),
}));
vi.mock("@/lib/watchNotification", () => ({
  fireWatchNotification: vi.fn(),
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/lib/aiAgentDetection", () => ({ getAIAgentInfo: vi.fn() }));
vi.mock("@/lib/resolveAgentId", () => ({ getDefaultAgentId: vi.fn() }));
vi.mock("@/lib/projectMru", () => ({ getMruProjects: vi.fn(() => []) }));
vi.mock("@/lib/worktreeCyclingOrder", () => ({
  getVisibleWorktreesForCycling: vi.fn(() => []),
}));
vi.mock("@/lib/copyTreeFormat", () => ({
  DEFAULT_COPYTREE_FORMAT: "xml",
}));
vi.mock("@/lib/panelContextMenu", () => ({ openPanelContextMenu: vi.fn() }));
vi.mock("@/components/BulkCommandCenter/BulkCommandPalette", () => ({
  openBulkCommandPalette: vi.fn(),
}));
vi.mock("@/hooks/useSendToAgentPalette", () => ({
  openSendToAgentPalette: vi.fn(),
}));

// Rules
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 120;
// Keep in sync with CLAUDE.md > Actions > Categories.
const CANONICAL_CATEGORIES = new Set<string>([
  "agent",
  "app",
  "artifacts",
  "browser",
  "copyTree",
  "devServer",
  "diagnostics",
  "errors",
  "files",
  "git",
  "github",
  "help",
  "introspection",
  "logs",
  "navigation",
  "notes",
  "panel",
  "portal",
  "preferences",
  "project",
  "recipes",
  "settings",
  "system",
  "terminal",
  "ui",
  "voice",
  "worktree",
]);
// Lowercase start on each dot-separated segment, camelCase allowed within.
const ID_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

interface MetadataFailure {
  id: string;
  title: string;
  category: string;
  failures: string[];
}

function validateDefinition(def: AnyActionDefinition): string[] {
  const failures: string[] = [];
  const id = def.id ?? "";
  const title = def.title ?? "";
  const description = def.description ?? "";
  const category = def.category ?? "";

  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    failures.push(`id "${id}" does not match namespace.action convention`);
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    failures.push("title is empty");
  } else if (title.length > TITLE_MAX) {
    failures.push(`title is ${title.length} chars (max ${TITLE_MAX})`);
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    failures.push("description is empty");
  } else if (description.length > DESCRIPTION_MAX) {
    failures.push(`description is ${description.length} chars (max ${DESCRIPTION_MAX})`);
  }
  if (typeof category !== "string" || !CANONICAL_CATEGORIES.has(category)) {
    failures.push(`category "${category}" is not in canonical allowlist`);
  }
  return failures;
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width - 1) + "…";
  return value + " ".repeat(width - value.length);
}

function formatFailureTable(failures: MetadataFailure[], total: number): string {
  const MAX_ROWS = 50;
  const header =
    `\n${failures.length}/${total} actions failed metadata validation.\n\n` +
    `${pad("ID", 42)}${pad("Title", 30)}${pad("Category", 16)}Violations\n` +
    `${"-".repeat(42 + 30 + 16 + 10)}\n`;
  const rows = failures.slice(0, MAX_ROWS).map((f) => {
    return `${pad(f.id, 42)}${pad(f.title, 30)}${pad(f.category, 16)}${f.failures.join("; ")}`;
  });
  const truncationNote =
    failures.length > MAX_ROWS ? `\n… and ${failures.length - MAX_ROWS} more.` : "";
  return header + rows.join("\n") + truncationNote;
}

describe("action metadata quality gate", () => {
  const registry: ActionRegistry = new Map();

  beforeAll(async () => {
    // Load registerers and populate the registry. Keep this list in sync with
    // createActionDefinitions in src/services/actions/actionDefinitions.ts.
    const { registerTerminalQueryActions } = await import("../terminalQueryActions");
    const { registerTerminalSpawnActions } = await import("../terminalSpawnActions");
    const { registerTerminalLifecycleActions } = await import("../terminalLifecycleActions");
    const { registerTerminalNavigationActions } = await import("../terminalNavigationActions");
    const { registerTerminalLayoutActions } = await import("../terminalLayoutActions");
    const { registerTerminalInputActions } = await import("../terminalInputActions");
    const { registerTerminalWorktreeActions } = await import("../terminalWorktreeActions");
    const { registerFleetActions } = await import("../fleetActions");
    const { registerAgentActions } = await import("../agentActions");
    const { registerPanelActions } = await import("../panelActions");
    const { registerWorktreeActions } = await import("../worktreeActions");
    const { registerWorktreeSessionActions } = await import("../worktreeSessionActions");
    const { registerRecipeActions } = await import("../recipeActions");
    const { registerProjectActions } = await import("../projectActions");
    const { registerEnvActions } = await import("../envActions");
    const { registerGithubActions } = await import("../githubActions");
    const { registerGitActions } = await import("../gitActions");
    const { registerSystemActions } = await import("../systemActions");
    const { registerLogActions } = await import("../logActions");
    const { registerNavigationActions } = await import("../navigationActions");
    const { registerAppActions } = await import("../appActions");
    const { registerPreferencesActions } = await import("../preferencesActions");
    const { registerBrowserActions } = await import("../browserActions");
    const { registerNotesActions } = await import("../notesActions");
    const { registerIntrospectionActions } = await import("../introspectionActions");
    const { registerDevServerActions } = await import("../devServerActions");
    const { registerWorkflowActions } = await import("../workflowActions");
    const { registerFileActions } = await import("../fileActions");
    const { registerVoiceActions } = await import("../voiceActions");

    const cb = {} as never;
    registerTerminalQueryActions(registry, cb);
    registerTerminalSpawnActions(registry, cb);
    registerTerminalLifecycleActions(registry, cb);
    registerTerminalNavigationActions(registry, cb);
    registerTerminalLayoutActions(registry, cb);
    registerTerminalInputActions(registry, cb);
    registerTerminalWorktreeActions(registry, cb);
    registerFleetActions(registry);
    registerAgentActions(registry, cb);
    registerPanelActions(registry, cb);
    registerWorktreeActions(registry, cb);
    registerWorktreeSessionActions(registry, cb);
    registerRecipeActions(registry, cb);
    registerProjectActions(registry, cb);
    registerEnvActions(registry, cb);
    registerGithubActions(registry, cb);
    registerGitActions(registry, cb);
    registerSystemActions(registry, cb);
    registerLogActions(registry, cb);
    registerNavigationActions(registry, cb);
    registerAppActions(registry, cb);
    registerPreferencesActions(registry, cb);
    registerBrowserActions(registry, cb);
    registerNotesActions(registry, cb);
    registerIntrospectionActions(registry, cb);
    registerDevServerActions(registry, cb);
    registerWorkflowActions(registry);
    registerFileActions(registry, cb);
    registerVoiceActions(registry);
  });

  it("registers at least 250 actions (sanity check)", () => {
    expect(registry.size).toBeGreaterThan(250);
  });

  it("every registered action passes all metadata rules", () => {
    const failures: MetadataFailure[] = [];
    for (const [id, factory] of registry.entries()) {
      let def: AnyActionDefinition;
      try {
        def = factory();
      } catch (error) {
        failures.push({
          id: String(id),
          title: "",
          category: "",
          failures: [`factory threw: ${(error as Error).message}`],
        });
        continue;
      }
      const rule = validateDefinition(def);
      if (rule.length > 0) {
        failures.push({
          id: String(id),
          title: def.title ?? "",
          category: def.category ?? "",
          failures: rule,
        });
      }
    }
    const message =
      failures.length === 0
        ? "All actions pass metadata validation"
        : formatFailureTable(failures, registry.size);
    expect(failures.length, message).toBe(0);
  });
});
