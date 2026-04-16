// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { AgentSettings, CliAvailability } from "@shared/types";

const dispatchMock = vi.fn();
const setAgentPinnedMock = vi.fn().mockResolvedValue(undefined);
const setFocusedMock = vi.fn();

let mockSettings: AgentSettings | null = null;
let mockPanelsById: Record<string, unknown> = {};
let mockPanelIds: string[] = [];
let mockActiveWorktreeId: string | null = null;

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
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
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
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
    mockSettings = null;
    mockPanelsById = {};
    mockPanelIds = [];
    mockActiveWorktreeId = null;
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

  it("treats missing pinned entries as pinned (opt-out)", () => {
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({});

    const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    expect(getByTestId("agent-tray-pin-claude").getAttribute("data-pinned")).toBe("true");
  });

  it("puts missing and installed-but-unauth agents in Also Available with pill badge", () => {
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

    const setupItems = Array.from(container.querySelectorAll('[role="menuitem"]')).filter((el) =>
      el.textContent?.includes("Setup")
    );
    // Gemini (missing) + Codex (installed) in Also Available
    expect(setupItems.length).toBeGreaterThanOrEqual(2);
  });

  it("dispatches settings for setup items", () => {
    const availability = { gemini: "missing" } as unknown as CliAvailability;
    mockSettings = settingsWith({});

    const { container } = render(<AgentTrayButton agentAvailability={availability} />);
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

  it("shows 'No agents available' for empty availability", () => {
    const { getByText } = render(
      <AgentTrayButton agentAvailability={{} as unknown as CliAvailability} />
    );
    expect(getByText("No agents available")).toBeTruthy();
  });

  it("handles null store settings gracefully", () => {
    mockSettings = null;
    const availability = { claude: "ready" } as unknown as CliAvailability;

    const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    expect(getByTestId("agent-tray-pin-claude").getAttribute("data-pinned")).toBe("true");
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
