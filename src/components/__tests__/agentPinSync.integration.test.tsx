// @vitest-environment jsdom
//
// Integration test for issue #5112: proves that the Agent Tray's pin toggle
// and Settings > Toolbar's checkbox share the same canonical state via
// `agentSettingsStore`. A shared mutable mock store stands in for the real
// Zustand store; both UIs read from and write to the same settings object,
// which is exactly the guarantee the split-brain fix provides.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { AgentSettings, CliAvailability } from "@shared/types";
import type { ActionFrecencyEntry } from "@shared/types/actions";

// Shared settings state — mutated by setAgentPinnedMock, read by both UIs.
let sharedSettings: AgentSettings | null = null;

const setAgentPinnedMock = vi.fn(async (id: string, pinned: boolean) => {
  sharedSettings = {
    ...(sharedSettings ?? ({ agents: {} } as AgentSettings)),
    agents: {
      ...(sharedSettings?.agents ?? {}),
      [id]: { ...(sharedSettings?.agents?.[id] ?? {}), pinned },
    },
  } as AgentSettings;
});

const dispatchMock = vi.fn();
const refreshAvailabilityMock = vi.fn().mockResolvedValue(undefined);
const toggleButtonVisibilityMock = vi.fn();
const updateAgentMock = vi.fn().mockResolvedValue(undefined);
const updateWorktreePresetMock = vi.fn().mockResolvedValue(undefined);
const recordActionMruMock = vi.fn();

// LauncherMenuButton calls `useAgentSettingsStore.getState()` inside
// `handleLaunch`, so the mock has to expose both the hook selector and a
// static `getState`. `settings` reads via a getter so `beforeEach`
// mutations to `sharedSettings` propagate through the static handle too.
const agentSettingsState = {
  get settings() {
    return sharedSettings;
  },
  setAgentPinned: setAgentPinnedMock,
  updateAgent: updateAgentMock,
  updateWorktreePreset: updateWorktreePresetMock,
};

vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: Object.assign(
    (selector: (s: typeof agentSettingsState) => unknown) => selector(agentSettingsState),
    { getState: () => agentSettingsState }
  ),
}));

vi.mock("@/store/actionMruStore", () => ({
  useActionMruStore: Object.assign(
    (
      selector: (s: {
        getSortedActionMruList: () => ActionFrecencyEntry[];
        actionUsageEntries: Map<string, unknown>;
      }) => unknown
    ) =>
      selector({
        getSortedActionMruList: () => [],
        // Subscribed by the launcher model for MRU invalidation.
        actionUsageEntries: new Map(),
      }),
    { getState: () => ({ recordActionMru: recordActionMruMock }) }
  ),
}));

let sharedAvailability: CliAvailability = {} as CliAvailability;

vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: (
    selector: (s: {
      refresh: typeof refreshAvailabilityMock;
      hasRealData: boolean;
      availability: CliAvailability;
    }) => unknown
  ) =>
    selector({
      refresh: refreshAvailabilityMock,
      hasRealData: true,
      availability: sharedAvailability,
    }),
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ panelsById: {}, panelIds: [], setFocused: vi.fn() }),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (selector: (s: { activeWorktreeId: string | null }) => unknown) =>
    selector({ activeWorktreeId: null }),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

vi.mock("@/hooks", () => ({ useKeybindingDisplay: () => null }));

vi.mock("@shared/config/agentIds", () => {
  const BUILT_IN_AGENT_IDS = ["claude", "gemini", "codex"] as const;
  const ASSISTANT_ONLY_AGENT_IDS = [] as const;
  const LAUNCHABLE_AGENT_IDS = BUILT_IN_AGENT_IDS;
  const set: ReadonlySet<string> = new Set<string>(BUILT_IN_AGENT_IDS);
  return {
    BUILT_IN_AGENT_IDS,
    ASSISTANT_ONLY_AGENT_IDS,
    LAUNCHABLE_AGENT_IDS,
    BUILT_IN_AGENT_KEY_ACTIONS: BUILT_IN_AGENT_IDS.map((id) => `agent.${id}`),
    isBuiltInAgentId: (value: unknown): boolean => typeof value === "string" && set.has(value),
    isAssistantOnlyAgentId: () => false,
  };
});

