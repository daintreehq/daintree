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

// AgentTrayButton calls `useAgentSettingsStore.getState()` inside
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
    (selector: (s: { getSortedActionMruList: () => ActionFrecencyEntry[] }) => unknown) =>
      selector({ getSortedActionMruList: () => [] }),
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
  const set: ReadonlySet<string> = new Set<string>(BUILT_IN_AGENT_IDS);
  return {
    BUILT_IN_AGENT_IDS,
    BUILT_IN_AGENT_KEY_ACTIONS: BUILT_IN_AGENT_IDS.map((id) => `agent.${id}`),
    isBuiltInAgentId: (value: unknown): boolean => typeof value === "string" && set.has(value),
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

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    onKeyDown,
    className,
    ...props
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
    className?: string;
  } & React.HTMLAttributes<HTMLDivElement>) => (
    <div
      role="menuitem"
      className={className}
      onClick={(e) => onSelect?.(e as unknown as Event)}
      onKeyDown={onKeyDown}
      tabIndex={0}
      {...props}
    >
      {children}
    </div>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="menu-label">{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuShortcut: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
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
  leftButtons: ["agent-tray", "claude", "gemini", "codex", "terminal"] as string[],
  rightButtons: ["settings"] as string[],
  pinnedButtons: {} as Record<string, boolean>,
};
const sharedToolbarLauncher = { alwaysShowDevServer: false, defaultSelection: undefined };

vi.mock("@/store", () => ({
  useToolbarPreferencesStore: (
    selector: (s: {
      layout: typeof sharedToolbarLayout;
      launcher: typeof sharedToolbarLauncher;
      setLeftButtons: () => void;
      setRightButtons: () => void;
      toggleButtonVisibility: typeof toggleButtonVisibilityMock;
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
      setAlwaysShowDevServer: vi.fn(),
      setDefaultSelection: vi.fn(),
      reset: vi.fn(),
    }),
}));

vi.mock("@/hooks/usePluginToolbarButtons", () => ({
  usePluginToolbarButtons: () => ({ buttonIds: [], configs: new Map() }),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
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
  verticalListSortingStrategy: vi.fn(),
}));

vi.mock("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => "" } } }));

vi.mock("@/components/Settings/SettingsSection", () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));

vi.mock("@/components/Settings/SettingsSwitchCard", () => ({
  SettingsSwitchCard: () => null,
}));

import { AgentTrayButton } from "@/components/Layout/AgentTrayButton";
import { ToolbarSettingsTab } from "@/components/Settings/ToolbarSettingsTab";

function agentRows(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-testid^="agent-tray-row-"]'))
    .map((el) => el.getAttribute("data-testid")?.replace("agent-tray-row-", "") ?? "")
    .filter(Boolean);
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
      leftButtons: ["agent-tray", "claude", "gemini", "codex", "terminal"],
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

    const tray = render(<AgentTrayButton agentAvailability={availability} />);
    expect(agentRows(tray.container)).toEqual(["claude", "gemini", "codex"]);
    expect(tray.getByTestId("agent-tray-pin-claude").getAttribute("data-pinned")).toBe("true");
    tray.unmount();

    const settings = render(<ToolbarSettingsTab />);
    const claudeCheckbox = settings.getByLabelText(
      "Toggle Claude Agent visibility"
    ) as HTMLInputElement;
    expect(claudeCheckbox.checked).toBe(true);
    fireEvent.click(claudeCheckbox);
    expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", false);
    settings.unmount();

    const tray2 = render(<AgentTrayButton agentAvailability={availability} />);
    expect(agentRows(tray2.container)).toEqual(["claude", "gemini", "codex"]);
    expect(tray2.getByTestId("agent-tray-pin-claude").getAttribute("data-pinned")).toBe("false");
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
    const geminiCheckboxA = settings.getByLabelText(
      "Toggle Gemini Agent visibility"
    ) as HTMLInputElement;
    expect(geminiCheckboxA.checked).toBe(false);
    settings.unmount();

    // User clicks the pin indicator in the tray for gemini.
    const tray = render(<AgentTrayButton agentAvailability={availability} />);
    fireEvent.click(tray.getByTestId("agent-tray-pin-gemini"));
    expect(setAgentPinnedMock).toHaveBeenCalledWith("gemini", true);
    tray.unmount();

    // Re-render Settings — gemini is now checked because the shared store
    // picked up the tray's write.
    const settings2 = render(<ToolbarSettingsTab />);
    const geminiCheckboxB = settings2.getByLabelText(
      "Toggle Gemini Agent visibility"
    ) as HTMLInputElement;
    expect(geminiCheckboxB.checked).toBe(true);
  });

  it("undefined-pin agent with ready availability renders checked and toggles to false", () => {
    // Tri-state fallback (#7673): no explicit pin, ready CLI → visible.
    sharedSettings = { agents: {} } as AgentSettings;
    sharedAvailability = { claude: "ready" } as unknown as CliAvailability;

    const settings = render(<ToolbarSettingsTab />);
    const claudeCheckbox = settings.getByLabelText(
      "Toggle Claude Agent visibility"
    ) as HTMLInputElement;
    expect(claudeCheckbox.checked).toBe(true);
    fireEvent.click(claudeCheckbox);
    expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", false);
  });

  it("undefined-pin agent with missing availability renders unchecked and toggles to true", () => {
    sharedSettings = { agents: {} } as AgentSettings;
    sharedAvailability = { gemini: "missing" } as unknown as CliAvailability;

    const settings = render(<ToolbarSettingsTab />);
    const geminiCheckbox = settings.getByLabelText(
      "Toggle Gemini Agent visibility"
    ) as HTMLInputElement;
    expect(geminiCheckbox.checked).toBe(false);
    fireEvent.click(geminiCheckbox);
    expect(setAgentPinnedMock).toHaveBeenCalledWith("gemini", true);
  });

  it("Settings checkbox toggles for agent IDs never touch toolbarPreferencesStore.pinnedButtons", () => {
    const settings = render(<ToolbarSettingsTab />);
    fireEvent.click(settings.getByLabelText("Toggle Claude Agent visibility"));
    fireEvent.click(settings.getByLabelText("Toggle Terminal visibility"));

    // Agent -> setAgentPinned; non-agent -> toggleButtonVisibility.
    expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", false);
    expect(toggleButtonVisibilityMock).toHaveBeenCalledTimes(1);
    expect(toggleButtonVisibilityMock).toHaveBeenCalledWith("terminal", "left");
    // Agent toggles never write pinnedButtons.
    expect(toggleButtonVisibilityMock).not.toHaveBeenCalledWith("claude", expect.anything());
  });
});
