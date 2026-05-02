// @vitest-environment jsdom
/**
 * DockedTabGroup — confirm-before-close guard for working-agent tabs (#6330, #6513).
 *
 * Mirrors the GridTabGroup guard with one wrinkle: the dock popover collapses
 * when a body-portalled dialog mounts (Radix's onInteractOutside reads the
 * focus shift), so the close handler must call closeDockTerminal() before
 * showing the ConfirmDialog. Otherwise canceling leaves the user with no
 * popover to return to and the dialog backdrop drops onto a half-broken state.
 * The guard fires only for "working" tabs; "waiting"/"directing" close
 * immediately (#6513).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { AgentState } from "@shared/types/agent";
import type { TerminalInstance } from "@/store";
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
  useFocusStore: (selector: (s: { isFocusMode: boolean }) => unknown) =>
    selector({ isFocusMode: false }),
  usePreferencesStore: (selector: (s: { showDockAgentHighlights: boolean }) => unknown) =>
    selector({ showDockAgentHighlights: false }),
}));

let mockHiddenTabIds: ReadonlySet<string> = new Set();

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

vi.mock("../DockPanelOffscreenContainer", () => ({
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

vi.mock("@/components/Panel/SortableTabButton", () => ({
  SortableTabButton: ({ id, onClose }: { id: string; onClose: () => void }) => (
    <button data-testid={`close-${id}`} onClick={onClose}>
      close {id}
    </button>
  ),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dock-overflow-menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    ...rest
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
    [key: string]: unknown;
  }) => (
    <button {...rest} onClick={() => onSelect?.(new Event("select"))}>
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
  domMax: {},
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    description,
    confirmLabel,
    cancelLabel = "Cancel",
    onConfirm,
    onClose,
  }: {
    isOpen: boolean;
    title: React.ReactNode;
    description?: React.ReactNode;
    confirmLabel: string;
    cancelLabel?: string;
    onConfirm: () => void;
    onClose?: () => void;
  }) =>
    isOpen ? (
      <div role="dialog" data-testid="confirm-dialog">
        <h2 data-testid="dialog-title">{title}</h2>
        <p data-testid="dialog-description">{description}</p>
        <button data-testid="dialog-cancel" onClick={onClose}>
          {cancelLabel}
        </button>
        <button data-testid="dialog-confirm" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

import { DockedTabGroup } from "../DockedTabGroup";

function makePanel(overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id: "t-1",
    title: "Terminal",
    location: "dock",
    kind: "terminal",
    ...overrides,
  } as TerminalInstance;
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

describe("DockedTabGroup close guard (#6330)", () => {
  beforeEach(() => {
    trashPanelMock.mockClear();
    setActiveTabMock.mockClear();
    setFocusedMock.mockClear();
    openDockTerminalMock.mockClear();
    closeDockTerminalMock.mockClear();
    mockActiveDockTerminalId = null;
    mockTabGroups = new Map();
    mockTabGroups.set("g-1", makeGroup(["t-1", "t-2"]));
    mockHiddenTabIds = new Set();
  });

  it("closes immediately when the tab's agent is idle", () => {
    const panels = [
      makePanel({ id: "t-1", agentState: "idle" as AgentState }),
      makePanel({ id: "t-2", agentState: "idle" as AgentState }),
    ];

    const { getByTestId, queryByTestId } = render(
      <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
    );

    fireEvent.click(getByTestId("close-t-2"));

    expect(trashPanelMock).toHaveBeenCalledWith("t-2");
    expect(queryByTestId("confirm-dialog")).toBeNull();
    expect(closeDockTerminalMock).not.toHaveBeenCalled();
  });

  it("shows the confirm dialog and closes the popover for a working agent tab", () => {
    const panels = [
      makePanel({ id: "t-1", agentState: "idle" as AgentState }),
      makePanel({ id: "t-2", agentState: "working" as AgentState }),
    ];

    const { getByTestId } = render(
      <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
    );

    fireEvent.click(getByTestId("close-t-2"));

    expect(trashPanelMock).not.toHaveBeenCalled();
    expect(closeDockTerminalMock).toHaveBeenCalledTimes(1);
    expect(getByTestId("confirm-dialog")).toBeTruthy();
    expect(getByTestId("dialog-title").textContent).toBe("Stop this agent?");
    expect(getByTestId("dialog-confirm").textContent).toBe("Stop and close");
  });

  it.each(["waiting", "directing"] as const)(
    "closes a %s agent tab immediately without confirmation (#6513)",
    (state) => {
      const panels = [
        makePanel({ id: "t-1", agentState: "idle" as AgentState }),
        makePanel({ id: "t-2", agentState: state as AgentState }),
      ];

      const { getByTestId, queryByTestId } = render(
        <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
      );

      fireEvent.click(getByTestId("close-t-2"));

      expect(trashPanelMock).toHaveBeenCalledWith("t-2");
      expect(queryByTestId("confirm-dialog")).toBeNull();
      expect(closeDockTerminalMock).not.toHaveBeenCalled();
    }
  );

  it("trashes the tab when the user confirms", () => {
    const panels = [
      makePanel({ id: "t-1", agentState: "working" as AgentState }),
      makePanel({ id: "t-2", agentState: "idle" as AgentState }),
    ];

    const { getByTestId } = render(
      <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
    );

    fireEvent.click(getByTestId("close-t-1"));
    fireEvent.click(getByTestId("dialog-confirm"));

    expect(trashPanelMock).toHaveBeenCalledWith("t-1");
    expect(setActiveTabMock).toHaveBeenCalledWith("g-1", "t-2");
    expect(setFocusedMock).toHaveBeenCalledWith("t-2");
  });

  it("does not trash the tab when the user cancels", () => {
    const panels = [
      makePanel({ id: "t-1", agentState: "working" as AgentState }),
      makePanel({ id: "t-2", agentState: "idle" as AgentState }),
    ];

    const { getByTestId, queryByTestId } = render(
      <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
    );

    fireEvent.click(getByTestId("close-t-1"));
    fireEvent.click(getByTestId("dialog-cancel"));

    expect(trashPanelMock).not.toHaveBeenCalled();
    expect(queryByTestId("confirm-dialog")).toBeNull();
  });

  it("reopens the dock popover for the kept tab on cancel", () => {
    const panels = [
      makePanel({ id: "t-1", agentState: "working" as AgentState }),
      makePanel({ id: "t-2", agentState: "idle" as AgentState }),
    ];

    const { getByTestId } = render(
      <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
    );

    fireEvent.click(getByTestId("close-t-1"));
    expect(closeDockTerminalMock).toHaveBeenCalledTimes(1);

    openDockTerminalMock.mockClear();
    fireEvent.click(getByTestId("dialog-cancel"));

    expect(openDockTerminalMock).toHaveBeenCalledWith("t-1");
  });
});

describe("DockedTabGroup tab overflow menu (#6429)", () => {
  beforeEach(() => {
    trashPanelMock.mockClear();
    setActiveTabMock.mockClear();
    setFocusedMock.mockClear();
    openDockTerminalMock.mockClear();
    closeDockTerminalMock.mockClear();
    mockActiveDockTerminalId = null;
    mockTabGroups = new Map();
    mockTabGroups.set("g-1", makeGroup(["t-1", "t-2", "t-3"]));
    mockHiddenTabIds = new Set();
  });

  it("does not render the overflow trigger when no dock tabs are hidden", () => {
    const panels = [
      makePanel({ id: "t-1", agentState: "idle" as AgentState }),
      makePanel({ id: "t-2", agentState: "idle" as AgentState }),
    ];
    const { queryByTestId } = render(
      <DockedTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} />
    );
    expect(queryByTestId("dock-tabs-overflow")).toBeNull();
  });

  it("renders the overflow trigger when dock tabs are hidden", () => {
    mockHiddenTabIds = new Set(["t-3"]);
    const panels = [
      makePanel({ id: "t-1", title: "Alpha", agentState: "idle" as AgentState }),
      makePanel({ id: "t-2", title: "Beta", agentState: "idle" as AgentState }),
      makePanel({ id: "t-3", title: "Gamma", agentState: "idle" as AgentState }),
    ];
    const { getByTestId } = render(
      <DockedTabGroup group={makeGroup(["t-1", "t-2", "t-3"], "t-1")} panels={panels} />
    );
    const trigger = getByTestId("dock-tabs-overflow");
    expect(trigger.getAttribute("aria-label")).toBe("Show hidden tabs");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    const menu = getByTestId("dock-overflow-menu");
    expect(menu.textContent).toContain("Gamma");
    expect(menu.textContent).not.toContain("Alpha");
  });

  it("activates and focuses a hidden dock tab when its menu item is selected", () => {
    mockHiddenTabIds = new Set(["t-3"]);
    const panels = [
      makePanel({ id: "t-1", title: "Alpha", agentState: "idle" as AgentState }),
      makePanel({ id: "t-2", title: "Beta", agentState: "idle" as AgentState }),
      makePanel({ id: "t-3", title: "Gamma", agentState: "idle" as AgentState }),
    ];
    const { getByTestId } = render(
      <DockedTabGroup group={makeGroup(["t-1", "t-2", "t-3"], "t-1")} panels={panels} />
    );
    const menu = getByTestId("dock-overflow-menu");
    const item = Array.from(menu.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Gamma")
    );
    item?.click();
    expect(setActiveTabMock).toHaveBeenCalledWith("g-1", "t-3");
    expect(setFocusedMock).toHaveBeenCalledWith("t-3");
    expect(openDockTerminalMock).toHaveBeenCalledWith("t-3");
  });
});
