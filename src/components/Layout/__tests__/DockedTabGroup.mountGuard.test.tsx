// @vitest-environment jsdom
/**
 * DockedTabGroup — focus-driven dismissal guard (#6602).
 *
 * Same root cause and fix as DockedTerminalItem: Radix's DismissableLayer fires
 * a focus-outside dismissal while a just-opened tab group's active terminal is
 * still migrating into the portal. The fix blocks that at onFocusOutside and
 * focuses the active tab once its stable wrapper has been moved in — a
 * synchronous step, no MutationObserver.
 */
import { beforeAll, describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";
import type { TabGroup } from "@/types";
import { UI_TRANSIENT_HINT_DWELL_MS } from "@/lib/animationUtils";

const trashPanelMock = vi.fn();
const setActiveTabMock = vi.fn();
const setFocusedMock = vi.fn();
const openDockTerminalMock = vi.fn();
const closeDockTerminalMock = vi.fn();
const moveTerminalToGridMock = vi.fn();
const updateTitleMock = vi.fn();
const reorderPanelsInGroupMock = vi.fn();
const addPanelMock = vi.fn();
const addPanelToGroupMock = vi.fn(() => true);

let mockActiveDockTerminalId: string | null = null;
let mockTabGroups = new Map<string, TabGroup>();
let capturedOnOpenChange: ((open: boolean) => void) | null = null;
let capturedOnOpenAutoFocus: ((event: { preventDefault: () => void }) => void) | null = null;
let capturedOnFocusOutside: ((event: { preventDefault: () => void }) => void) | null = null;
let mockHiddenTabIds = new Set<string>();

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
  useTerminalInputStore: Object.assign(
    (selector: (s: { hybridInputEnabled: boolean; hybridInputAutoFocus: boolean }) => unknown) =>
      selector({ hybridInputEnabled: false, hybridInputAutoFocus: false }),
    { getState: () => ({ hybridInputEnabled: false, hybridInputAutoFocus: false }) }
  ),
  usePortalStore: (selector: (s: { isOpen: boolean; width: number }) => unknown) =>
    selector({ isOpen: false, width: 0 }),
  useFocusStore: (
    selector: (s: { isFocusMode: boolean; gestureSidebarHidden: boolean }) => unknown
  ) => selector({ isFocusMode: false, gestureSidebarHidden: false }),
  usePreferencesStore: (selector: (s: { showDockAgentHighlights: boolean }) => unknown) =>
    selector({ showDockAgentHighlights: false }),
}));

vi.mock("@/hooks", () => ({
  useTabOverflow: () => mockHiddenTabIds,
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

vi.mock("@/services/layout/reorderGroupTabs", () => ({
  reorderGroupTabsWithUndo: vi.fn(),
}));

vi.mock("@/services/terminal/panelDuplicationService", () => ({
  buildPanelDuplicateOptions: vi.fn(),
}));

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    fit: () => ({ cols: 80, rows: 24 }),
    applyRendererPolicy: vi.fn(),
    focus: vi.fn(),
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});

import { load as loadTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";

// The service mock never evaluates the real module, so nothing registers it;
// loading caches the mock for the synchronous peek() call sites.
beforeAll(async () => {
  await loadTerminalService();
});

// The badge hook reads the real panel and plugin stores; these suites stub the store layer.
vi.mock("../DockChipBadge", () => ({
  useDockChipBadge: () => null,
  DockChipBadge: () => null,
}));

vi.mock("@/components/Panel/PluginPanelActivity", () => ({
  usePluginPanelActivity: () => null,
  PluginPanelActivityDockCue: () => null,
  pluginPanelActivityLabelSuffix: () => "",
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
  SESSION_ICONS: {},
  SESSION_COLORS: {},
  SESSION_LABELS: {},
}));

// The fleet band read and the pane observation read stores this suite doesn't
// stand up; with no band reported, the chip draws nothing amber.
vi.mock("@/hooks/useRunFleetBand", () => ({
  useRunFleetBand: () => undefined,
  useFleetBandRunIds: () => new Set<string>(),
}));
vi.mock("@/hooks/useRunSessionPresentation", () => ({
  usePaneObservation: () => undefined,
}));

vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: () => <span data-testid="terminal-icon" />,
}));