vi.mock("@/config/agents", () => ({
  getAgentConfig: (id: string) => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    icon: () => null,
  }),
  getMergedPresets: () => [],
}));

vi.mock("@/store/ccrPresetsStore", () => ({
  useCcrPresetsStore: (selector: (s: { ccrPresetsByAgent: Record<string, unknown> }) => unknown) =>
    selector({ ccrPresetsByAgent: {} }),
}));

vi.mock("@/store/projectPresetsStore", () => ({
  useProjectPresetsStore: (selector: (s: { presetsByAgent: Record<string, unknown> }) => unknown) =>
    selector({ presetsByAgent: {} }),
}));

vi.mock("@/hooks/app/useAgentDiscoveryOnboarding", () => ({
  NEW_AGENT_TTL_MS: 14 * 24 * 60 * 60 * 1000,
  useAgentDiscoveryOnboarding: () => ({
    loaded: true,
    seenAgentIds: [],
    availabilityFirstSeen: {},
    welcomeCardDismissed: true,
    setupBannerDismissed: true,
    markAgentsSeen: vi.fn(),
    recordAgentFirstSeen: vi.fn(),
    dismissWelcomeCard: vi.fn(),
    dismissSetupBanner: vi.fn(),
  }),
}));

vi.mock("@/lib/colorUtils", () => ({ getBrandColorHex: (id: string) => `#${id}` }));

// The launcher renders inside the anchored palette shell. Stubbed so these
// cross-store assertions stay decoupled from Radix portalling and focus
// management — the shell has its own suite; what matters here is that the rows
// render and their pin control writes through the real dispatcher.
vi.mock("@/components/ui/AppPalettePopover", () => {
  const AppPalettePopover = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  AppPalettePopover.Trigger = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  AppPalettePopover.Content = ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  );
  return { AppPalettePopover };
});

vi.mock("@/components/ui/AppPaletteDialog", () => {
  const AppPaletteDialog = {
    Header: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Input: ({
      inputRef,
      ...props
    }: {
      inputRef?: React.RefObject<HTMLInputElement | null>;
    } & React.InputHTMLAttributes<HTMLInputElement>) => <input ref={inputRef} {...props} />,
    Body: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Empty: () => <div>empty</div>,
  };
  return { AppPaletteDialog, PALETTE_SURFACE_WIDTHS: {} };
});

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/Layout/ToolbarContextMenuItems", () => ({
  ToolbarContextMenuItems: () => null,
}));

vi.mock("@/components/KeyboardShortcuts", () => ({
  AgentShortcutCapture: () => <div data-testid="shortcut-capture" />,
}));

vi.mock("@/components/PanelPalette/PanelKindIcon", () => ({ PanelKindIcon: () => null }));

// Empty map: the running pip is irrelevant to pin sync and pulling the real
// derivation would drag the panel store's whole shape in with it.
vi.mock("@/lib/agentDominantStates", () => ({
  deriveAgentDominantStates: () => new Map<string, null>(),
}));

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

vi.mock("@/store/paletteStore", () => ({
  usePaletteStore: Object.assign(
    (selector: (s: { activePaletteId: string | null }) => unknown) =>
      selector({ activePaletteId: null }),
    { getState: () => ({ openPalette: vi.fn(), closePalette: vi.fn() }) }
  ),
}));

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: Object.assign(
    (selector: (s: { recipes: unknown[] }) => unknown) => selector({ recipes: [] }),
    { getState: () => ({ runRecipeWithResults: vi.fn() }) }
  ),
}));

vi.mock("@/registry", () => ({
  getSpawnablePanelKinds: () => [],
  subscribeToPanelKindDefinitions: () => () => {},
  getPanelKindDefinitionsSnapshot: () => 0,
}));

