// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import type { AgentSettings, CliAvailability } from "@shared/types";

const dispatchMock = vi.fn();
const setAgentPinnedMock = vi.fn().mockResolvedValue(undefined);
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

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

type MockAgentStoreState = {
  settings: AgentSettings | null;
  setAgentPinned: typeof setAgentPinnedMock;
};

vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: (selector: (s: MockAgentStoreState) => unknown) =>
    selector({ settings: mockSettings, setAgentPinned: setAgentPinnedMock }),
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

  it("lists every ready agent regardless of pin state", () => {
    const availability = {
      claude: "ready",
      gemini: "ready",
      codex: "ready",
    } as unknown as CliAvailability;
    mockSettings = settingsWith({
      claude: { pinned: true },
      gemini: { pinned: false },
    });

    const { container, getAllByTestId } = render(
      <AgentTrayButton agentAvailability={availability} />
    );

    const labels = getAllByTestId("menu-label").map((el) => el.textContent);
    expect(labels).toContain("Agents");

    const rows = agentRows(container);
    expect(rows).toEqual(["claude", "gemini", "codex"]);
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
    mockSettings = settingsWith({ claude: { pinned: true } });
    mockPanelsById = {
      "panel-1": {
        id: "panel-1",
        kind: "agent",
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

  it("renders a filled pin indicator for pinned agents", () => {
    const availability = {
      claude: "ready",
      gemini: "ready",
    } as unknown as CliAvailability;
    mockSettings = settingsWith({
      claude: { pinned: true },
      gemini: { pinned: false },
    });

    const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    expect(getByTestId("agent-tray-pin-claude").getAttribute("data-pinned")).toBe("true");
    expect(getByTestId("agent-tray-pin-gemini").getAttribute("data-pinned")).toBe("false");
  });

  it("clicking pin toggles pinned without launching", () => {
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: true } });

    const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    fireEvent.click(getByTestId("agent-tray-pin-claude"));

    expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", false);
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

  it("only puts installed-but-unauth agents in Also Available (missing agents are hidden)", () => {
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
    expect(labels).toContain("Also Available");

    const setupItems = Array.from(container.querySelectorAll('[role="menuitem"]')).filter(
      (el) =>
        el.textContent?.includes("Setup") &&
        !el.textContent.includes("Manage") &&
        !el.textContent.includes("Customize")
    );
    // Only codex (installed) belongs in Also Available. Gemini (missing) must NOT appear.
    expect(setupItems.length).toBe(1);
    expect(setupItems[0].textContent).toContain("Codex");
    const allText = container.textContent ?? "";
    expect(allText).not.toMatch(/Also Available[\s\S]*Gemini/);
  });

  it("dispatches settings with subtab when an Also-Available setup row is clicked", () => {
    const availability = {
      claude: "ready",
      gemini: "installed",
    } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: true } });

    const { container, getAllByTestId } = render(
      <AgentTrayButton agentAvailability={availability} />
    );
    // Sanity check: this must be the Also-Available branch, not the fallback.
    const labels = getAllByTestId("menu-label").map((el) => el.textContent);
    expect(labels).toContain("Also Available");

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

  it("handles null store settings gracefully (opt-in default)", () => {
    mockSettings = null;
    const availability = { claude: "ready" } as unknown as CliAvailability;

    const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    // Null settings means the normalizer hasn't run yet — with opt-in
    // semantics, that reads as unpinned until real data arrives.
    expect(getByTestId("agent-tray-pin-claude").getAttribute("data-pinned")).toBe("false");
  });

  it("suppresses tooltip reopen during focus restoration after dropdown closes (issue #5153)", () => {
    vi.useFakeTimers();
    try {
      const availability = { claude: "ready" } as unknown as CliAvailability;
      mockSettings = settingsWith({ claude: { pinned: true } });

      render(<AgentTrayButton agentAvailability={availability} />);
      expect(tooltipOpenChangeSpy).toBeTruthy();
      expect(closeAutoFocusSpy).toBeTruthy();

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

      // After the microtask clears, tooltip opens normally again on hover.
      act(() => {
        vi.runAllTimers();
      });
      act(() => {
        tooltipOpenChangeSpy!(true);
      });
      expect(capturedTooltipOpen).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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

  it("ignores panels from other worktrees for session detection", () => {
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: true } });
    mockPanelsById = {
      "panel-1": {
        id: "panel-1",
        kind: "agent",
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
});