vi.mock("@/components/Terminal/terminalFocus", () => ({
  getTerminalFocusTarget: ({ preferredTarget }: { preferredTarget?: string }) =>
    preferredTarget ?? "terminal",
}));

// The real module reaches the panel store graph this suite stubs out.
let mockRequest: { id: string; surface: string } | null = null;
let mockHeldSurface: { id: string; surface: string } | null = null;
vi.mock("@/components/Terminal/paneFocusRequest", () => ({
  requestedPaneSurface: (id: string) => (mockRequest?.id === id ? mockRequest.surface : null),
  paneSurfaceHoldingFocus: (id: string) =>
    mockHeldSurface?.id === id ? mockHeldSurface.surface : null,
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
  // Forwards className so the overflow list's active-row marker can be asserted.
  DropdownMenuItem: ({
    children,
    className,
    onSelect,
    ...rest
  }: {
    children: React.ReactNode;
    className?: string;
    onSelect?: () => void;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button className={className} onClick={onSelect} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useDndMonitor: vi.fn(),
  closestCenter: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
  KeyboardSensor: class {},
  MouseSensor: class {},
  TouchSensor: class {},
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  horizontalListSortingStrategy: vi.fn(),
  sortableKeyboardCoordinates: vi.fn(),
  arrayMove: <T,>(arr: T[]) => arr,
}));

vi.mock("@dnd-kit/modifiers", () => ({
  restrictToHorizontalAxis: vi.fn(),
  restrictToFirstScrollableAncestor: vi.fn(),
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
import {
  DragHandleProvider,
  type DragHandleContextValue,
} from "@/components/DragDrop/DragHandleContext";
import { handleDockFocusOutside } from "../dockPopoverGuard";
import { createTerminalPaintPlane } from "@/services/TerminalInstanceService";
import { buildPanelDuplicateOptions } from "@/services/terminal/panelDuplicationService";
import { TerminalRefreshTier } from "@/types";

const terminalInstanceService = createTerminalPaintPlane();

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
    mockRequest = null;
    mockHeldSurface = null;
    vi.mocked(terminalInstanceService.focus).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // A drop or type-anywhere that asked the showing tab for its hybrid input
  // keeps it; an ask of a tab that isn't showing changes nothing.
  it.each([
    ["the active tab", "t-2", false],
    ["a tab that isn't showing", "t-1", true],
  ])("leaves a hybrid input asked of %s to its pane", (_, askedId, focusesTerminal) => {
    mockActiveDockTerminalId = "t-2";
    mockTabGroups.set("g-1", makeGroup(["t-1", "t-2"], "t-2"));
    mockRequest = { id: askedId, surface: "hybridInput" };
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];

    render(<DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-2")} panels={panels} />);

    if (focusesTerminal) {
      expect(terminalInstanceService.focus).toHaveBeenCalledWith("t-2");
    } else {
      expect(terminalInstanceService.focus).not.toHaveBeenCalled();
    }
  });

  // What the user does inside the pane stays inside it: the popover's focus
  // pass re-runs on chrome changes, and must not pull the keyboard out of the
  // input bar for a terminal home.
  it("leaves the keyboard on the active tab's hybrid input while it holds it", () => {
    mockActiveDockTerminalId = "t-2";
    mockTabGroups.set("g-1", makeGroup(["t-1", "t-2"], "t-2"));
    mockHeldSurface = { id: "t-2", surface: "hybridInput" };
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];

    render(<DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-2")} panels={panels} />);

    expect(terminalInstanceService.focus).not.toHaveBeenCalled();
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

  it("still honors a real onOpenChange(false) after mounting closed", () => {
    // Regression guard against a close path that only works when the group was
    // open at mount. Opening after mount must still arm a genuine dismissal.
    mockActiveDockTerminalId = null;
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];
    const group = makeGroup(["t-1", "t-2"], "t-1");

    const { rerender } = render(<DockedTabGroup group={group} panels={panels} />);
    mockActiveDockTerminalId = "t-1";
    rerender(<DockedTabGroup group={group} panels={panels} />);
    expect(capturedOnOpenChange).not.toBeNull();

    act(() => {
      capturedOnOpenChange?.(false);
    });

    expect(closeDockTerminalMock).toHaveBeenCalledWith("t-1");
  });

  it("does not close another group's dock pane on a spurious dismissal", () => {
    // Radix can fire onOpenChange(false) on a group that has nothing open. An
    // unqualified close would clear `activeDockTerminalId` wholesale and dismiss
    // whichever pane actually owns the dock (#11133).
    mockActiveDockTerminalId = "other-1";
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];

    render(<DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />);

    act(() => {
      capturedOnOpenChange?.(false);
    });

    expect(closeDockTerminalMock).not.toHaveBeenCalled();
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

  it("suppresses Radix auto-focus and focuses the active tab once its wrapper is moved in", () => {
    mockActiveDockTerminalId = "t-1";
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];
    render(<DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />);
    expect(capturedOnOpenAutoFocus).not.toBeNull();

    const preventDefault = vi.fn();
    act(() => {
      capturedOnOpenAutoFocus?.({ preventDefault });
    });
    expect(preventDefault).toHaveBeenCalledOnce();

    // The popover container ref settles synchronously on mount, so the active
    // tab's wrapper is moved in and focused — no MutationObserver.
    expect(terminalInstanceService.focus).toHaveBeenCalledWith("t-1");
  });

  it("does not focus an MCP-created active dock tab", () => {
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

    // focusPolicy "preserve" short-circuits the focus effect even though the
    // wrapper is moved into the popover.
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

    it("keeps the duplicate-as-new-tab (+) button outside the tablist, so its arrows never reach the strip", () => {
      mockActiveDockTerminalId = "t-1";
      const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];
      const { container } = render(
        <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
      );

      const addTabButton = container.querySelector(
        '[aria-label="Duplicate panel as new tab"]'
      ) as HTMLElement;
      const tablist = container.querySelector('[role="tablist"]') as HTMLElement;
      expect(addTabButton).not.toBeNull();
      // A tablist may own only tabs.
      expect(tablist.contains(addTabButton)).toBe(false);

      addTabButton.focus();
      fireEvent.keyDown(addTabButton, { key: "ArrowRight" });
      expect(document.activeElement).toBe(addTabButton);
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

  it("backgrounds the previous tab and promotes the new one on a tab switch (#10442)", () => {
    // Group stays open (activeDockTerminalId keeps pointing at a panel in the
    // group); only the stored active tab changes. The previously-active panel
    // must drop to BACKGROUND so it stops painting at the visible tier behind
    // the popover — the new panel goes VISIBLE via the usual RAF.
    mockActiveDockTerminalId = "t-1";
    mockTabGroups.set("g-1", makeGroup(["t-1", "t-2"], "t-1"));
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];

    const { rerender } = render(
      <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
    );

    act(() => {
      flushRaf();
    });
    expect(terminalInstanceService.applyRendererPolicy).toHaveBeenCalledWith(
      "t-1",
      TerminalRefreshTier.VISIBLE
    );
    vi.mocked(terminalInstanceService.applyRendererPolicy).mockClear();

    // Switch to tab t-2 while the group remains open.
    mockActiveDockTerminalId = "t-2";
    mockTabGroups.set("g-1", makeGroup(["t-1", "t-2"], "t-2"));
    act(() => {
      rerender(<DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-2")} panels={panels} />);
    });

    // The previous panel is downgraded synchronously; the new panel's VISIBLE
    // upgrade is still RAF-gated.
    expect(terminalInstanceService.applyRendererPolicy).toHaveBeenCalledWith(
      "t-1",
      TerminalRefreshTier.BACKGROUND
    );
    expect(terminalInstanceService.applyRendererPolicy).not.toHaveBeenCalledWith(
      "t-2",
      TerminalRefreshTier.VISIBLE
    );

    act(() => {
      flushRaf();
    });
    expect(terminalInstanceService.applyRendererPolicy).toHaveBeenCalledWith(
      "t-2",
      TerminalRefreshTier.VISIBLE
    );
  });

  it("cancels the previous tab's pending VISIBLE RAF when switching before it fires (#10442)", () => {
    // Switching tabs faster than a frame: the old panel's VISIBLE upgrade is
    // still queued. The effect cleanup must cancel it so the now-inactive panel
    // never reaches VISIBLE, while it is still downgraded to BACKGROUND.
    mockActiveDockTerminalId = "t-1";
    mockTabGroups.set("g-1", makeGroup(["t-1", "t-2"], "t-1"));
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];

    const { rerender } = render(
      <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
    );
    // Do NOT flush — t-1's VISIBLE RAF is still pending.
    expect(rafCallbacks.length).toBe(1);

    mockActiveDockTerminalId = "t-2";
    mockTabGroups.set("g-1", makeGroup(["t-1", "t-2"], "t-2"));
    act(() => {
      rerender(<DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-2")} panels={panels} />);
    });

    act(() => {
      flushRaf();
    });

    const calls = vi.mocked(terminalInstanceService.applyRendererPolicy).mock.calls;
    // t-1 was downgraded but never reached VISIBLE (its RAF was cancelled).
    expect(calls).toContainEqual(["t-1", TerminalRefreshTier.BACKGROUND]);
    expect(calls).not.toContainEqual(["t-1", TerminalRefreshTier.VISIBLE]);
    expect(calls).toContainEqual(["t-2", TerminalRefreshTier.VISIBLE]);
  });

  it("double-clicking the chip moves the active panel to the grid and closes the dock", () => {
    mockActiveDockTerminalId = "t-1";
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];
    const { container } = render(
      <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
    );

    const chip = container.querySelector(
      'button[aria-label*="double-click to move to grid"]'
    ) as HTMLButtonElement | null;
    expect(chip).not.toBeNull();

    moveTerminalToGridMock.mockReturnValue(true);
    act(() => {
      fireEvent.doubleClick(chip!);
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

    const chip = container.querySelector(
      'button[aria-label*="double-click to move to grid"]'
    ) as HTMLButtonElement | null;
    expect(chip).not.toBeNull();

    moveTerminalToGridMock.mockReturnValue(false);
    act(() => {
      fireEvent.doubleClick(chip!);
    });

    expect(moveTerminalToGridMock).toHaveBeenCalledWith("t-1");
    expect(closeDockTerminalMock).not.toHaveBeenCalled();
  });
});

describe("DockedTabGroup add-tab orphan cleanup (#10441)", () => {
  beforeEach(() => {
    mockActiveDockTerminalId = "t-1";
    mockTabGroups = new Map();
    mockTabGroups.set("g-1", makeGroup(["t-1", "t-2"]));
    addPanelMock.mockReset();
    addPanelToGroupMock.mockReset();
    vi.mocked(buildPanelDuplicateOptions).mockReset();
  });

  async function clickAddTab() {
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];
    const { container } = render(
      <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
    );
    const addTabButton = container.querySelector(
      '[aria-label="Duplicate panel as new tab"]'
    ) as HTMLElement;
    expect(addTabButton).not.toBeNull();
    // Isolate the click's side effects from any mount-time activation.
    trashPanelMock.mockClear();
    setActiveTabMock.mockClear();
    await act(async () => {
      fireEvent.click(addTabButton);
    });
  }

  it("trashes the new panel and skips activation when addPanelToGroup rejects the add", async () => {
    vi.mocked(buildPanelDuplicateOptions).mockResolvedValue({} as never);
    addPanelMock.mockResolvedValue("t-new");
    addPanelToGroupMock.mockReturnValue(false);

    await clickAddTab();

    expect(addPanelToGroupMock).toHaveBeenCalledWith("g-1", "t-new");
    expect(trashPanelMock).toHaveBeenCalledWith("t-new");
    expect(setActiveTabMock).not.toHaveBeenCalled();
  });

  it("activates the new panel and does not trash it when the add succeeds", async () => {
    vi.mocked(buildPanelDuplicateOptions).mockResolvedValue({} as never);
    addPanelMock.mockResolvedValue("t-new");
    addPanelToGroupMock.mockReturnValue(true);

    await clickAddTab();

    expect(trashPanelMock).not.toHaveBeenCalled();
    expect(setActiveTabMock).toHaveBeenCalledWith("g-1", "t-new");
  });
});

// #10797 — the group chip showed grab-cursor styling but never consumed the
// drag listeners SortableDockItem publishes via DragHandleProvider, so it
// wasn't a functional drag source. The fix forwards the pointer/touch listeners
// but deliberately drops the KeyboardSensor's onKeyDown: the chip is its own
// preview trigger, so Space/Enter must keep opening the preview rather than
// being hijacked into a keyboard drag pickup.
describe("DockedTabGroup drag wiring (#10797)", () => {
  beforeEach(() => {
    mockActiveDockTerminalId = null;
    mockTabGroups = new Map();
    mockTabGroups.set("g-1", makeGroup(["t-1", "t-2"]));
  });

  function renderInProvider(value: DragHandleContextValue) {
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];
    return render(
      <DragHandleProvider value={value}>
        <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
      </DragHandleProvider>
    );
  }

  it("forwards pointer drag events from the group chip to the dnd listeners", () => {
    const onMouseDown = vi.fn();
    const { container } = renderInProvider({
      listeners: { onMouseDown },
      setActivatorNodeRef: vi.fn(),
    });

    const chip = container.querySelector(
      'button[aria-label*="drag to reorder"]'
    ) as HTMLButtonElement;
    fireEvent.mouseDown(chip);
    expect(onMouseDown).toHaveBeenCalledTimes(1);
  });

  it("does not wire the keyboard-drag listener onto the group chip (Space/Enter stays for preview)", () => {
    const onKeyDown = vi.fn();
    const { container } = renderInProvider({
      listeners: { onKeyDown },
      setActivatorNodeRef: vi.fn(),
    });

    const chip = container.querySelector(
      'button[aria-label*="drag to reorder"]'
    ) as HTMLButtonElement;
    fireEvent.keyDown(chip, { key: "Enter" });
    fireEvent.keyDown(chip, { key: " " });
    // The KeyboardSensor's onKeyDown would call preventDefault() and start a drag
    // pickup, suppressing the native button click that opens the preview. It must
    // not be forwarded onto the chip.
    expect(onKeyDown).not.toHaveBeenCalled();
  });
});

/**
 * DockedTabGroup — dock-popover polish (#8164).
 *
 * Covers three small UI/a11y polish items on the dock tab strip:
 *   1. Duplicate-tab button uses the CopyPlus icon (not the generic Plus).
 *   2. When the active tab has scrolled into the overflow set, the chevron
 *      surfaces a neutral dot and the sr-only/aria-label text discloses it.
 *   3. The active row in the overflow dropdown carries a leading accent bar.
 */
describe("DockedTabGroup dock-popover polish (#8164)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    trashPanelMock.mockClear();
    setActiveTabMock.mockClear();
    setFocusedMock.mockClear();
    openDockTerminalMock.mockClear();
    closeDockTerminalMock.mockClear();
    moveTerminalToGridMock.mockClear();
    mockActiveDockTerminalId = "t-1";
    mockTabGroups = new Map();
    mockTabGroups.set("g-1", makeGroup(["t-1", "t-2", "t-3"]));
    mockHiddenTabIds = new Set<string>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("document tab keyboard contract", () => {
    const panels = () => [
      makePanel({ id: "t-1" }),
      makePanel({ id: "t-2" }),
      makePanel({ id: "t-3" }),
    ];

    it.each(["Delete", "Backspace"])("closes the focused tab on %s", (key) => {
      const { getByTestId } = render(
        <DockedTabGroup group={makeGroup(["t-1", "t-2", "t-3"], "t-1")} panels={panels()} />
      );
      getByTestId("tab-t-2").focus();
      act(() => {
        getByTestId("tab-t-2").dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
        );
      });
      expect(trashPanelMock).toHaveBeenCalledWith("t-2");
    });

    it("names the popover body as the region the tabs switch", () => {
      const { container } = render(
        <DockedTabGroup group={makeGroup(["t-1", "t-2", "t-3"], "t-1")} panels={panels()} />
      );
      const body = container.querySelector('[role="tabpanel"]');
      expect(body).not.toBeNull();
      expect(body!.getAttribute("aria-labelledby")).toContain("t-1");
    });
  });

  describe("duplicate-tab button icon (item 1)", () => {
    it("renders the CopyPlus glyph, not the generic Plus", () => {
      const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];
      const { container } = render(
        <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
      );

      const addTabButton = container.querySelector(
        '[aria-label="Duplicate panel as new tab"]'
      ) as HTMLElement | null;
      expect(addTabButton).not.toBeNull();

      // CopyPlus is a stacked-rectangle glyph (two <rect> elements), Plus is two
      // single <path>s with no rect. This catches an accidental regression to
      // the generic add-tab icon without coupling to internal SVG ids.
      const svg = addTabButton!.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg!.querySelectorAll("rect").length).toBeGreaterThan(0);
    });
  });

  describe("overflow chevron hidden-active cue (item 2)", () => {
    it("folds the count into aria-label and renders no dot when the active tab is visible", () => {
      mockHiddenTabIds = new Set<string>(["t-3"]);
      const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" }), makePanel({ id: "t-3" })];

      const { container } = render(
        <DockedTabGroup group={makeGroup(["t-1", "t-2", "t-3"], "t-1")} panels={panels} />
      );

      const overflowButton = container.querySelector(
        '[data-testid="dock-tabs-overflow"]'
      ) as HTMLElement | null;
      expect(overflowButton).not.toBeNull();
      // aria-label carries the count directly — the inner sr-only span would be
      // shadowed by aria-label per the accessible-name algorithm, so the count
      // lives in the label itself.
      expect(overflowButton!.getAttribute("aria-label")).toBe("Show 1 hidden tabs");
      expect(overflowButton!.querySelector("span.bg-daintree-text\\/70")).toBeNull();
    });

    it("renders the neutral dot and discloses 'including active' when the active tab is hidden", () => {
      mockHiddenTabIds = new Set<string>(["t-1", "t-3"]);
      mockActiveDockTerminalId = "t-1";
      mockTabGroups.set("g-1", makeGroup(["t-1", "t-2", "t-3"], "t-1"));
      const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" }), makePanel({ id: "t-3" })];

      const { container } = render(
        <DockedTabGroup group={makeGroup(["t-1", "t-2", "t-3"], "t-1")} panels={panels} />
      );

      const overflowButton = container.querySelector(
        '[data-testid="dock-tabs-overflow"]'
      ) as HTMLElement | null;
      expect(overflowButton).not.toBeNull();
      expect(overflowButton!.getAttribute("aria-label")).toBe(
        "Show 2 hidden tabs, including active"
      );

      const dot = overflowButton!.querySelector("span.bg-daintree-text\\/70");
      expect(dot).not.toBeNull();
      // Accent restraint: the neutral cue must NOT use any accent token.
      expect(dot!.className).not.toMatch(/(?:daintree-accent|accent-primary)(?![\w-])/);
    });
  });

  describe("overflow dropdown active marker (item 3)", () => {
    it("marks the active row with a check, the committed-value mark, and inactive rows without it", () => {
      mockHiddenTabIds = new Set<string>(["t-2", "t-3"]);
      mockActiveDockTerminalId = "t-2";
      mockTabGroups.set("g-1", makeGroup(["t-1", "t-2", "t-3"], "t-2"));
      const panels = [
        makePanel({ id: "t-1", title: "Visible" }),
        makePanel({ id: "t-2", title: "Active hidden" }),
        makePanel({ id: "t-3", title: "Inactive hidden" }),
      ];

      const { container } = render(
        <DockedTabGroup group={makeGroup(["t-1", "t-2", "t-3"], "t-2")} panels={panels} />
      );

      const rows = Array.from(container.querySelectorAll<HTMLButtonElement>("[aria-current]"));
      expect(rows.length).toBe(1);
      const activeRow = rows[0]!;
      expect(activeRow.getAttribute("aria-current")).toBe("true");
      expect(activeRow.className).toContain("font-medium");
      expect(activeRow.querySelector("svg.lucide-check")).not.toBeNull();
      // A rail would read as the highlighted row, not the tab on screen.
      expect(activeRow.className).not.toContain("before:");

      // The non-active hidden row must NOT carry the active marker.
      const allRows = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
        (b) => b !== activeRow && b.textContent?.includes("Inactive hidden")
      );
      expect(allRows.length).toBeGreaterThan(0);
      for (const row of allRows) {
        expect(row.querySelector("svg.lucide-check")).toBeNull();
        expect(row.className).not.toContain("font-medium");
      }
    });
  });

  // #11187 — plain-terminal running/finished cue aggregates across the group's
  // tabs (any plain tab working → spinner). The real useDockActivityState helper
  // runs here; deriveTerminalChrome is mocked to isAgent:false so tabs resolve
  // as plain shells.
  describe("plain-terminal group activity cue (#11187)", () => {
    it("shows a running spinner when any plain tab in the group is working", () => {
      const panels = [
        makePanel({ id: "t-1" }),
        makePanel({ id: "t-2", activityStatus: "working" }),
      ];
      const { container } = render(
        <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
      );
      expect(container.querySelector('[data-dock-activity-state="working"]')).not.toBeNull();
    });

    it("announces 'command running' in the group chip accessible name while aggregating working", () => {
      const panels = [
        makePanel({ id: "t-1" }),
        makePanel({ id: "t-2", activityStatus: "working" }),
      ];
      const { container } = render(
        <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
      );
      const chip = container.querySelector('[data-dock-item=""]') as HTMLElement | null;
      expect(chip).not.toBeNull();
      expect(chip!.getAttribute("aria-label")).toContain("command running");
    });

    it("shows no cue when every plain tab is idle", () => {
      const panels = [
        makePanel({ id: "t-1", activityStatus: "success" }),
        makePanel({ id: "t-2", activityStatus: "success" }),
      ];
      const { container } = render(
        <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
      );
      expect(container.querySelector("[data-dock-activity-state]")).toBeNull();
    });

    it("flashes a finished cue when the last running tab finishes, then clears it", () => {
      const { container, rerender } = render(
        <DockedTabGroup
          group={makeGroup(["t-1", "t-2"], "t-1")}
          panels={[
            makePanel({ id: "t-1", activityStatus: "success" }),
            makePanel({ id: "t-2", activityStatus: "working" }),
          ]}
        />
      );
      expect(container.querySelector('[data-dock-activity-state="working"]')).not.toBeNull();

      rerender(
        <DockedTabGroup
          group={makeGroup(["t-1", "t-2"], "t-1")}
          panels={[
            makePanel({ id: "t-1", activityStatus: "success" }),
            makePanel({ id: "t-2", activityStatus: "success" }),
          ]}
        />
      );
      const finished = container.querySelector('[data-dock-activity-state="finished"]');
      expect(finished).not.toBeNull();
      expect(finished!.querySelector("svg")).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(UI_TRANSIENT_HINT_DWELL_MS);
      });
      expect(container.querySelector('[data-dock-activity-state="finished"]')).toBeNull();
    });

    it("does not flash a finished cue when a running tab is removed while an idle tab remains", () => {
      const { container, rerender } = render(
        <DockedTabGroup
          group={makeGroup(["t-1", "t-2"], "t-1")}
          panels={[
            makePanel({ id: "t-1", activityStatus: "success" }),
            makePanel({ id: "t-2", activityStatus: "working" }),
          ]}
        />
      );
      expect(container.querySelector('[data-dock-activity-state="working"]')).not.toBeNull();

      // The running tab is closed; only the idle tab remains. The aggregate flips
      // working→success but membership changed, so no false completion.
      rerender(
        <DockedTabGroup
          group={makeGroup(["t-1"], "t-1")}
          panels={[makePanel({ id: "t-1", activityStatus: "success" })]}
        />
      );
      expect(container.querySelector('[data-dock-activity-state="finished"]')).toBeNull();
    });
  });
});
