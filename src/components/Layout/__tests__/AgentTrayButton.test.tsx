// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import type { AgentSettings, CliAvailability } from "@shared/types";
import type { ActionFrecencyEntry } from "@shared/types/actions";

const dispatchMock = vi.fn();
const setAgentPinnedMock = vi.fn().mockResolvedValue(undefined);
const updateWorktreePresetMock = vi.fn().mockResolvedValue(undefined);
const setFocusedMock = vi.fn();
const refreshAvailabilityMock = vi.fn().mockResolvedValue(undefined);
let openChangeSpy: ((open: boolean) => void) | null = null;
let tooltipOpenChangeSpy: ((open: boolean) => void) | null = null;
let capturedTooltipOpen: boolean | undefined = undefined;
let closeAutoFocusSpy: ((e: { preventDefault: () => void }) => void) | null = null;

let mockSettings: AgentSettings | null = null;
let mockPanelsById: Record<string, unknown> = {};
let mockPanelIds: string[] = [];
let mockActiveWorktreeId: string | null = null;
let mockHasRealData = true;
let mockActionMruList: string[] = [];

const markAgentsSeenMock = vi.fn().mockResolvedValue(undefined);
const dismissWelcomeCardMock = vi.fn().mockResolvedValue(undefined);
const dismissSetupBannerMock = vi.fn().mockResolvedValue(undefined);
let mockSeenAgentIds: string[] = [];
let mockWelcomeCardDismissed = true;
const mockSetupBannerDismissed = true;
let mockOnboardingLoaded = true;

vi.mock("@/hooks/app/useAgentDiscoveryOnboarding", () => ({
  useAgentDiscoveryOnboarding: () => ({
    loaded: mockOnboardingLoaded,
    seenAgentIds: mockSeenAgentIds,
    welcomeCardDismissed: mockWelcomeCardDismissed,
    setupBannerDismissed: mockSetupBannerDismissed,
    markAgentsSeen: markAgentsSeenMock,
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
  useAgentSettingsStore: (selector: (s: MockAgentStoreState) => unknown) =>
    selector({
      settings: mockSettings,
      setAgentPinned: setAgentPinnedMock,
      updateWorktreePreset: updateWorktreePresetMock,
    }),
}));

vi.mock("@/store/actionMruStore", () => ({
  useActionMruStore: (
    selector: (s: { getSortedActionMruList: () => ActionFrecencyEntry[] }) => unknown
  ) =>
    selector({
      getSortedActionMruList: () =>
        mockActionMruList.map((id) => ({
          id,
          score: mockActionMruList.length - mockActionMruList.indexOf(id),
          lastAccessedAt: Date.now(),
        })),
    }),
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

vi.mock("@/hooks", () => ({
  useKeybindingDisplay: () => null,
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
  }: {
    children: React.ReactNode;
    onCloseAutoFocus?: (e: { preventDefault: () => void }) => void;
  }) => {
    closeAutoFocusSpy = onCloseAutoFocus ?? null;
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
    ...props
  }: { children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("lucide-react", () => ({
  Plug: () => <span data-testid="plug-icon" />,
  Pin: ({ className }: { className?: string; strokeWidth?: number }) => (
    <span data-testid="pin-icon" data-classname={className} />
  ),
  Plus: () => <span data-testid="plus-icon" />,
  Settings2: () => <span data-testid="settings2-icon" />,
  ChevronRight: () => <span data-testid="chevron-right-icon" />,
}));

import { AgentTrayButton } from "../AgentTrayButton";

function settingsWith(overrides: Record<string, { pinned?: boolean }>): AgentSettings {
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
    setFocusedMock.mockClear();
    refreshAvailabilityMock.mockClear();
    openChangeSpy = null;
    tooltipOpenChangeSpy = null;
    capturedTooltipOpen = undefined;
    closeAutoFocusSpy = null;
    mockSettings = null;
    mockPanelsById = {};
    mockPanelIds = [];
    mockActiveWorktreeId = null;
    mockHasRealData = true;
    mockActionMruList = [];
    markAgentsSeenMock.mockClear();
    dismissWelcomeCardMock.mockClear();
    mockSeenAgentIds = [];
    mockWelcomeCardDismissed = true;
    mockOnboardingLoaded = true;
    mockCcrPresetsByAgent = {};
    mockMergedPresetsFn = () => [];
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
    const { getByLabelText, getByTestId } = render(<AgentTrayButton />);
    expect(getByLabelText("Agent tray")).toBeTruthy();
    expect(getByTestId("plug-icon")).toBeTruthy();
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

  it("does not call preventDefault in onCloseAutoFocus (preserves a11y focus return)", () => {
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: true } });

    render(<AgentTrayButton agentAvailability={availability} />);
    expect(closeAutoFocusSpy).toBeTruthy();

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

    const { queryByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    expect(queryByTestId("agent-tray-discovery-badge")).toBeTruthy();
    expect(queryByTestId("agent-tray-new-pill-claude")).toBeTruthy();
    expect(queryByTestId("agent-tray-new-pill-gemini")).toBeNull();
  });

  it("suppresses the discovery badge while the welcome card is actually renderable", () => {
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({});
    mockWelcomeCardDismissed = false;
    mockSeenAgentIds = [];

    const { queryByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    expect(queryByTestId("agent-tray-discovery-badge")).toBeNull();
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

    const { queryByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    expect(queryByTestId("agent-tray-discovery-badge")).toBeNull();
  });

  it("calls markAgentsSeen with all ready agent ids on tray open", () => {
    const availability = { claude: "ready", gemini: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({});
    mockWelcomeCardDismissed = true;
    mockSeenAgentIds = [];

    render(<AgentTrayButton agentAvailability={availability} />);
    expect(openChangeSpy).toBeTruthy();
    markAgentsSeenMock.mockClear();

    openChangeSpy!(true);
    expect(markAgentsSeenMock).toHaveBeenCalledTimes(1);
    const [ids] = markAgentsSeenMock.mock.calls[0] as [string[]];
    expect(ids.sort()).toEqual(["claude", "gemini"]);
  });

  it("does not call markAgentsSeen when no agents are ready on tray open", () => {
    const availability = {
      claude: "missing",
      gemini: "missing",
    } as unknown as CliAvailability;
    mockSettings = settingsWith({});

    render(<AgentTrayButton agentAvailability={availability} />);
    markAgentsSeenMock.mockClear();

    openChangeSpy!(true);
    expect(markAgentsSeenMock).not.toHaveBeenCalled();
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
      mockActiveWorktreeId = "wt-A";
      const availability = arrangeAgentWithPresets();
      const { getAllByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
      const submenuTrigger = getAllByTestId("submenu-trigger")[0]!;

      fireEvent.keyDown(submenuTrigger, { key: "Enter" });

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
});
