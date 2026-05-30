// @vitest-environment jsdom
/**
 * DockedTabGroup — focus-driven dismissal guard (#6602).
 *
 * Same root cause and fix as DockedTerminalItem: Radix's DismissableLayer fires
 * a focus-outside dismissal while a just-opened tab group's active terminal is
 * still migrating into the portal. The fix blocks that at onFocusOutside and
 * focuses the active tab once its node lands in the portal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";
import type { TabGroup } from "@/types";

const trashPanelMock = vi.fn();
const setActiveTabMock = vi.fn();
const setFocusedMock = vi.fn();
const openDockTerminalMock = vi.fn();
const closeDockTerminalMock = vi.fn();
const moveTerminalToGridMock = vi.fn();
const updateTitleMock = vi.fn();
const reorderPanelsInGroupMock = vi.fn();
const addPanelMock = vi.fn();
const addPanelToGroupMock = vi.fn();

let mockActiveDockTerminalId: string | null = null;
let mockTabGroups = new Map<string, TabGroup>();
let capturedOnOpenChange: ((open: boolean) => void) | null = null;
let capturedOnOpenAutoFocus: ((event: { preventDefault: () => void }) => void) | null = null;
let capturedOnFocusOutside: ((event: { preventDefault: () => void }) => void) | null = null;

vi.mock("@/store", () => ({
  usePanelStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      activeDockTerminalId: mockActiveDockTerminalId,
      openDockTerminal: openDockTerminalMock,
      closeDockTerminal: closeDockTerminalMock,
      moveTerminalToGrid: moveTerminalToGridMock,
      backendStatus: "connected",
      setActiveTab: setActiveTabMock,
      setFocused: setFocusedMock,
      trashPanel: trashPanelMock,
      updateTitle: updateTitleMock,
      reorderPanelsInGroup: reorderPanelsInGroupMock,
      addPanel: addPanelMock,
      addPanelToGroup: addPanelToGroupMock,
      tabGroups: mockTabGroups,
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

vi.mock("@/hooks", () => ({
  useTabOverflow: () => new Set<string>(),
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

vi.mock("@/services/terminal/panelDuplicationService", () => ({
  buildPanelDuplicateOptions: vi.fn(),
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
  getGroupBlockedAgentState: () => null,
  isGroupDeprioritized: () => false,
}));

vi.mock("../dockPopoverGuard", () => ({
  handleDockInteractOutside: vi.fn(),
  handleDockEscapeKeyDown: vi.fn(),
  handleDockFocusOutside: vi.fn(),
}));

vi.mock("@/utils/terminalChrome", () => ({
  deriveTerminalChrome: () => ({ isAgent: false, color: "#abc" }),
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
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

// Active Popover mock: captures the Radix callbacks. Focus-driven dismissal is
// intercepted at onFocusOutside (not onOpenChange), so the mock no longer
// simulates a mount-time onOpenChange(false).
vi.mock("@/components/ui/popover", () => ({
  Popover: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => {
    capturedOnOpenChange = onOpenChange ?? null;
    return <>{children}</>;
  },
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({
    children,
    onOpenAutoFocus,
    onFocusOutside,
  }: {
    children: React.ReactNode;
    onOpenAutoFocus?: (event: { preventDefault: () => void }) => void;
    onFocusOutside?: (event: { preventDefault: () => void }) => void;
  }) => {
    capturedOnOpenAutoFocus = onOpenAutoFocus ?? null;
    capturedOnFocusOutside = onFocusOutside ?? null;
    return <div>{children}</div>;
  },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/Panel/SortableTabButton", () => ({
  SortableTabButton: ({
    id,
    isActive,
    onClick,
  }: {
    id: string;
    isActive?: boolean;
    onClick?: () => void;
  }) => (
    <button
      data-testid={`tab-${id}`}
      data-tab-id={id}
      role="tab"
      aria-selected={!!isActive}
      tabIndex={isActive ? 0 : -1}
      onClick={onClick}
      onKeyDown={(e) => {
        // Mirror TabButton's own Space/Enter activation.
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
    >
      {id}
    </button>
  ),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useDndMonitor: vi.fn(),
  closestCenter: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
  PointerSensor: class {},
  TouchSensor: class {},
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  horizontalListSortingStrategy: vi.fn(),
  arrayMove: <T,>(arr: T[]) => arr,
}));

vi.mock("@dnd-kit/modifiers", () => ({
  restrictToHorizontalAxis: vi.fn(),
  restrictToParentElement: vi.fn(),
}));

vi.mock("framer-motion", () => ({
  LayoutGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  LazyMotion: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  m: { div: ({ children }: { children: React.ReactNode }) => <>{children}</> },
  domMax: {},
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

import { DockedTabGroup } from "../DockedTabGroup";
import { handleDockFocusOutside } from "../dockPopoverGuard";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";

function makePanel(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
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

function makeGroup(panelIds: string[], activeTabId = panelIds[0]!): TabGroup {
  return {
    id: "g-1",
    location: "dock",
    worktreeId: "wt-1",
    activeTabId,
    panelIds,
  };
}

describe("DockedTabGroup mount-time close guard (#6602)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    trashPanelMock.mockClear();
    setActiveTabMock.mockClear();
    setFocusedMock.mockClear();
    openDockTerminalMock.mockClear();
    closeDockTerminalMock.mockClear();
    moveTerminalToGridMock.mockClear();
    mockActiveDockTerminalId = null;
    mockTabGroups = new Map();
    mockTabGroups.set("g-1", makeGroup(["t-1", "t-2"]));
    capturedOnOpenChange = null;
    capturedOnOpenAutoFocus = null;
    capturedOnFocusOutside = null;
    vi.mocked(terminalInstanceService.focus).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("wires onFocusOutside to the focus-dismissal guard and never closes on mount", () => {
    mockActiveDockTerminalId = "t-1";
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];

    render(<DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />);

    expect(closeDockTerminalMock).not.toHaveBeenCalled();
    expect(capturedOnFocusOutside).toBe(handleDockFocusOutside);
  });

  it("honors a genuine onOpenChange(false) close immediately", () => {
    mockActiveDockTerminalId = "t-1";
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];

    render(<DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />);
    expect(capturedOnOpenChange).not.toBeNull();

    act(() => {
      capturedOnOpenChange?.(false);
    });

    expect(closeDockTerminalMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing when mounted with no active panel in the group", () => {
    mockActiveDockTerminalId = null;
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];

    render(<DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />);

    expect(closeDockTerminalMock).not.toHaveBeenCalled();
    expect(openDockTerminalMock).not.toHaveBeenCalled();
  });

  it("still honors a real onOpenChange(false) when mounted closed", () => {
    // Regression guard against accidentally arming the ref unconditionally.
    mockActiveDockTerminalId = null;
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];

    render(<DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />);
    expect(capturedOnOpenChange).not.toBeNull();

    act(() => {
      capturedOnOpenChange?.(false);
    });

    expect(closeDockTerminalMock).toHaveBeenCalledTimes(1);
  });

  it("ignores spurious close when active panel is not the group's stored active tab", () => {
    // isOpen derives from `panels.some(p => p.id === activeDockTerminalId)`, not
    // from group.activeTabId. A panel made active out-of-band (e.g., by an agent
    // launcher that activates t-2 while the group's stored activeTabId is still
    // t-1) must still arm the mount guard.
    mockActiveDockTerminalId = "t-2";
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];

    render(<DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />);

    expect(closeDockTerminalMock).not.toHaveBeenCalled();
  });

  it("suppresses Radix auto-focus and focuses the active tab once it migrates into the portal", async () => {
    mockActiveDockTerminalId = "t-1";
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];
    render(<DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />);
    expect(capturedOnOpenAutoFocus).not.toBeNull();

    const preventDefault = vi.fn();
    act(() => {
      capturedOnOpenAutoFocus?.({ preventDefault });
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(terminalInstanceService.focus).not.toHaveBeenCalled();

    const portal = document.querySelector('[data-dock-portal-target="t-1"]');
    expect(portal).not.toBeNull();
    await act(async () => {
      const child = document.createElement("div");
      child.setAttribute("data-dock-panel-id", "t-1");
      portal!.appendChild(child);
      await Promise.resolve();
    });

    expect(terminalInstanceService.focus).toHaveBeenCalledWith("t-1");
  });

  it("does not focus an MCP-created active dock tab even after it migrates", async () => {
    mockActiveDockTerminalId = "t-1";
    const panels = [
      makePanel({ id: "t-1", spawnedBy: "mcp", focusPolicy: "preserve" }),
      makePanel({ id: "t-2" }),
    ];
    render(<DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />);
    expect(capturedOnOpenAutoFocus).not.toBeNull();

    const preventDefault = vi.fn();
    act(() => {
      capturedOnOpenAutoFocus?.({ preventDefault });
    });
    expect(preventDefault).toHaveBeenCalledOnce();

    const portal = document.querySelector('[data-dock-portal-target="t-1"]');
    await act(async () => {
      const child = document.createElement("div");
      child.setAttribute("data-dock-panel-id", "t-1");
      portal!.appendChild(child);
      await Promise.resolve();
    });

    expect(terminalInstanceService.focus).not.toHaveBeenCalled();
  });

  describe("tablist keyboard contract (APG manual activation)", () => {
    it("ArrowRight moves DOM focus to next tab without activating it", () => {
      mockActiveDockTerminalId = "t-1";
      const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];
      const { container } = render(
        <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
      );

      const tab1 = container.querySelector('[data-tab-id="t-1"]') as HTMLElement;
      const tab2 = container.querySelector('[data-tab-id="t-2"]') as HTMLElement;
      const tablist = container.querySelector('[role="tablist"]') as HTMLElement;
      expect(tab1).not.toBeNull();
      expect(tab2).not.toBeNull();

      tab1.focus();
      setActiveTabMock.mockClear();
      openDockTerminalMock.mockClear();
      setFocusedMock.mockClear();
      fireEvent.keyDown(tablist, { key: "ArrowRight" });

      expect(document.activeElement).toBe(tab2);
      // No activation side effects fired by the arrow key itself.
      expect(setActiveTabMock).not.toHaveBeenCalled();
      expect(openDockTerminalMock).not.toHaveBeenCalled();
      expect(setFocusedMock).not.toHaveBeenCalled();
    });

    it("Enter on a focused-but-not-active tab activates it", () => {
      mockActiveDockTerminalId = "t-1";
      const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];
      const { container } = render(
        <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
      );

      const tab2 = container.querySelector('[data-tab-id="t-2"]') as HTMLElement;
      tab2.focus();
      setActiveTabMock.mockClear();
      openDockTerminalMock.mockClear();
      setFocusedMock.mockClear();

      fireEvent.keyDown(tab2, { key: "Enter" });

      expect(setActiveTabMock).toHaveBeenCalledWith("g-1", "t-2");
      expect(openDockTerminalMock).toHaveBeenCalledWith("t-2");
      expect(setFocusedMock).toHaveBeenCalledWith("t-2");
    });

    it("Space on a focused-but-not-active tab activates it and prevents default scroll", () => {
      mockActiveDockTerminalId = "t-1";
      const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];
      const { container } = render(
        <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
      );

      const tab2 = container.querySelector('[data-tab-id="t-2"]') as HTMLElement;
      tab2.focus();
      setActiveTabMock.mockClear();
      openDockTerminalMock.mockClear();

      const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
      const dispatched = tab2.dispatchEvent(event);

      // dispatchEvent returns false when defaultPrevented; activation should also fire.
      expect(dispatched).toBe(false);
      expect(setActiveTabMock).toHaveBeenCalledWith("g-1", "t-2");
      expect(openDockTerminalMock).toHaveBeenCalledWith("t-2");
    });

    it("ArrowRight while the duplicate-as-new-tab (+) button is focused does not yank focus into the tab strip", () => {
      mockActiveDockTerminalId = "t-1";
      const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];
      const { container } = render(
        <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
      );

      const addTabButton = container.querySelector(
        '[aria-label="Duplicate panel as new tab"]'
      ) as HTMLElement;
      const tab1 = container.querySelector('[data-tab-id="t-1"]') as HTMLElement;
      const tablist = container.querySelector('[role="tablist"]') as HTMLElement;
      expect(addTabButton).not.toBeNull();

      addTabButton.focus();
      fireEvent.keyDown(tablist, { key: "ArrowRight" });

      // Focus stays on the + button — the handler bails out for non-tab focus
      // anchors inside the tablist.
      expect(document.activeElement).toBe(addTabButton);
      expect(document.activeElement).not.toBe(tab1);
    });

    it("Home moves focus to the first tab without activating", () => {
      mockActiveDockTerminalId = "t-2";
      const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];
      const { container } = render(
        <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-2")} panels={panels} />
      );

      const tab1 = container.querySelector('[data-tab-id="t-1"]') as HTMLElement;
      const tab2 = container.querySelector('[data-tab-id="t-2"]') as HTMLElement;
      const tablist = container.querySelector('[role="tablist"]') as HTMLElement;

      tab2.focus();
      setActiveTabMock.mockClear();
      openDockTerminalMock.mockClear();

      fireEvent.keyDown(tablist, { key: "Home" });

      expect(document.activeElement).toBe(tab1);
      expect(setActiveTabMock).not.toHaveBeenCalled();
      expect(openDockTerminalMock).not.toHaveBeenCalled();
    });
  });
});

describe("DockedTabGroup lifecycle and pop-out (#8160)", () => {
  let rafCallbacks: Array<{ id: number; cb: FrameRequestCallback; cancelled: boolean }> = [];
  let nextRafId = 1;

  function flushRaf() {
    const pending = rafCallbacks.filter((e) => !e.cancelled);
    rafCallbacks = [];
    for (const entry of pending) entry.cb(performance.now());
  }

  beforeEach(() => {
    vi.useFakeTimers();
    rafCallbacks = [];
    nextRafId = 1;
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      const id = nextRafId++;
      rafCallbacks.push({ id, cb, cancelled: false });
      return id;
    });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
      const entry = rafCallbacks.find((e) => e.id === id);
      if (entry) entry.cancelled = true;
    });
    openDockTerminalMock.mockClear();
    closeDockTerminalMock.mockClear();
    moveTerminalToGridMock.mockClear();
    mockActiveDockTerminalId = null;
    mockTabGroups = new Map();
    mockTabGroups.set("g-1", makeGroup(["t-1", "t-2"]));
    vi.mocked(terminalInstanceService.applyRendererPolicy).mockClear();
    vi.mocked(terminalInstanceService.focus).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("schedules a single RAF on open and applies VISIBLE policy for the active panel", () => {
    mockActiveDockTerminalId = "t-1";
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];

    render(<DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />);

    expect(rafCallbacks.length).toBe(1);
    expect(terminalInstanceService.applyRendererPolicy).not.toHaveBeenCalled();

    act(() => {
      flushRaf();
    });

    expect(terminalInstanceService.applyRendererPolicy).toHaveBeenCalledWith(
      "t-1",
      TerminalRefreshTier.VISIBLE
    );
  });

  it("applies BACKGROUND policy synchronously when mounted closed", () => {
    mockActiveDockTerminalId = null;
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];

    render(<DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />);

    expect(terminalInstanceService.applyRendererPolicy).toHaveBeenCalledWith(
      "t-1",
      TerminalRefreshTier.BACKGROUND
    );
    expect(rafCallbacks.length).toBe(0);
  });

  it("cancels the pending RAF and never applies VISIBLE when closed before it fires", () => {
    mockActiveDockTerminalId = "t-1";
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];

    const { rerender } = render(
      <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
    );
    expect(rafCallbacks.length).toBe(1);
    expect(rafCallbacks[0]?.cancelled).toBe(false);

    mockActiveDockTerminalId = null;
    rerender(<DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />);

    expect(rafCallbacks[0]?.cancelled).toBe(true);

    act(() => {
      flushRaf();
    });

    const calls = vi.mocked(terminalInstanceService.applyRendererPolicy).mock.calls;
    expect(calls.some((c) => c[1] === TerminalRefreshTier.VISIBLE)).toBe(false);
    expect(calls.some((c) => c[1] === TerminalRefreshTier.BACKGROUND)).toBe(true);
  });

  it("renders an 'Open in grid' button that pops the active panel to the grid", () => {
    mockActiveDockTerminalId = "t-1";
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];
    const { container } = render(
      <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
    );

    const popOut = container.querySelector(
      'button[aria-label="Open in grid"]'
    ) as HTMLButtonElement | null;
    expect(popOut).not.toBeNull();

    moveTerminalToGridMock.mockReturnValue(true);
    act(() => {
      popOut?.click();
    });

    expect(moveTerminalToGridMock).toHaveBeenCalledWith("t-1");
    expect(closeDockTerminalMock).toHaveBeenCalledTimes(1);
  });

  it("does not close the dock when moveTerminalToGrid returns false", () => {
    mockActiveDockTerminalId = "t-1";
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];
    const { container } = render(
      <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
    );

    const popOut = container.querySelector(
      'button[aria-label="Open in grid"]'
    ) as HTMLButtonElement | null;
    expect(popOut).not.toBeNull();

    moveTerminalToGridMock.mockReturnValue(false);
    act(() => {
      popOut?.click();
    });

    expect(moveTerminalToGridMock).toHaveBeenCalledWith("t-1");
    expect(closeDockTerminalMock).not.toHaveBeenCalled();
  });
});