vi.mock("@shared/config/panelKindRegistry", () => ({
  panelKindIsDockable: () => true,
  getPanelKindConfig: () => undefined,
  subscribeToPanelKindRegistry: () => () => {},
  getPanelKindRegistrySnapshot: () => 0,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: { children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

// Settings-tab mocks.
let sharedToolbarLayout = {
  leftButtons: ["launcher", "claude", "gemini", "codex", "terminal"] as string[],
  rightButtons: ["settings"] as string[],
  pinnedButtons: {} as Record<string, boolean>,
};
const sharedToolbarLauncher = { alwaysShowDevServer: false, defaultSelection: undefined };

const setPanelButtonOnToolbarMock = vi.fn();
const positionAgentButtonMock = vi.fn();

vi.mock("@/store", () => ({
  useToolbarPreferencesStore: (
    selector: (s: {
      layout: typeof sharedToolbarLayout;
      launcher: typeof sharedToolbarLauncher;
      setLeftButtons: () => void;
      setRightButtons: () => void;
      toggleButtonVisibility: typeof toggleButtonVisibilityMock;
      setPanelButtonOnToolbar: typeof setPanelButtonOnToolbarMock;
      positionAgentButton: typeof positionAgentButtonMock;
      setPluginButtonPromoted: () => void;
      setAlwaysShowDevServer: () => void;
      setDefaultSelection: () => void;
      reset: () => void;
    }) => unknown
  ) =>
    selector({
      layout: sharedToolbarLayout,
      launcher: sharedToolbarLauncher,
      setLeftButtons: vi.fn(),
      setRightButtons: vi.fn(),
      toggleButtonVisibility: toggleButtonVisibilityMock,
      setPanelButtonOnToolbar: setPanelButtonOnToolbarMock,
      positionAgentButton: positionAgentButtonMock,
      setPluginButtonPromoted: vi.fn(),
      setAlwaysShowDevServer: vi.fn(),
      setDefaultSelection: vi.fn(),
      reset: vi.fn(),
    }),
}));

// The launcher imports this by its own path; the `@/store` mock above only
// covers the barrel the Settings tab reaches through.
vi.mock("@/store/toolbarPreferencesStore", () => ({
  useToolbarPreferencesStore: (
    selector: (s: {
      layout: typeof sharedToolbarLayout;
      setPanelButtonOnToolbar: typeof setPanelButtonOnToolbarMock;
      positionAgentButton: typeof positionAgentButtonMock;
      toggleButtonVisibility: typeof toggleButtonVisibilityMock;
    }) => unknown
  ) =>
    selector({
      layout: sharedToolbarLayout,
      setPanelButtonOnToolbar: setPanelButtonOnToolbarMock,
      positionAgentButton: positionAgentButtonMock,
      toggleButtonVisibility: toggleButtonVisibilityMock,
    }),
}));

vi.mock("@/hooks/usePluginToolbarButtons", () => ({
  usePluginToolbarButtons: () => ({ buttonIds: [], configs: new Map() }),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DragOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  closestCorners: vi.fn(),
  pointerWithin: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useSensor: vi.fn(),
  useSensors: () => [],
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  sortableKeyboardCoordinates: vi.fn(),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  }),
  rectSortingStrategy: vi.fn(),
  arrayMove: <T,>(arr: T[], from: number, to: number): T[] => {
    const next = arr.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item as T);
    return next;
  },
}));

vi.mock("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => "" } } }));

vi.mock("@/components/Settings/SettingsSection", () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));

vi.mock("@/components/Settings/SettingsSwitchCard", () => ({
  SettingsSwitchCard: () => null,
}));

// Render the switch as a plain role="switch" button so these cross-store sync
// assertions stay decoupled from Radix internals (and so `aria-checked`
// reflects the derived visibility state).
vi.mock("@/components/Settings/SettingsSwitch", () => ({
  SettingsSwitch: ({
    checked,
    onCheckedChange,
    "aria-label": ariaLabel,
  }: {
    checked: boolean;
    onCheckedChange: (next: boolean) => void;
    "aria-label"?: string;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onCheckedChange(!checked)}
    >
      {ariaLabel}
    </button>
  ),
}));

// jsdom implements no layout, so it ships no scrollIntoView at all. The
// launcher keeps its active row in view through it on every selection move.
Element.prototype.scrollIntoView = vi.fn();

import { DockLaunchButton } from "@/components/Layout/DockLaunchButton";
import { ToolbarSettingsTab } from "@/components/Settings/ToolbarSettingsTab";

const AGENT_NAMES: Record<string, string> = {
  claude: "Claude",
  gemini: "Gemini",
  codex: "Codex",
};

// The launcher in its toolbar placement — the same component the dock renders,
// which is the whole point of #11691. Agents are passed in the order the real
// `useLauncherData` would produce.
function renderLauncher(agentIds: string[]) {
  return render(
    <DockLaunchButton
      placement="toolbar"
      agents={agentIds.map((id) => ({
        id,
        name: AGENT_NAMES[id] ?? id,
        availability: sharedAvailability[id as keyof CliAvailability],
      }))}
      onLaunchAgent={() => {}}
      activeWorktreeId={null}
      cwd="/repo"
      hasWorkspace
      hasProject
    />
  );
}

// Rows are `role="option"`; their agent identity is the leading text of the
// accessible name. The pin has no test id — it is a real button, so it is found
// the way a user finds it, by its accessible name.
function agentRows(container: HTMLElement): string[] {
  const known = new Map(Object.entries(AGENT_NAMES).map(([id, name]) => [name, id]));
  return Array.from(container.querySelectorAll('[role="option"]'))
    .map((el) => el.getAttribute("aria-label")?.split(",")[0]?.trim() ?? "")
    .map((name) => known.get(name) ?? "")
    .filter(Boolean);
}

// The verb in the label states the current state, so the pin's own accessible
// name is the assertion target — no data attribute needed.
function pinFor(view: ReturnType<typeof render>, id: string): HTMLElement {
  const name = AGENT_NAMES[id] ?? id;
  const pin = view.queryByLabelText(`Pin to toolbar: ${name}`);
  const unpin = view.queryByLabelText(`Unpin from toolbar: ${name}`);
  const found = pin ?? unpin;
  if (!found) throw new Error(`no pin control for ${id}`);
  return found;
}

function isPinned(view: ReturnType<typeof render>, id: string): boolean {
  return pinFor(view, id).getAttribute("aria-pressed") === "true";
}

describe("agent pin sync — Settings > Toolbar and Agent Tray share state (#5112)", () => {
  beforeEach(() => {
    setAgentPinnedMock.mockClear();
    toggleButtonVisibilityMock.mockClear();
    dispatchMock.mockClear();
    refreshAvailabilityMock.mockClear();
    updateAgentMock.mockClear();
    updateWorktreePresetMock.mockClear();
    recordActionMruMock.mockClear();
    sharedSettings = {
      agents: {
        claude: { pinned: true },
        gemini: { pinned: false },
        codex: { pinned: false },
      },
    } as AgentSettings;
    sharedToolbarLayout = {
      leftButtons: ["launcher", "claude", "gemini", "codex", "terminal"],
      rightButtons: ["settings"],
      pinnedButtons: {},
    };
    sharedAvailability = {} as CliAvailability;
  });

  it("unpinning in Settings > Toolbar flips the tray pin indicator for that agent", () => {
    const availability = {
      claude: "ready",
      gemini: "ready",
      codex: "ready",
    } as unknown as CliAvailability;

    sharedAvailability = availability;
    const tray = renderLauncher(["claude", "gemini", "codex"]);
    expect(agentRows(tray.container)).toEqual(["claude", "gemini", "codex"]);
    expect(isPinned(tray, "claude")).toBe(true);
    tray.unmount();

    const settings = render(<ToolbarSettingsTab />);
    const claudeSwitch = settings.getByLabelText("Toggle Claude agent visibility");
    expect(claudeSwitch.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(claudeSwitch);
    expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", false);
    settings.unmount();

    const tray2 = renderLauncher(["claude", "gemini", "codex"]);
    expect(agentRows(tray2.container)).toEqual(["claude", "gemini", "codex"]);
    expect(isPinned(tray2, "claude")).toBe(false);
  });

  it("pinning in the tray makes the Settings > Toolbar checkbox flip to checked", () => {
    const availability = {
      gemini: "ready",
      codex: "ready",
    } as unknown as CliAvailability;
    sharedSettings = {
      agents: {
        claude: { pinned: true },
        gemini: { pinned: false },
        codex: { pinned: false },
      },
    } as AgentSettings;

    // Initial Settings render: gemini unchecked.
    const settings = render(<ToolbarSettingsTab />);
    const geminiSwitchA = settings.getByLabelText("Toggle Gemini agent visibility");
    expect(geminiSwitchA.getAttribute("aria-checked")).toBe("false");
    settings.unmount();

    // User clicks the pin control in the launcher for gemini.
    sharedAvailability = availability;
    const tray = renderLauncher(["gemini", "codex"]);
    fireEvent.click(pinFor(tray, "gemini"));
    expect(setAgentPinnedMock).toHaveBeenCalledWith("gemini", true);
    tray.unmount();

    // Re-render Settings — gemini is now checked because the shared store
    // picked up the tray's write.
    const settings2 = render(<ToolbarSettingsTab />);
    const geminiSwitchB = settings2.getByLabelText("Toggle Gemini agent visibility");
    expect(geminiSwitchB.getAttribute("aria-checked")).toBe("true");
  });

  it("undefined-pin agent with ready availability renders checked and toggles to false", () => {
    // Tri-state fallback (#7673): no explicit pin, ready CLI → visible.
    sharedSettings = { agents: {} } as AgentSettings;
    sharedAvailability = { claude: "ready" } as unknown as CliAvailability;

    const settings = render(<ToolbarSettingsTab />);
    const claudeSwitch = settings.getByLabelText("Toggle Claude agent visibility");
    expect(claudeSwitch.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(claudeSwitch);
    expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", false);
  });

  it("undefined-pin agent with missing availability renders unchecked and toggles to true", () => {
    sharedSettings = { agents: {} } as AgentSettings;
    sharedAvailability = { gemini: "missing" } as unknown as CliAvailability;

    const settings = render(<ToolbarSettingsTab />);
    const geminiSwitch = settings.getByLabelText("Toggle Gemini agent visibility");
    expect(geminiSwitch.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(geminiSwitch);
    expect(setAgentPinnedMock).toHaveBeenCalledWith("gemini", true);
  });

  it("Settings checkbox toggles for agent IDs never touch toolbarPreferencesStore.pinnedButtons", () => {
    const settings = render(<ToolbarSettingsTab />);
    fireEvent.click(settings.getByLabelText("Toggle Claude agent visibility"));
    fireEvent.click(settings.getByLabelText("Toggle Launcher visibility"));

    // Agent -> setAgentPinned; plain built-in -> toggleButtonVisibility.
    // `terminal` is no longer either: since #11680 it is a launcher panel button
    // and routes through `setPanelButtonOnToolbar` like the other three, so a
    // built-in that stays on the generic path is the honest subject here.
    expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", false);
    expect(toggleButtonVisibilityMock).toHaveBeenCalledTimes(1);
    expect(toggleButtonVisibilityMock).toHaveBeenCalledWith("launcher", "left");
    // Agent toggles never write pinnedButtons.
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalledWith("claude", expect.anything());
    expect(setPanelButtonOnToolbarMock).not.toHaveBeenCalled();
  });
});
