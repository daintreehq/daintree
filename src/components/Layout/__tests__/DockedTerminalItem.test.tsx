// @vitest-environment jsdom
/**
 * DockedTerminalItem — move-to-grid gesture.
 *
 * The single docked chip moves to the grid via double-click (the dedicated
 * reveal-on-hover button was removed; move-to-grid also remains reachable via
 * the right-click context menu). These tests drive the double-click through a
 * render harness (no source-string assertions) and verify the store wiring: the
 * dock popover only closes when moveTerminalToGrid succeeds.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";

const openDockTerminalMock = vi.fn();
const closeDockTerminalMock = vi.fn();
const moveTerminalToGridMock = vi.fn();

let mockActiveDockTerminalId: string | null = null;
let mockDockAgentState: string | undefined = undefined;

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
  getDockDisplayAgentState: () => mockDockAgentState,
  isDockAgentStateDeprioritized: () => false,
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
  getEffectiveStateLabel: (state: string) => state,
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
import { DragHandleProvider } from "@/components/DragDrop/DragHandleContext";

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

describe("DockedTerminalItem move-to-grid gesture", () => {
  beforeEach(() => {
    openDockTerminalMock.mockReset();
    closeDockTerminalMock.mockReset();
    moveTerminalToGridMock.mockReset();
    mockActiveDockTerminalId = null;
    mockDockAgentState = undefined;
  });

  // #10024 — the dock chip's state icon is aria-hidden, so the agent state must
  // be carried in the button's accessible name for screen-reader users.
  it("announces the agent state in the chip aria-label when an agent is active", () => {
    mockDockAgentState = "working";
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);
    expect(screen.getByRole("button", { name: /— agent working/ })).not.toBeNull();
  });

  it("omits agent state from the chip aria-label for a plain shell", () => {
    mockDockAgentState = undefined;
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);
    expect(screen.queryByRole("button", { name: /agent/i })).toBeNull();
  });

  it("does not render a dedicated Open in grid button on the chip", () => {
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);
    expect(screen.queryByRole("button", { name: "Open Terminal in grid" })).toBeNull();
  });

  it("moves the terminal to the grid on double-click and closes the dock on success", () => {
    moveTerminalToGridMock.mockReturnValue(true);
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);

    const chip = screen.getByRole("button", { name: /double-click to move to grid/i });
    fireEvent.doubleClick(chip);

    expect(moveTerminalToGridMock).toHaveBeenCalledWith("t-1");
    expect(closeDockTerminalMock).toHaveBeenCalledTimes(1);
  });

  it("does not close the dock popover when the move is rejected", () => {
    moveTerminalToGridMock.mockReturnValue(false);
    render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />);

    const chip = screen.getByRole("button", { name: /double-click to move to grid/i });
    fireEvent.doubleClick(chip);

    expect(moveTerminalToGridMock).toHaveBeenCalledWith("t-1");
    expect(closeDockTerminalMock).not.toHaveBeenCalled();
  });
});

// #10797 — the chip showed grab-cursor styling but never consumed the drag
// listeners SortableDockItem publishes via DragHandleProvider, so it wasn't a
// functional drag source. The fix forwards the pointer/touch listeners but
// deliberately drops the KeyboardSensor's onKeyDown: the chip is its own preview
// trigger, so Space/Enter must keep opening the preview rather than being
// hijacked into a keyboard drag pickup.
describe("DockedTerminalItem drag wiring", () => {
  beforeEach(() => {
    mockActiveDockTerminalId = null;
    mockDockAgentState = undefined;
  });

  it("forwards pointer drag events from the chip to the dnd listeners", () => {
    const onMouseDown = vi.fn();
    render(
      <DragHandleProvider value={{ listeners: { onMouseDown }, setActivatorNodeRef: vi.fn() }}>
        <DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />
      </DragHandleProvider>
    );

    const chip = screen.getByRole("button", { name: /drag to reorder/i });
    fireEvent.mouseDown(chip);
    expect(onMouseDown).toHaveBeenCalledTimes(1);
  });

  it("does not wire the keyboard-drag listener onto the chip (Space/Enter stays for preview)", () => {
    const onKeyDown = vi.fn();
    render(
      <DragHandleProvider value={{ listeners: { onKeyDown }, setActivatorNodeRef: vi.fn() }}>
        <DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />
      </DragHandleProvider>
    );

    const chip = screen.getByRole("button", { name: /drag to reorder/i });
    fireEvent.keyDown(chip, { key: "Enter" });
    fireEvent.keyDown(chip, { key: " " });
    // The KeyboardSensor's onKeyDown would call preventDefault() and start a drag
    // pickup, suppressing the native button click that opens the preview. It must
    // not be forwarded onto the chip.
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it("renders without a drag-handle provider (no listeners) without throwing", () => {
    expect(() =>
      render(<DockedTerminalItem terminal={makeTerminal({ id: "t-1" })} />)
    ).not.toThrow();
    expect(screen.getByRole("button", { name: /drag to reorder/i })).not.toBeNull();
  });
});
