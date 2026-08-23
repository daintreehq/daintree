// @vitest-environment jsdom
/**
 * DockedTabGroup — dock-popover polish (#8164).
 *
 * Covers three small UI/a11y polish items on the dock tab strip:
 *   1. Duplicate-tab button uses the CopyPlus icon (not the generic Plus).
 *   2. When the active tab has scrolled into the overflow set, the chevron
 *      surfaces a neutral dot and the sr-only/aria-label text discloses it.
 *   3. The active row in the overflow dropdown carries a leading accent bar.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
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
let mockHiddenTabIds = new Set<string>();

function panelStoreState(): Record<string, unknown> {
  return {
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
  };
}

vi.mock("@/store", () => ({
  // A shared factory: the dock's focus effect READS the session-wide
  // `preferredTerminalFocusTarget` rather than subscribing to it, so the mock needs a
  // non-reactive accessor alongside the hook.
  usePanelStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(panelStoreState()),
    { getState: panelStoreState }
  ),
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

// Same mount-time guard simulation as DockedTabGroup.mountGuard.test.tsx; not the
// subject under test here but required for the component to mount cleanly.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => {
    useEffect(() => {
      if (open && onOpenChange) {
        onOpenChange(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <>{children}</>;
  },
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
    >
      {id}
    </button>
  ),
}));

// Forward className on DropdownMenuItem so we can assert the active-row marker.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
  PointerSensor: class {},
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
    it("marks the active row with the leading accent bar and inactive rows without it", () => {
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
      expect(activeRow.className).toContain("before:bg-accent-primary");

      // The non-active hidden row must NOT carry the active marker.
      const allRows = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
        (b) => b !== activeRow && b.textContent?.includes("Inactive hidden")
      );
      expect(allRows.length).toBeGreaterThan(0);
      for (const row of allRows) {
        expect(row.className).not.toContain("before:bg-accent-primary");
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
