// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { AgentSettings, CliAvailability } from "@shared/types";

const dispatchMock = vi.fn();
const setAgentPinnedMock = vi.fn().mockResolvedValue(undefined);
const addNotificationMock = vi.fn();

// Mutable mock store state so tests can control what the component reads.
let mockSettings: AgentSettings | null = null;

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

type MockNotificationState = {
  addNotification: typeof addNotificationMock;
};

vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: (selector: (s: MockNotificationState) => unknown) =>
    selector({ addNotification: addNotificationMock }),
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

// Passthrough UI primitives so dropdown content renders without a portal.
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
  Pin: ({ className }: { className?: string }) => (
    <span data-testid="pin-icon" data-classname={className} />
  ),
  Settings2: () => <span data-testid="settings2-icon" />,
}));

import { AgentTrayButton } from "../AgentTrayButton";

function settingsWith(overrides: Record<string, { pinned?: boolean }>): AgentSettings {
  return { agents: overrides } as unknown as AgentSettings;
}

function launchItems(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[role="menuitem"]'))
    .map((el) => el.textContent?.replace(/Press P to.*toolbar/, "").trim() ?? "")
    .filter((t) => t && !t.includes("Set up") && !t.includes("Customize Toolbar"));
}

describe("AgentTrayButton", () => {
  beforeEach(() => {
    dispatchMock.mockClear();
    setAgentPinnedMock.mockClear();
    addNotificationMock.mockClear();
    mockSettings = null;
  });

  it("renders the plug trigger with accessible label", () => {
    const { getByLabelText, getByTestId } = render(<AgentTrayButton />);
    expect(getByLabelText("Agent tray")).toBeTruthy();
    expect(getByTestId("plug-icon")).toBeTruthy();
  });

  it("lists every ready agent in a single Launch section regardless of pin state", () => {
    const availability = {
      claude: "ready",
      gemini: "ready",
      codex: "ready",
    } as unknown as CliAvailability;
    mockSettings = settingsWith({
      claude: { pinned: true },
      gemini: { pinned: false },
      // codex: no entry → defaults to pinned (opt-out)
    });

    const { container, getAllByTestId } = render(
      <AgentTrayButton agentAvailability={availability} />
    );

    const labels = getAllByTestId("menu-label").map((el) => el.textContent);
    expect(labels).toContain("Launch");
    expect(labels).not.toContain("Pin to Toolbar");

    const names = launchItems(container);
    // All three ready agents appear in Launch
    expect(names).toEqual(expect.arrayContaining(["Claude", "Gemini", "Codex"]));
  });

  it("dispatches agent.launch when a Launch row is clicked", () => {
    const availability = { gemini: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ gemini: { pinned: false } });

    const { container } = render(<AgentTrayButton agentAvailability={availability} />);

    const geminiItem = Array.from(container.querySelectorAll('[role="menuitem"]')).find((el) =>
      el.textContent?.startsWith("Gemini")
    );
    expect(geminiItem).toBeTruthy();
    fireEvent.click(geminiItem!);

    expect(dispatchMock).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "gemini" },
      { source: "user" }
    );
  });

  it("renders a filled pin indicator when an agent is pinned", () => {
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

  it("clicking the trailing pin toggles pinned without launching the agent", () => {
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: true } });

    const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    const pin = getByTestId("agent-tray-pin-claude");
    fireEvent.click(pin);

    expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", false);
    // Pin/unpin is a direct user action — no toast should fire.
    expect(addNotificationMock).not.toHaveBeenCalled();
    // Menu launch must NOT have been triggered
    expect(dispatchMock).not.toHaveBeenCalledWith(
      "agent.launch",
      expect.anything(),
      expect.anything()
    );
  });

  it("pressing P on a focused row toggles pin", () => {
    const availability = { claude: "ready" } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: false } });

    const { container } = render(<AgentTrayButton agentAvailability={availability} />);
    const claude = Array.from(container.querySelectorAll('[role="menuitem"]')).find((el) =>
      el.textContent?.startsWith("Claude")
    ) as HTMLElement | undefined;
    expect(claude).toBeTruthy();
    fireEvent.keyDown(claude!, { key: "P" });
    expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", true);
  });

  it("treats missing pinned entries as pinned (opt-out default)", () => {
    const availability = {
      claude: "ready",
    } as unknown as CliAvailability;
    // No entry for claude at all — helper should treat it as pinned.
    mockSettings = settingsWith({});

    const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    expect(getByTestId("agent-tray-pin-claude").getAttribute("data-pinned")).toBe("true");
  });

  it("lists missing agents in Needs Setup and dispatches the correct subtab on click", () => {
    const availability = {
      claude: "ready",
      gemini: "missing",
      codex: "missing",
    } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: true } });

    const { container, getAllByTestId } = render(
      <AgentTrayButton agentAvailability={availability} />
    );

    const labels = getAllByTestId("menu-label").map((el) => el.textContent);
    expect(labels).toContain("Needs Setup");

    const setupItems = Array.from(container.querySelectorAll('[role="menuitem"]')).filter((el) =>
      el.textContent?.includes("Set up")
    );
    expect(setupItems.length).toBe(2);

    const geminiSetup = setupItems.find((el) => el.textContent?.includes("Gemini"));
    expect(geminiSetup).toBeTruthy();
    fireEvent.click(geminiSetup!);
    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "agents", subtab: "gemini" },
      { source: "user" }
    );
  });

  it("routes 'installed' (unauthenticated) agents into Needs Setup", () => {
    const availability = {
      claude: "installed",
    } as unknown as CliAvailability;
    mockSettings = settingsWith({ claude: { pinned: true } });

    const { container, getAllByTestId } = render(
      <AgentTrayButton agentAvailability={availability} />
    );
    const labels = getAllByTestId("menu-label").map((el) => el.textContent);
    expect(labels).toContain("Needs Setup");
    expect(labels).not.toContain("Launch");
    const launchRows = launchItems(container);
    expect(launchRows).not.toContain("Claude");
  });

  it("shows a Customize Toolbar footer that dispatches the toolbar settings tab", () => {
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

  it("shows a loading placeholder while agentAvailability is undefined", () => {
    mockSettings = settingsWith({ claude: { pinned: true } });
    const { getByText, queryAllByTestId } = render(<AgentTrayButton />);
    expect(getByText("Checking agents…")).toBeTruthy();
    const labels = queryAllByTestId("menu-label").map((el) => el.textContent);
    expect(labels).not.toContain("Needs Setup");
    expect(labels).not.toContain("Launch");
  });

  it("shows 'No agents available' when availability has resolved with no entries", () => {
    const { getByText } = render(
      <AgentTrayButton agentAvailability={{} as unknown as CliAvailability} />
    );
    expect(getByText("No agents available")).toBeTruthy();
  });

  it("handles null store settings gracefully (treats absent entries as pinned)", () => {
    mockSettings = null;
    const availability = {
      claude: "ready",
      gemini: "ready",
    } as unknown as CliAvailability;

    const { getByTestId } = render(<AgentTrayButton agentAvailability={availability} />);
    expect(getByTestId("agent-tray-pin-claude").getAttribute("data-pinned")).toBe("true");
    expect(getByTestId("agent-tray-pin-gemini").getAttribute("data-pinned")).toBe("true");
  });
});
