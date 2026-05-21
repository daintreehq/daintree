// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import type { AgentSettings, CliAvailability } from "@shared/types";
import type { ActionFrecencyEntry } from "@shared/types/actions";

const dispatchMock = vi.fn();
const setAgentPinnedMock = vi.fn().mockResolvedValue(undefined);
const updateWorktreePresetMock = vi.fn().mockResolvedValue(undefined);
const updateAgentMock = vi.fn().mockResolvedValue(undefined);
const setFocusedMock = vi.fn();
const refreshAvailabilityMock = vi.fn().mockResolvedValue(undefined);
let openChangeSpy: ((open: boolean) => void) | null = null;
let tooltipOpenChangeSpy: ((open: boolean) => void) | null = null;
let capturedTooltipOpen: boolean | undefined = undefined;
let closeAutoFocusSpy: ((e: { preventDefault: () => void }) => void) | null = null;
let pointerDownOutsideSpy: (() => void) | null = null;

let mockSettings: AgentSettings | null = null;
let mockPanelsById: Record<string, unknown> = {};
let mockPanelIds: string[] = [];
let mockActiveWorktreeId: string | null = null;
let mockHasRealData = true;
let mockActionMruList: string[] = [];

const markAgentsSeenMock = vi.fn().mockResolvedValue(undefined);
const recordAgentFirstSeenMock = vi.fn().mockResolvedValue(undefined);
const dismissWelcomeCardMock = vi.fn().mockResolvedValue(undefined);
const dismissSetupBannerMock = vi.fn().mockResolvedValue(undefined);
let mockSeenAgentIds: string[] = [];
let mockAvailabilityFirstSeen: Record<string, number> = {};
let mockWelcomeCardDismissed = true;
const mockSetupBannerDismissed = true;
let mockOnboardingLoaded = true;

const TEST_NEW_AGENT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

vi.mock("@/hooks/app/useAgentDiscoveryOnboarding", () => ({
  NEW_AGENT_TTL_MS: 14 * 24 * 60 * 60 * 1000,
  useAgentDiscoveryOnboarding: () => ({
    loaded: mockOnboardingLoaded,
    seenAgentIds: mockSeenAgentIds,
    availabilityFirstSeen: mockAvailabilityFirstSeen,
    welcomeCardDismissed: mockWelcomeCardDismissed,
    setupBannerDismissed: mockSetupBannerDismissed,
    markAgentsSeen: markAgentsSeenMock,
    recordAgentFirstSeen: recordAgentFirstSeenMock,
    dismissWelcomeCard: dismissWelcomeCardMock,
    dismissSetupBanner: dismissSetupBannerMock,
  }),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

type MockAgentStoreState = {
  settings: AgentSettings | null;
  setAgentPinned: typeof setAgentPinnedMock;
  updateWorktreePreset: typeof updateWorktreePresetMock;
};

vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: Object.assign(
    (selector: (s: MockAgentStoreState) => unknown) =>
      selector({
        settings: mockSettings,
        setAgentPinned: setAgentPinnedMock,
        updateWorktreePreset: updateWorktreePresetMock,
      }),
    {
      getState: () => ({
        updateAgent: updateAgentMock,
      }),
    }
  ),
}));

const recordActionMruMock = vi.fn();

vi.mock("@/store/actionMruStore", () => ({
  useActionMruStore: Object.assign(
    (selector: (s: { getSortedActionMruList: () => ActionFrecencyEntry[] }) => unknown) =>
      selector({
        getSortedActionMruList: () =>
          mockActionMruList.map((id) => ({
            id,
            score: mockActionMruList.length - mockActionMruList.indexOf(id),
            lastAccessedAt: Date.now(),
          })),
      }),
    {
      getState: () => ({
        recordActionMru: recordActionMruMock,
      }),
    }
  ),
}));

type MockCliAvailabilityStoreState = {
  refresh: typeof refreshAvailabilityMock;
  hasRealData: boolean;
};

vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: (selector: (s: MockCliAvailabilityStoreState) => unknown) =>
    selector({ refresh: refreshAvailabilityMock, hasRealData: mockHasRealData }),
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      panelsById: mockPanelsById,
      panelIds: mockPanelIds,
      setFocused: setFocusedMock,
    }),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (selector: (s: { activeWorktreeId: string | null }) => unknown) =>
    selector({ activeWorktreeId: mockActiveWorktreeId }),
}));

let mockKeybindingDisplay: Record<string, string | null> = {};

vi.mock("@/hooks", () => ({
  useKeybindingDisplay: (actionId: string) => mockKeybindingDisplay[actionId] ?? null,
  useAriaKeyshortcuts: () => undefined,
}));

vi.mock("@/components/KeyboardShortcuts", () => ({
  AgentShortcutCapture: ({
    agentId,
    onCapture,
    onCancel,
  }: {
    agentId: string;
    onCapture: (combo: string) => void;
    onCancel: () => void;
  }) => (
    <div data-testid={`mock-agent-shortcut-capture-${agentId}`}>
      <button
        data-testid={`mock-agent-shortcut-save-${agentId}`}
        onClick={() => onCapture("Cmd+Alt+K")}
      >
        Save Mock
      </button>
      <button data-testid={`mock-agent-shortcut-cancel-${agentId}`} onClick={() => onCancel()}>
        Cancel Mock
      </button>
    </div>
  ),
}));

let mockCcrPresetsByAgent: Record<string, Array<{ id: string; name: string }>> = {};
let mockMergedPresetsFn: (
  agentId: string
) => Array<{ id: string; name: string; color?: string }> = () => [];

vi.mock("@/store/ccrPresetsStore", () => ({
  useCcrPresetsStore: (
    selector: (s: { ccrPresetsByAgent: Record<string, unknown[]> }) => unknown
  ) => selector({ ccrPresetsByAgent: mockCcrPresetsByAgent }),
}));

vi.mock("@/store/projectPresetsStore", () => ({
  useProjectPresetsStore: (
    selector: (s: { presetsByAgent: Record<string, unknown[]> }) => unknown
  ) => selector({ presetsByAgent: {} }),
}));

vi.mock("@shared/config/agentIds", () => ({
  BUILT_IN_AGENT_IDS: ["claude", "gemini", "codex"] as const,
}));

