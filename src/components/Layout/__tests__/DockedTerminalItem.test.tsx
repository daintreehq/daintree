// @vitest-environment jsdom
/**
 * DockedTerminalItem — move-to-grid affordance (#9683).
 *
 * The single docked chip exposes a reveal-on-hover "Open in grid" button (the
 * gesture was previously only reachable via double-click / context menu). These
 * tests drive the button and the double-click backstop through a render harness
 * (no source-string assertions) and verify the store wiring: the dock popover
 * only closes when moveTerminalToGrid succeeds.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";

const openDockTerminalMock = vi.fn();
const closeDockTerminalMock = vi.fn();
const moveTerminalToGridMock = vi.fn();

let mockActiveDockTerminalId: string | null = null;

vi.mock("@/store", () => ({
  usePanelStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      activeDockTerminalId: mockActiveDockTerminalId,
      openDockTerminal: openDockTerminalMock,
      closeDockTerminal: closeDockTerminalMock,
      moveTerminalToGrid: moveTerminalToGridMock,
      backendStatus: "connected",
      showDockAgentHighlights: false,
    }),
  useTerminalInputStore: (
    selector: (s: { hybridInputEnabled: boolean; hybridInputAutoFocus: boolean }) => unknown
  ) => selector({ hybridInputEnabled: false, hybridInputAutoFocus: false }),
  usePortalStore: (selector: (s: { isOpen: boolean; width: number }) => unknown) =>
    selector({ isOpen: false, width: 0 }),
  useFocusStore: (
    selector: (s: { isFocusMode: boolean; gestureSidebarHidden: boolean }) => unknown
  ) => selector({ isFocusMode: false, gestureSidebarHidden: false }),
  usePreferencesStore: (selector: (s: { showDockAgentHighlights: boolean }) => unknown) =>
    selector({ showDockAgentHighlights: false }),
}));

vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: (selector: (s: { settings: null }) => unknown) =>
    selector({ settings: null }),
}));

vi.mock("@/store/ccrPresetsStore", () => ({
  useCcrPresetsStore: (selector: (s: { ccrPresetsByAgent: Record<string, unknown> }) => unknown) =>
    selector({ ccrPresetsByAgent: {} }),
}));

vi.mock("@/store/projectPresetsStore", () => ({
  useProjectPresetsStore: (selector: (s: { presetsByAgent: Record<string, unknown> }) => unknown) =>
    selector({ presetsByAgent: {} }),
}));

vi.mock("@/config/agents", () => ({
  getMergedPresets: () => [],
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    fit: () => ({ cols: 80, rows: 24 }),
    applyRendererPolicy: vi.fn(),
    focus: vi.fn(),
  },
}));

vi.mock("../dockPanelPortalContext", () => ({
  useDockPanelPortal: () => vi.fn(),
}));

vi.mock("../useDockBlockedState", () => ({
  useDockBlockedState: () => null,
  getDockDisplayAgentState: () => undefined,
}));

vi.mock("../dockPopoverGuard", () => ({
  handleDockInteractOutside: vi.fn(),
  handleDockEscapeKeyDown: vi.fn(),
  handleDockFocusOutside: vi.fn(),
}));

vi.mock("@/utils/terminalChrome", () => ({
  deriveTerminalChrome: () => ({ isAgent: false, color: "#abc" }),
}));

vi.mock("@/components/Worktree/terminalStateConfig", () => ({
  getEffectiveStateIcon: () => null,
  getEffectiveStateColor: () => "",
}));

vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: () => <span data-testid="terminal-icon" />,
}));

vi.mock("@/components/Terminal/terminalFocus", () => ({
  getTerminalFocusTarget: () => "terminal",
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@dnd-kit/core", () => ({
  useDndMonitor: vi.fn(),
}));

import { DockedTerminalItem } from "../DockedTerminalItem";

function makeTerminal(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: "t-1",
    title: "Terminal",
    location: "dock",
    kind: "terminal",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    ...overrides,
  } as PtyPanelData;
}

describe("DockedTerminalItem move-to-grid affordance (#9683)", () => {
  beforeEach(() => {
    openDockTerminalMock.mockReset();
    closeDockTerminalMock.mockReset();
    moveTerminalToGridMock.mockReset();
    mockActiveDockTerminalId = null;
  });

  it("renders an Open in grid button on the chip", () => {
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);
    expect(screen.getByRole("button", { name: "Open in grid" })).toBeTruthy();
  });

  it("moves the terminal to the grid when the button is clicked", () => {
    moveTerminalToGridMock.mockReturnValue(true);
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);

    fireEvent.click(screen.getByRole("button", { name: "Open in grid" }));

    expect(moveTerminalToGridMock).toHaveBeenCalledWith("t-1");
  });

  it("closes the dock popover only when the move succeeds", () => {
    moveTerminalToGridMock.mockReturnValue(true);
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);

    fireEvent.click(screen.getByRole("button", { name: "Open in grid" }));

    expect(closeDockTerminalMock).toHaveBeenCalledTimes(1);
  });

  it("does not close the dock popover when the move is rejected", () => {
    moveTerminalToGridMock.mockReturnValue(false);
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);

    fireEvent.click(screen.getByRole("button", { name: "Open in grid" }));

    expect(moveTerminalToGridMock).toHaveBeenCalledWith("t-1");
    expect(closeDockTerminalMock).not.toHaveBeenCalled();
  });

  it("does not open the dock preview when the button is clicked", () => {
    moveTerminalToGridMock.mockReturnValue(true);
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);

    fireEvent.click(screen.getByRole("button", { name: "Open in grid" }));

    expect(openDockTerminalMock).not.toHaveBeenCalled();
  });

  it("keeps double-click on the chip as a move-to-grid backstop", () => {
    moveTerminalToGridMock.mockReturnValue(true);
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);

    const chip = screen.getByRole("button", { name: /double-click to move to grid/i });
    fireEvent.doubleClick(chip);

    expect(moveTerminalToGridMock).toHaveBeenCalledWith("t-1");
    expect(closeDockTerminalMock).toHaveBeenCalledTimes(1);
  });
});