vi.mock("@/config/agents", () => ({
  getAgentConfig: (id: string) => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    icon: (props: { brandColor?: string }) => (
      <span data-testid={`agent-icon-${id}`} data-brand={props.brandColor} />
    ),
  }),
  getMergedPresets: (agentId: string) => mockMergedPresetsFn(agentId),
}));

vi.mock("@/lib/colorUtils", () => ({
  getBrandColorHex: (id: string) => `#brand-${id}`,
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="context-menu-content">{children}</div>
  ),
  ContextMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
  }) => (
    <div role="menuitem" onClick={(e) => onSelect?.(e as unknown as Event)}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => {
    openChangeSpy = onOpenChange ?? null;
    return <div>{children}</div>;
  },
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({
    children,
    onCloseAutoFocus,
    onPointerDownOutside,
  }: {
    children: React.ReactNode;
    onCloseAutoFocus?: (e: { preventDefault: () => void }) => void;
    onPointerDownOutside?: () => void;
  }) => {
    closeAutoFocusSpy = onCloseAutoFocus ?? null;
    pointerDownOutsideSpy = onPointerDownOutside ?? null;
    return <div data-testid="dropdown-content">{children}</div>;
  },
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
  DropdownMenuRadioGroup: ({ children, value }: { children: React.ReactNode; value?: string }) => (
    <div data-testid="preset-radio-group" data-value={value ?? ""}>
      {children}
    </div>
  ),
  DropdownMenuRadioItem: ({
    children,
    onSelect,
    value,
    className,
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
    value: string;
    className?: string;
  }) => (
    <div
      role="menuitemradio"
      data-testid="preset-radio-item"
      data-value={value}
      className={className}
      onClick={(e) => onSelect?.(e as unknown as Event)}
    >
      {children}
    </div>
  ),
  DropdownMenuSeparator: () => <hr data-testid="menu-separator" />,
  DropdownMenuShortcut: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="menu-shortcut">{children}</span>
  ),
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({
    children,
    onKeyDown,
    className,
    ...rest
  }: {
    children: React.ReactNode;
    onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
    className?: string;
  } & React.HTMLAttributes<HTMLDivElement>) => (
    <div
      data-testid="submenu-trigger"
      role="menuitem"
      aria-haspopup="menu"
      tabIndex={0}
      className={className}
      onKeyDown={onKeyDown}
      {...rest}
    >
      {children}
    </div>
  ),
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="submenu-content">{children}</div>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => {
    tooltipOpenChangeSpy = onOpenChange ?? null;
    capturedTooltipOpen = open;
    return <>{children}</>;
  },
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    size,
    ...props
  }: {
    children: React.ReactNode;
    size?: string;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button data-size={size} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("lucide-react", () => ({
  Check: ({ className }: { className?: string }) => (
    <span data-testid="check-icon" data-classname={className} />
  ),
  Circle: ({ className }: { className?: string }) => (
    <span data-testid="circle-icon" data-classname={className} />
  ),
  CheckCircle2: ({ className }: { className?: string }) => (
    <span data-testid="check-circle2-icon" data-classname={className} />
  ),
  Plug: () => <span data-testid="plug-icon" />,
  Pin: ({ className }: { className?: string; strokeWidth?: number }) => (
    <span data-testid="pin-icon" data-classname={className} />
  ),
  Plus: () => <span data-testid="plus-icon" />,
  Settings2: () => <span data-testid="settings2-icon" />,
  ChevronRight: () => <span data-testid="chevron-right-icon" />,
  Keyboard: () => <span data-testid="keyboard-icon" />,
  Unplug: () => <span data-testid="unplug-icon" />,
}));

import { AgentTrayButton } from "../AgentTrayButton";

function settingsWith(
  overrides: Record<
    string,
    { pinned?: boolean; presetId?: string; worktreePresets?: Record<string, string> }
  >
): AgentSettings {
  return { agents: overrides } as unknown as AgentSettings;
}

function agentRows(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-testid^="agent-tray-row-"]'))
    .map((el) => el.getAttribute("data-testid")?.replace("agent-tray-row-", "") ?? "")
    .filter(Boolean);
}

describe("AgentTrayButton", () => {
  beforeEach(() => {
    dispatchMock.mockClear();
    setAgentPinnedMock.mockClear();
    updateWorktreePresetMock.mockClear();
    updateAgentMock.mockClear();
    setFocusedMock.mockClear();
    refreshAvailabilityMock.mockClear();
    openChangeSpy = null;
    tooltipOpenChangeSpy = null;
    capturedTooltipOpen = undefined;
    closeAutoFocusSpy = null;
    pointerDownOutsideSpy = null;
    mockSettings = null;
    mockPanelsById = {};
    mockPanelIds = [];
    mockActiveWorktreeId = null;
    mockHasRealData = true;
    mockActionMruList = [];
    markAgentsSeenMock.mockClear();
    recordAgentFirstSeenMock.mockClear();
    recordActionMruMock.mockClear();
    dismissWelcomeCardMock.mockClear();
    mockSeenAgentIds = [];
    mockAvailabilityFirstSeen = {};
    mockWelcomeCardDismissed = true;
    mockOnboardingLoaded = true;
    mockCcrPresetsByAgent = {};
    mockMergedPresetsFn = () => [];
    mockKeybindingDisplay = {};
  });

  afterEach(() => {
    // jsdom's default `visibilityState` is "visible"; tests that mutate it via
    // defineProperty can bleed state between files, so reset explicitly.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  it("renders the plug trigger with accessible label", () => {
    const { getByLabelText, getAllByTestId } = render(<AgentTrayButton />);
    expect(getByLabelText("Agent tray")).toBeTruthy();
    expect(getAllByTestId("plug-icon").length).toBeGreaterThan(0);
  });

  it("lists all ready agents in the Launch section regardless of pin state", () => {
    const availability = {
      claude: "ready",
      gemini: "ready",
      codex: "ready",
    } as unknown as CliAvailability;
    mockSettings = settingsWith({
      claude: { pinned: true },
      gemini: { pinned: false },
    });

    const { container, getAllByTestId, getByTestId } = render(
      <AgentTrayButton agentAvailability={availability} />
    );

    const labels = getAllByTestId("menu-label").map((el) => el.textContent);
    expect(labels).toContain("Launch");

    expect(agentRows(container)).toEqual(["claude", "gemini", "codex"]);
    expect(getByTestId("agent-tray-pin-claude").getAttribute("data-pinned")).toBe("true");
    expect(getByTestId("agent-tray-pin-gemini").getAttribute("data-pinned")).toBe("false");
  });

  it("still renders the Launch section when every ready agent is pinned", () => {
    const availability = {
      claude: "ready",
      gemini: "ready",
      codex: "ready",
    } as unknown as CliAvailability;
    mockSettings = settingsWith({
      claude: { pinned: true },
      gemini: { pinned: true },
      codex: { pinned: true },
    });

    const { container, getAllByTestId } = render(
      <AgentTrayButton agentAvailability={availability} />
    );

    expect(agentRows(container)).toEqual(["claude", "gemini", "codex"]);
    const labels = getAllByTestId("menu-label").map((el) => el.textContent);
    expect(labels).toContain("Launch");
  });

  it("sorts the Launch section by palette MRU", () => {
    const availability = {
      claude: "ready",
      gemini: "ready",
      codex: "ready",
    } as unknown as CliAvailability;
    mockSettings = settingsWith({});
    mockActionMruList = ["agent.codex", "agent.claude"];

    const { container } = render(<AgentTrayButton agentAvailability={availability} />);

    // codex most recent, claude next, gemini untracked -> pushed to the end.
    expect(agentRows(container)).toEqual(["codex", "claude", "gemini"]);
  });

  it("preserves natural order when the MRU list is empty", () => {
    const availability = {
      claude: "ready",
      gemini: "ready",
      codex: "ready",
    } as unknown as CliAvailability;
    mockSettings = settingsWith({});
    mockActionMruList = [];

    const { container } = render(<AgentTrayButton agentAvailability={availability} />);

    expect(agentRows(container)).toEqual(["claude", "gemini", "codex"]);
  });

  it("dispatches agent.launch when no active session exists", () => {
    const availability = { gemini: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ gemini: { pinned: false } });

    const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    fireEvent.click(getByTestId("agent-tray-row-gemini"));

    expect(dispatchMock).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "gemini" },
      { source: "user" }
    );
  });

  it("always launches a new session even when agent already has one running", () => {
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: false } });
    mockPanelsById = {
      "panel-1": {
        id: "panel-1",
        kind: "terminal",
        agentId: "claude",
        worktreeId: "wt-1",
        location: "grid",
        agentState: "working",
      },
    };
    mockPanelIds = ["panel-1"];
    mockActiveWorktreeId = "wt-1";

    const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    fireEvent.click(getByTestId("agent-tray-row-claude"));

    expect(dispatchMock).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "claude" },
      { source: "user" }
    );
    expect(setFocusedMock).not.toHaveBeenCalled();
  });

  it("renders a hollow pin indicator on unpinned Launch rows", () => {
    // Unpinned rows should read as `data-pinned="false"` and be clickable
    // to promote to pinned.
    const availability = {
      gemini: "ready",
      codex: "ready",
    } as unknown as CliAvailability;
    mockSettings = settingsWith({
      gemini: { pinned: false },
      codex: { pinned: false },
    });

    const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    expect(getByTestId("agent-tray-pin-gemini").getAttribute("data-pinned")).toBe("false");
    expect(getByTestId("agent-tray-pin-codex").getAttribute("data-pinned")).toBe("false");
  });

  it("clicking the pin indicator promotes an unpinned agent without launching", () => {
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: false } });

    const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    fireEvent.click(getByTestId("agent-tray-pin-claude"));

    expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", true);
    expect(dispatchMock).not.toHaveBeenCalledWith(
      "agent.launch",
      expect.anything(),
      expect.anything()
    );
  });

  it("pressing P on a focused row toggles pin", () => {
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: false } });

    const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    fireEvent.keyDown(getByTestId("agent-tray-row-claude"), { key: "P" });
    expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", true);
  });

  it("treats missing pinned entries as unpinned (opt-in, issue #5158)", () => {
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({});

    const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    // Missing entry no longer implies pinned — the renderer normalizer is
    // responsible for synthesizing `pinned: true` when the CLI is installed,
    // and the tray reads from the normalized store. A raw entry without
    // `pinned` should read as unpinned.
    expect(getByTestId("agent-tray-pin-claude").getAttribute("data-pinned")).toBe("false");
  });

  it("only puts installed-but-unauth agents in Needs Setup (missing agents are hidden)", () => {
    const availability = {
      claude: "ready",
      gemini: "missing",
      codex: "installed",
    } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: true } });

    const { container, getAllByTestId } = render(
      <AgentTrayButton agentAvailability={availability} />
    );

    const labels = getAllByTestId("menu-label").map((el) => el.textContent);
    expect(labels).toContain("Needs Setup");

    const setupItems = Array.from(container.querySelectorAll('[role="menuitem"]')).filter(
      (el) =>
        el.textContent?.includes("Setup") &&
        !el.textContent.includes("Manage") &&
        !el.textContent.includes("Customize")
    );
    // Only codex (installed) belongs in Needs Setup. Gemini (missing) must NOT appear.
    expect(setupItems.length).toBe(1);
    expect(setupItems[0]!.textContent).toContain("Codex");
    const allText = container.textContent ?? "";
    expect(allText).not.toMatch(/Needs Setup[\s\S]*Gemini/);
  });

  it("dispatches settings with subtab when a Needs-Setup row is clicked", () => {
    const availability = {
      claude: "ready",
      gemini: "installed",
    } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: true } });

    const { container, getAllByTestId } = render(
      <AgentTrayButton agentAvailability={availability} />
    );
    // Sanity check: this must be the Needs-Setup branch, not the fallback.
    const labels = getAllByTestId("menu-label").map((el) => el.textContent);
    expect(labels).toContain("Needs Setup");

    const setupItem = Array.from(container.querySelectorAll('[role="menuitem"]')).find((el) =>
      el.textContent?.includes("Gemini")
    );
    fireEvent.click(setupItem!);

    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "agents", subtab: "gemini" },
      { source: "user" }
    );
  });

  it("shows Customize Toolbar footer", () => {
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: true } });

    const { container } = render(<AgentTrayButton agentAvailability={availability} />);
    const footer = Array.from(container.querySelectorAll('[role="menuitem"]')).find((el) =>
      el.textContent?.includes("Customize Toolbar")
    );
    expect(footer).toBeTruthy();
    fireEvent.click(footer!);
    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "toolbar" },
      { source: "user" }
    );
  });

  it("shows loading placeholder when availability is undefined", () => {
    mockSettings = settingsWith({ claude: { pinned: true } });
    const { getByText } = render(<AgentTrayButton />);
    expect(getByText("Checking agents…")).toBeTruthy();
  });

  it("shows loading placeholder before hasRealData even if availability is supplied", () => {
    mockHasRealData = false;
    const { getByText, queryByTestId } = render(
      <AgentTrayButton agentAvailability={{} as unknown as CliAvailability} />
    );
    expect(getByText("Checking agents…")).toBeTruthy();
    // Fallback rows must not render during the initial probe.
    expect(queryByTestId("agent-tray-fallback-claude")).toBeNull();
  });

  it("shows fallback setup rows when data has loaded but nothing is installed", () => {
    mockHasRealData = true;
    const availability = {
      claude: "missing",
      gemini: "missing",
      codex: "missing",
    } as unknown as CliAvailability;

    const { queryByText, getByTestId, getAllByTestId } = render(
      <AgentTrayButton agentAvailability={availability} />
    );
    // Should NOT show the old dead-end message.
    expect(queryByText("No agents available")).toBeNull();
    // Every built-in shows up as a setup row so the user can still discover them.
    expect(getByTestId("agent-tray-fallback-claude")).toBeTruthy();
    expect(getByTestId("agent-tray-fallback-gemini")).toBeTruthy();
    expect(getByTestId("agent-tray-fallback-codex")).toBeTruthy();
    const labels = getAllByTestId("menu-label").map((el) => el.textContent);
    expect(labels).toContain("Available Agents");
  });

  it("triggers a refresh when the dropdown opens", () => {
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: true } });

    render(<AgentTrayButton agentAvailability={availability} />);
    expect(openChangeSpy).toBeTruthy();
    refreshAvailabilityMock.mockClear();

    openChangeSpy!(true);
    expect(refreshAvailabilityMock).toHaveBeenCalledTimes(1);

    // Closing must not trigger another refresh.
    openChangeSpy!(false);
    expect(refreshAvailabilityMock).toHaveBeenCalledTimes(1);
  });

  it("triggers a refresh on document visibilitychange when visible", () => {
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: true } });

    const { unmount } = render(<AgentTrayButton agentAvailability={availability} />);
    refreshAvailabilityMock.mockClear();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refreshAvailabilityMock).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refreshAvailabilityMock).toHaveBeenCalledTimes(1);

    // Unmount must detach the listener so stale components can't refresh.
    unmount();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refreshAvailabilityMock).toHaveBeenCalledTimes(1);
  });

  it("renders a Manage Agents… footer that opens the agents settings tab", () => {
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: true } });

    const { container } = render(<AgentTrayButton agentAvailability={availability} />);
    const manage = Array.from(container.querySelectorAll('[role="menuitem"]')).find((el) =>
      el.textContent?.includes("Manage Agents")
    );
    expect(manage).toBeTruthy();
    fireEvent.click(manage!);
    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "agents" },
      { source: "user" }
    );
  });

  it("renders a Set Up Agents footer that dispatches the wizard custom event", () => {
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: true } });

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const { container } = render(<AgentTrayButton agentAvailability={availability} />);
    const setup = Array.from(container.querySelectorAll('[role="menuitem"]')).find((el) =>
      el.textContent?.includes("Set Up Agents")
    );
    expect(setup).toBeTruthy();
    fireEvent.click(setup!);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "daintree:open-agent-setup-wizard",
      })
    );
    dispatchSpy.mockRestore();
  });

  it("handles null store settings gracefully (opt-in default)", () => {
    mockSettings = null;
    const availability = { claude: "ready" } as unknown as CliAvailability;

    const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    // Null settings means the normalizer hasn't run yet — with opt-in
    // semantics, that reads as unpinned until real data arrives.
    expect(getByTestId("agent-tray-pin-claude").getAttribute("data-pinned")).toBe("false");
  });

  it("suppresses tooltip reopen across dropdown and dialog focus restoration (issue #5153)", () => {
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: true } });
    mockSeenAgentIds = ["claude"];

    const { getByLabelText } = render(<AgentTrayButton agentAvailability={availability} />);
    expect(tooltipOpenChangeSpy).toBeTruthy();
    expect(closeAutoFocusSpy).toBeTruthy();

    const button = getByLabelText("Agent tray");

    // Hover opens the tooltip.
    act(() => {
      tooltipOpenChangeSpy!(true);
    });
    expect(capturedTooltipOpen).toBe(true);

    // Dropdown opens — handleOpenChange forces the tooltip closed.
    act(() => {
      openChangeSpy!(true);
    });
    expect(capturedTooltipOpen).toBe(false);

    // Dropdown closes; Radix tries to restore focus which would normally
    // re-fire Tooltip.onOpenChange(true). The suppression ref must gate it.
    act(() => {
      closeAutoFocusSpy!({ preventDefault: vi.fn() });
      tooltipOpenChangeSpy!(true);
    });
    expect(capturedTooltipOpen).toBe(false);

    // Suppression must persist across an arbitrary delay — a menu item like
    // "Customise Toolbar" opens an AppDialog whose own restoreFocus fires
    // when the user later closes it. A timer-based clear races this.
    act(() => {
      tooltipOpenChangeSpy!(true);
    });
    expect(capturedTooltipOpen).toBe(false);

    // A genuine pointer hover on the button re-arms the tooltip.
    act(() => {
      fireEvent.pointerEnter(button);
      tooltipOpenChangeSpy!(true);
    });
    expect(capturedTooltipOpen).toBe(true);
  });

  it("does not call preventDefault on keyboard close (preserves a11y focus return for issue #6119)", () => {
    // No preceding onPointerDownOutside means the close source is keyboard
    // (Escape/Enter); WAI-ARIA requires focus to return to the trigger.
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: true } });

    render(<AgentTrayButton agentAvailability={availability} />);
    expect(closeAutoFocusSpy).toBeTruthy();

    const preventDefault = vi.fn();
    closeAutoFocusSpy!({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("calls preventDefault on pointer close so the trigger does not keep its focus ring (issue #6119)", () => {
    // Pointer-driven dismissal must suppress focus restoration to the trigger;
    // otherwise Radix re-focuses it and :focus-visible repaints the accent
    // ring even though the user clicked elsewhere.
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: true } });

    render(<AgentTrayButton agentAvailability={availability} />);
    expect(closeAutoFocusSpy).toBeTruthy();
    expect(pointerDownOutsideSpy).toBeTruthy();

    pointerDownOutsideSpy!();
    const preventDefault = vi.fn();
    closeAutoFocusSpy!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("does not preventDefault on a subsequent keyboard close after a prior pointer close (issue #6119)", () => {
    // The pointer flag must reset after one onCloseAutoFocus or a later
    // keyboard-driven close would inherit suppression from the prior dismissal
    // and break focus return.
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: true } });

    render(<AgentTrayButton agentAvailability={availability} />);
    expect(closeAutoFocusSpy).toBeTruthy();
    expect(pointerDownOutsideSpy).toBeTruthy();

    pointerDownOutsideSpy!();
    closeAutoFocusSpy!({ preventDefault: vi.fn() });

    const preventDefault = vi.fn();
    closeAutoFocusSpy!({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  // --- Discovery badge (#5111) ---

  it("shows a discovery badge dot when a ready agent has not been seen", () => {
    const availability = {
      claude: "ready",
      gemini: "ready",
    } as unknown as CliAvailability;
    mockSettings = settingsWith({});
    mockWelcomeCardDismissed = true;
    mockSeenAgentIds = ["gemini"];

    const { getByTestId, queryByTestId } = render(
      <AgentTrayButton agentAvailability={availability} />
    );
    expect(getByTestId("agent-tray-discovery-badge").getAttribute("data-visible")).toBe("true");
    expect(queryByTestId("agent-tray-new-pill-claude")).toBeTruthy();
    expect(queryByTestId("agent-tray-new-pill-gemini")).toBeNull();
  });

  it("suppresses the discovery badge while the welcome card is actually renderable", () => {
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({});
    mockWelcomeCardDismissed = false;
    mockSeenAgentIds = [];

    const { getByTestId, queryByTestId } = render(
      <AgentTrayButton agentAvailability={availability} />
    );
    expect(getByTestId("agent-tray-discovery-badge").getAttribute("data-visible")).toBe("false");
    expect(queryByTestId("agent-tray-new-pill-claude")).toBeNull();
  });

  it("shows the discovery badge when a pinned agent exists even if welcomeCardDismissed is false", () => {
    // Regression: users who pin via Settings or elsewhere never flip
    // `welcomeCardDismissed`. The badge used to stay permanently suppressed
    // for those users. Suppression must gate on whether the card would
    // actually render, not on the dismiss flag in isolation.
    const availability = {
      claude: "ready",
      gemini: "ready",
    } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: true } });
    mockWelcomeCardDismissed = false;
    mockSeenAgentIds = ["claude"];

    const { queryByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    expect(queryByTestId("agent-tray-discovery-badge")).toBeTruthy();
    expect(queryByTestId("agent-tray-new-pill-gemini")).toBeTruthy();
  });

  it("hides the discovery badge once all ready agents are in seenAgentIds", () => {
    const availability = { claude: "ready", gemini: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({});
    mockWelcomeCardDismissed = true;
    mockSeenAgentIds = ["claude", "gemini"];

    const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    expect(getByTestId("agent-tray-discovery-badge").getAttribute("data-visible")).toBe("false");
  });

  it("does not call markAgentsSeen on tray open — discovery is now per-launch", () => {
    // Regression for #8177: opening the dropdown used to burn the NEW dot
    // for every ready agent at once. The signal must survive until the
    // user actually launches one.
    const availability = { claude: "ready", gemini: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({});
    mockWelcomeCardDismissed = true;
    mockSeenAgentIds = [];

    render(<AgentTrayButton agentAvailability={availability} />);
    expect(openChangeSpy).toBeTruthy();
    markAgentsSeenMock.mockClear();

    openChangeSpy!(true);
    expect(markAgentsSeenMock).not.toHaveBeenCalled();
  });

  it("records availabilityFirstSeen for all ready agents on tray open", () => {
    // Tray open is the canonical "user could now see this agent" moment, so
    // it anchors the TTL window. The IPC is idempotent server-side; the hook
    // only writes timestamps for ids that aren't already recorded.
    const availability = { claude: "ready", gemini: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({});
    mockWelcomeCardDismissed = true;
    mockSeenAgentIds = [];

    render(<AgentTrayButton agentAvailability={availability} />);
    recordAgentFirstSeenMock.mockClear();

    openChangeSpy!(true);
    expect(recordAgentFirstSeenMock).toHaveBeenCalledTimes(1);
    const [ids] = recordAgentFirstSeenMock.mock.calls[0] as [string[]];
    expect(ids.sort()).toEqual(["claude", "gemini"]);
  });

  it("does not call recordAgentFirstSeen when no agents are ready on tray open", () => {
    const availability = {
      claude: "missing",
      gemini: "missing",
    } as unknown as CliAvailability;
    mockSettings = settingsWith({});

    render(<AgentTrayButton agentAvailability={availability} />);
    recordAgentFirstSeenMock.mockClear();

    openChangeSpy!(true);
    expect(recordAgentFirstSeenMock).not.toHaveBeenCalled();
  });

  it("launching an agent calls markAgentsSeen with only that agent id", () => {
    const availability = { claude: "ready", gemini: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({});
    mockSeenAgentIds = [];

    const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    markAgentsSeenMock.mockClear();

    fireEvent.click(getByTestId("agent-tray-row-claude"));

    expect(markAgentsSeenMock).toHaveBeenCalledTimes(1);
    expect(markAgentsSeenMock).toHaveBeenCalledWith(["claude"]);
  });

  it("launching an agent records palette MRU so the sort reflects tray usage", () => {
    // Regression for #8177: ActionService.dispatch does not auto-record MRU,
    // so without an explicit recordActionMru call the tray's MRU-based sort
    // never reflects tray launches.
    const availability = { codex: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({});

    const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    recordActionMruMock.mockClear();

    fireEvent.click(getByTestId("agent-tray-row-codex"));

    expect(recordActionMruMock).toHaveBeenCalledTimes(1);
    expect(recordActionMruMock).toHaveBeenCalledWith("agent.codex");
  });

  it("decays the NEW dot for agents first seen more than the TTL ago", () => {
    const availability = { claude: "ready", gemini: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({});
    mockWelcomeCardDismissed = true;
    mockSeenAgentIds = [];
    const now = Date.now();
    mockAvailabilityFirstSeen = {
      // Past the TTL by 1ms — must NOT show the NEW dot.
      claude: now - TEST_NEW_AGENT_TTL_MS - 1,
      // Inside the TTL window — must still show the NEW dot.
      gemini: now - 1000,
    };

    const { queryByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    expect(queryByTestId("agent-tray-new-pill-claude")).toBeNull();
    expect(queryByTestId("agent-tray-new-pill-gemini")).toBeTruthy();
  });

  it("renders the NEW indicator as a screen-reader-paired dot rather than a text pill", () => {
    // #8177: unify with the trigger badge — dot is aria-hidden, screen
    // readers get "New" via the adjacent sr-only span. No visible "NEW" text.
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({});
    mockSeenAgentIds = [];

    const { getByTestId, container } = render(<AgentTrayButton agentAvailability={availability} />);
    const dot = getByTestId("agent-tray-new-pill-claude");
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(dot.textContent ?? "").toBe("");
    expect(dot.className).toContain("rounded-full");
    expect(dot.className).toContain("bg-status-info");

    // Screen reader pairing: the row should expose "New" via an sr-only sibling.
    const row = container.querySelector(
      '[data-testid="agent-tray-row-claude"]'
    ) as HTMLElement | null;
    expect(row).toBeTruthy();
    const srOnly = Array.from(row!.querySelectorAll(".sr-only")).map((el) =>
      el.textContent?.trim()
    );
    expect(srOnly).toContain("New");
  });

  it("renders the NEW dot inside the SplitLaunchItem trigger when the agent has presets", () => {
    // Regression for #8177: agents with presets route through SplitLaunchItem
    // (not LaunchRow). The dot must surface there too, or the most visible
    // agents get no per-row discovery indicator.
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({});
    mockSeenAgentIds = [];
    mockMergedPresetsFn = (agentId: string) =>
      agentId === "claude" ? [{ id: "user-alpha", name: "Alpha" }] : [];

    const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    const dot = getByTestId("agent-tray-new-pill-claude");
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(dot.className).toContain("rounded-full");
    expect(dot.className).toContain("bg-status-info");
  });

  it("clears the NEW dot when the agent is launched via the SplitLaunchItem trigger", () => {
    // Pressing Enter on the SubTrigger goes through onLaunch → handleLaunch,
    // which now fires markAgentsSeen([agentId]) per-launch.
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({});
    mockSeenAgentIds = [];
    mockMergedPresetsFn = (agentId: string) =>
      agentId === "claude" ? [{ id: "user-alpha", name: "Alpha" }] : [];

    const { getAllByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    markAgentsSeenMock.mockClear();
    fireEvent.keyDown(getAllByTestId("submenu-trigger")[0]!, { key: "Enter" });

    expect(markAgentsSeenMock).toHaveBeenCalledTimes(1);
    expect(markAgentsSeenMock).toHaveBeenCalledWith(["claude"]);
  });

  it("pinned rows render the pin icon muted until the row is highlighted", () => {
    // #8177: the filled pin used to read as an active control. Muted until
    // hover/focus makes it clear the icon is a state marker.
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: true } });

    const { container } = render(<AgentTrayButton agentAvailability={availability} />);
    const claudeRow = container.querySelector(
      '[data-testid="agent-tray-row-claude"]'
    ) as HTMLElement | null;
    expect(claudeRow).toBeTruthy();
    const pinIcon = claudeRow!.querySelector('[data-testid="pin-icon"]') as HTMLElement | null;
    expect(pinIcon).toBeTruthy();
    const classes = pinIcon!.getAttribute("data-classname") ?? "";
    expect(classes).toContain("text-daintree-text/40");
    expect(classes).toContain("group-data-[highlighted]:text-daintree-text");
  });

  it("ignores panels from other worktrees for session detection", () => {
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: false } });
    mockPanelsById = {
      "panel-1": {
        id: "panel-1",
        kind: "terminal",
        agentId: "claude",
        worktreeId: "wt-other",
        location: "grid",
        agentState: "working",
      },
    };
    mockPanelIds = ["panel-1"];
    mockActiveWorktreeId = "wt-mine";

    const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    fireEvent.click(getByTestId("agent-tray-row-claude"));

    // Should launch new, not focus — panel is in a different worktree
    expect(dispatchMock).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "claude" },
      { source: "user" }
    );
    expect(setFocusedMock).not.toHaveBeenCalled();
  });

  // ── Preset split-button keyboard accessibility ────────────────────────────
  // The SplitLaunchItem in the tray dropdown must launch default on Enter,
  // not open the submenu. Without an onKeyDown interceptor on the SubTrigger,
  // Radix's default behavior opens the submenu, making the primary-launch
  // action inaccessible to keyboard users.
  describe("SplitLaunchItem keyboard accessibility", () => {
    function arrangeAgentWithPresets() {
      const availability = { claude: "ready" } as unknown as CliAvailability;
      mockSettings = settingsWith({ claude: { pinned: false } });
      mockMergedPresetsFn = (agentId: string) =>
        agentId === "claude"
          ? [
              { id: "ccr-pro", name: "CCR: Pro", color: "#e06c75" },
              { id: "user-alpha", name: "Alpha", color: "#98c379" },
            ]
          : [];
      return availability;
    }

    it("Enter on the submenu trigger launches default (presetId: null)", () => {
      const availability = arrangeAgentWithPresets();
      const { getAllByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
      const submenuTrigger = getAllByTestId("submenu-trigger")[0]!;

      fireEvent.keyDown(submenuTrigger, { key: "Enter" });

      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", presetId: null },
        { source: "user" }
      );
    });

    it("Space on the submenu trigger also launches default", () => {
      const availability = arrangeAgentWithPresets();
      const { getAllByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
      const submenuTrigger = getAllByTestId("submenu-trigger")[0]!;

      fireEvent.keyDown(submenuTrigger, { key: " " });

      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", presetId: null },
        { source: "user" }
      );
    });

    it("other keys (ArrowRight, Tab) do NOT trigger launch", () => {
      const availability = arrangeAgentWithPresets();
      const { getAllByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
      const submenuTrigger = getAllByTestId("submenu-trigger")[0]!;

      fireEvent.keyDown(submenuTrigger, { key: "ArrowRight" });
      fireEvent.keyDown(submenuTrigger, { key: "Tab" });

      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("groups CCR and custom presets when both present", () => {
      const availability = arrangeAgentWithPresets();
      const { queryAllByTestId } = render(<AgentTrayButton agentAvailability={availability} />);

      const labels = queryAllByTestId("menu-label");
      const labelTexts = labels.map((el) => el.textContent);
      expect(labelTexts).toContain("CCR Routes");
      expect(labelTexts).toContain("Custom");
    });

    it("does NOT render group labels when only one preset category is present", () => {
      const availability = { claude: "ready" } as unknown as CliAvailability;
      mockSettings = settingsWith({ claude: { pinned: false } });
      mockMergedPresetsFn = () => [{ id: "user-alpha", name: "Alpha" }];

      const { queryByText } = render(<AgentTrayButton agentAvailability={availability} />);
      expect(queryByText("CCR Routes")).toBeNull();
      expect(queryByText("Custom")).toBeNull();
    });

    it("renders the submenu trigger when agent has exactly 1 preset", () => {
      const availability = { claude: "ready" } as unknown as CliAvailability;
      mockSettings = settingsWith({ claude: { pinned: false } });
      mockMergedPresetsFn = () => [{ id: "user-alpha", name: "Alpha" }];

      const { queryAllByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
      // The submenu always includes the implicit Default entry alongside named
      // presets, so a single named preset already represents two real launch
      // choices and warrants the submenu picker.
      expect(queryAllByTestId("submenu-trigger").length).toBeGreaterThan(0);
    });
  });

  describe("worktree-scoped preset persistence", () => {
    function arrangeAgentWithPresets() {
      const availability = { claude: "ready" } as unknown as CliAvailability;
      mockSettings = settingsWith({ claude: { pinned: false } });
      mockMergedPresetsFn = (agentId: string) =>
        agentId === "claude"
          ? [
              { id: "user-alpha", name: "Alpha" },
              { id: "user-beta", name: "Beta" },
            ]
          : [];
      return availability;
    }

    it("Default keyboard launch clears the scoped override and dispatches presetId: null", () => {
      // Seed an agent-level presetId so the updateAgent assertion proves the
      // fix actually clears it — without a stale agent-level value to fall
      // through to, the original #6358 bug couldn't manifest.
      mockActiveWorktreeId = "wt-A";
      const availability = arrangeAgentWithPresets();
      mockSettings = settingsWith({
        claude: {
          pinned: false,
          presetId: "user-alpha",
          worktreePresets: { "wt-A": "user-alpha" },
        },
      });
      const { getAllByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
      const submenuTrigger = getAllByTestId("submenu-trigger")[0]!;

      fireEvent.keyDown(submenuTrigger, { key: "Enter" });

      expect(updateAgentMock).toHaveBeenCalledWith("claude", { presetId: undefined });
      expect(updateWorktreePresetMock).toHaveBeenCalledWith("claude", "wt-A", undefined);
      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", presetId: null },
        { source: "user" }
      );
    });

    it("does not persist the scope when no active worktree is set", () => {
      mockActiveWorktreeId = null;
      const availability = arrangeAgentWithPresets();
      const { getAllByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
      const submenuTrigger = getAllByTestId("submenu-trigger")[0]!;

      fireEvent.keyDown(submenuTrigger, { key: "Enter" });

      expect(updateWorktreePresetMock).not.toHaveBeenCalled();
      expect(dispatchMock).toHaveBeenCalledWith(
        "agent.launch",
        { agentId: "claude", presetId: null },
        { source: "user" }
      );
    });
  });

  describe("RunningDot status badge", () => {
    function arrangeClaudePanel(state: string) {
      const availability = { claude: "ready" } as unknown as CliAvailability;
      mockSettings = settingsWith({ claude: { pinned: false } });
      // `detectedAgentId` is what `getRuntimeOrBootAgentId` reads via
      // `deriveTerminalChrome`; plain `agentId` is ignored by the derivation.
      mockPanelsById = {
        "panel-1": {
          id: "panel-1",
          kind: "terminal",
          detectedAgentId: "claude",
          worktreeId: "wt-1",
          location: "grid",
          agentState: state,
        },
      };
      mockPanelIds = ["panel-1"];
      mockActiveWorktreeId = "wt-1";
      return availability;
    }

    function badgeIn(row: HTMLElement): Element | null {
      // The RunningDot lives inside the icon's relative-positioned wrapper —
      // the only `aria-hidden` span in a Launch row that uses this scoping.
      return row.querySelector('span.relative span[aria-hidden="true"]');
    }

    it.each([["waiting"], ["directing"]] as const)(
      "renders the badge for actionable state %s",
      (state) => {
        const availability = arrangeClaudePanel(state);
        const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
        const row = getByTestId("agent-tray-row-claude");
        expect(badgeIn(row)).not.toBeNull();
      }
    );

    it.each([["working"], ["idle"]] as const)(
      "does not render the badge for passive state %s",
      (state) => {
        const availability = arrangeClaudePanel(state);
        const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
        const row = getByTestId("agent-tray-row-claude");
        expect(badgeIn(row)).toBeNull();
      }
    );

    // `completed` and `exited` are excluded from ACTIVE_AGENT_STATES, so the
    // panel never enters the dominant-state aggregation in the first place;
    // the dot is suppressed one layer earlier than for working/idle. Covered
    // here so the consumer-level contract ("no badge for passive states") is
    // tested end-to-end regardless of which guard fires.
    it.each([["completed"], ["exited"]] as const)(
      "does not render the badge for terminal state %s",
      (state) => {
        const availability = arrangeClaudePanel(state);
        const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
        const row = getByTestId("agent-tray-row-claude");
        expect(badgeIn(row)).toBeNull();
      }
    );

    it("does not render the badge when there is no active session", () => {
      const availability = { claude: "ready" } as unknown as CliAvailability;
      mockSettings = settingsWith({ claude: { pinned: false } });

      const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
      const row = getByTestId("agent-tray-row-claude");
      expect(badgeIn(row)).toBeNull();
    });
  });

  describe("SplitLaunchItem saved-preset indicator", () => {
    function arrangeAgentWithPresets() {
      const availability = { claude: "ready" } as unknown as CliAvailability;
      mockMergedPresetsFn = (agentId: string) =>
        agentId === "claude"
          ? [
              { id: "user-alpha", name: "Alpha" },
              { id: "user-beta", name: "Beta" },
            ]
          : [];
      return availability;
    }

    it("threads the worktree-scoped saved preset id into the submenu radio group", () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({
        claude: {
          presetId: "user-alpha",
          worktreePresets: { "wt-A": "user-beta" },
        } as unknown as { pinned?: boolean },
      });
      const availability = arrangeAgentWithPresets();

      const { getAllByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
      const groups = getAllByTestId("preset-radio-group");
      // The worktree-scoped pick wins over the agent-level default — the
      // submenu radio group resolves to "user-beta".
      expect(groups[0]!.getAttribute("data-value")).toBe("user-beta");
    });

    it("falls back to the agent-level preset when no worktree override exists", () => {
      mockActiveWorktreeId = "wt-A";
      mockSettings = settingsWith({
        claude: { presetId: "user-alpha" } as unknown as { pinned?: boolean },
      });
      const availability = arrangeAgentWithPresets();

      const { getAllByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
      const groups = getAllByTestId("preset-radio-group");
      expect(groups[0]!.getAttribute("data-value")).toBe("user-alpha");
    });

    it("resolves to empty string when nothing is saved (Default armed)", () => {
      mockActiveWorktreeId = null;
      mockSettings = settingsWith({ claude: { pinned: false } });
      const availability = arrangeAgentWithPresets();

      const { getAllByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
      const groups = getAllByTestId("preset-radio-group");
      expect(groups[0]!.getAttribute("data-value")).toBe("");
    });
  });

  describe("inline keyboard shortcut assignment (issue #7703)", () => {
    const availability = {
      claude: "ready",
      gemini: "ready",
      codex: "ready",
    } as unknown as CliAvailability;

    it("renders the shortcut pill when a binding is set and the edit affordance is always present", () => {
      mockKeybindingDisplay = { "agent.claude": "⌘⌥C" };
      mockSettings = settingsWith({ claude: { pinned: false } });

      const { getByTestId, getAllByTestId } = render(
        <AgentTrayButton agentAvailability={availability} />
      );

      const shortcutNodes = getAllByTestId("menu-shortcut").map((el) => el.textContent);
      expect(shortcutNodes).toContain("⌘⌥C");
      expect(getByTestId("agent-tray-shortcut-edit-claude")).toBeTruthy();
    });

    it("renders the edit affordance without a pill when the agent is unbound", () => {
      mockKeybindingDisplay = {};
      mockSettings = settingsWith({ claude: { pinned: false } });

      const { getByTestId, queryAllByTestId } = render(
        <AgentTrayButton agentAvailability={availability} />
      );

      expect(getByTestId("agent-tray-shortcut-edit-claude")).toBeTruthy();
      const claudeRow = getByTestId("agent-tray-row-claude");
      // No menu-shortcut node inside the row when unbound.
      const shortcutsInRow = Array.from(
        claudeRow.querySelectorAll('[data-testid="menu-shortcut"]')
      );
      expect(shortcutsInRow).toHaveLength(0);
      // Other agents' edit affordances are independent.
      expect(queryAllByTestId(/agent-tray-shortcut-edit-/).length).toBeGreaterThan(1);
    });

    it("clicking the edit affordance opens the inline capture and does not launch the agent", () => {
      mockSettings = settingsWith({ claude: { pinned: false } });

      const { getByTestId, queryByTestId } = render(
        <AgentTrayButton agentAvailability={availability} />
      );

      const editButton = getByTestId("agent-tray-shortcut-edit-claude");
      fireEvent.click(editButton);

      expect(getByTestId("agent-tray-capture-claude")).toBeTruthy();
      expect(getByTestId("mock-agent-shortcut-capture-claude")).toBeTruthy();
      // The launch row for claude is replaced by the capture surface, so the
      // launch onSelect path can't fire from this row.
      expect(queryByTestId("agent-tray-row-claude")).toBeNull();
      // No agent.launch dispatch was triggered by entering capture.
      const launchDispatches = dispatchMock.mock.calls.filter((call) => call[0] === "agent.launch");
      expect(launchDispatches).toHaveLength(0);
    });

    it("dispatches keybinding.setOverride and exits capture mode on save", async () => {
      dispatchMock.mockResolvedValue({ ok: true });
      mockSettings = settingsWith({ claude: { pinned: false } });

      const { getByTestId, queryByTestId } = render(
        <AgentTrayButton agentAvailability={availability} />
      );

      fireEvent.click(getByTestId("agent-tray-shortcut-edit-claude"));
      expect(getByTestId("agent-tray-capture-claude")).toBeTruthy();

      await act(async () => {
        fireEvent.click(getByTestId("mock-agent-shortcut-save-claude"));
      });

      expect(dispatchMock).toHaveBeenCalledWith(
        "keybinding.setOverride",
        { actionId: "agent.claude", combo: ["Cmd+Alt+K"] },
        { source: "user" }
      );
      expect(queryByTestId("agent-tray-capture-claude")).toBeNull();
      expect(getByTestId("agent-tray-row-claude")).toBeTruthy();
    });

    it("Cancel from capture restores the row without dispatching anything", () => {
      mockSettings = settingsWith({ claude: { pinned: false } });

      const { getByTestId, queryByTestId } = render(
        <AgentTrayButton agentAvailability={availability} />
      );

      fireEvent.click(getByTestId("agent-tray-shortcut-edit-claude"));
      expect(getByTestId("agent-tray-capture-claude")).toBeTruthy();

      fireEvent.click(getByTestId("mock-agent-shortcut-cancel-claude"));

      expect(queryByTestId("agent-tray-capture-claude")).toBeNull();
      expect(getByTestId("agent-tray-row-claude")).toBeTruthy();
      const dispatchCalls = dispatchMock.mock.calls.filter(
        (call) => call[0] === "keybinding.setOverride"
      );
      expect(dispatchCalls).toHaveLength(0);
    });
  });
});
