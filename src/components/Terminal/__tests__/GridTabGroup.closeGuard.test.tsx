// @vitest-environment jsdom
/**
 * GridTabGroup — confirm-before-close guard for working-agent tabs (#6330, #6513).
 *
 * Closing a tab whose agent is "working" (in-flight computation) routes through
 * a destructive ConfirmDialog. Idle/waiting/directing/completed/exited tabs
 * close immediately — "waiting" and "directing" represent agent-paused states
 * where stopping is not disruptive (#6513). Alt+Click force-close on
 * PanelHeader bypasses handleTabClose entirely.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { AgentState } from "@shared/types/agent";
import type { TerminalInstance } from "@/store";
import type { TabGroup } from "@/types";

const trashPanelMock = vi.fn();
const setActiveTabMock = vi.fn();
const setFocusedMock = vi.fn();
const setMaximizedIdMock = vi.fn();
const addPanelMock = vi.fn();
const addPanelToGroupMock = vi.fn();
const reorderPanelsInGroupMock = vi.fn();
const updateTitleMock = vi.fn();

let mockTabGroups = new Map<string, TabGroup>();

interface MockState {
  setFocused: typeof setFocusedMock;
  setActiveTab: typeof setActiveTabMock;
  setMaximizedId: typeof setMaximizedIdMock;
  trashPanel: typeof trashPanelMock;
  addPanel: typeof addPanelMock;
  addPanelToGroup: typeof addPanelToGroupMock;
  reorderPanelsInGroup: typeof reorderPanelsInGroupMock;
  updateTitle: typeof updateTitleMock;
  tabGroups: Map<string, TabGroup>;
}

vi.mock("@/store", () => ({
  usePanelStore: (selector: (s: MockState) => unknown) =>
    selector({
      setFocused: setFocusedMock,
      setActiveTab: setActiveTabMock,
      setMaximizedId: setMaximizedIdMock,
      trashPanel: trashPanelMock,
      addPanel: addPanelMock,
      addPanelToGroup: addPanelToGroupMock,
      reorderPanelsInGroup: reorderPanelsInGroupMock,
      updateTitle: updateTitleMock,
      tabGroups: mockTabGroups,
    }),
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

vi.mock("../terminalFocusRegistry", () => ({
  focusPanelInput: vi.fn(),
}));

vi.mock("@/components/Layout/useDockBlockedState", () => ({
  getGroupAmbientAgentState: () => undefined,
}));

vi.mock("@/utils/terminalChrome", () => ({
  deriveTerminalChrome: () => ({ isAgent: false, color: "#abc" }),
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

// Render a stub GridPanel that exposes a per-tab close button so fireEvent
// drives React's batching properly (calling the callback bare bypasses act()
// and the ConfirmDialog state update never lands before the assertion).
vi.mock("../GridPanel", () => ({
  GridPanel: ({
    tabs,
    onTabClose,
  }: {
    tabs: Array<{ id: string }>;
    onTabClose?: (tabId: string) => void;
  }) => (
    <div data-testid="grid-panel">
      {tabs.map((t) => (
        <button key={t.id} data-testid={`close-${t.id}`} onClick={() => onTabClose?.(t.id)}>
          close {t.id}
        </button>
      ))}
    </div>
  ),
}));

// Render ConfirmDialog as a simple visible structure so we can interact with it.
vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    description,
    confirmLabel,
    cancelLabel = "Cancel",
    onConfirm,
    onClose,
    variant,
  }: {
    isOpen: boolean;
    title: React.ReactNode;
    description?: React.ReactNode;
    confirmLabel: string;
    cancelLabel?: string;
    onConfirm: () => void;
    onClose?: () => void;
    variant: string;
  }) =>
    isOpen ? (
      <div role="dialog" data-testid="confirm-dialog" data-variant={variant}>
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

import { GridTabGroup } from "../GridTabGroup";

function makePanel(overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id: "t-1",
    title: "Terminal",
    location: "grid",
    kind: "terminal",
    ...overrides,
  } as TerminalInstance;
}

function makeGroup(panelIds: string[], activeTabId = panelIds[0]!): TabGroup {
  return {
    id: "g-1",
    location: "grid",
    worktreeId: "wt-1",
    activeTabId,
    panelIds,
  };
}

describe("GridTabGroup close guard (#6330)", () => {
  beforeEach(() => {
    trashPanelMock.mockClear();
    setActiveTabMock.mockClear();
    setFocusedMock.mockClear();
    setMaximizedIdMock.mockClear();
    mockTabGroups = new Map();
    mockTabGroups.set("g-1", makeGroup(["t-1", "t-2"]));
  });

  it("closes immediately when the tab's agent is idle", () => {
    const panels = [
      makePanel({ id: "t-1", agentState: "idle" as AgentState }),
      makePanel({ id: "t-2", agentState: "idle" as AgentState }),
    ];

    const { getByTestId, queryByTestId } = render(
      <GridTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} focusedId="t-1" />
    );

    fireEvent.click(getByTestId("close-t-2"));

    expect(trashPanelMock).toHaveBeenCalledWith("t-2");
    expect(queryByTestId("confirm-dialog")).toBeNull();
  });

  it("shows the confirm dialog when closing a working agent tab", () => {
    const panels = [
      makePanel({ id: "t-1", agentState: "idle" as AgentState }),
      makePanel({ id: "t-2", agentState: "working" as AgentState }),
    ];

    const { getByTestId } = render(
      <GridTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} focusedId="t-1" />
    );

    fireEvent.click(getByTestId("close-t-2"));

    expect(trashPanelMock).not.toHaveBeenCalled();
    const dialog = getByTestId("confirm-dialog");
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute("data-variant")).toBe("destructive");
    expect(getByTestId("dialog-title").textContent).toBe("Stop this agent?");
    expect(getByTestId("dialog-description").textContent).toBe(
      "The agent is currently working. Closing this tab will stop it."
    );
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
        <GridTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} focusedId="t-1" />
      );

      fireEvent.click(getByTestId("close-t-2"));

      expect(trashPanelMock).toHaveBeenCalledWith("t-2");
      expect(queryByTestId("confirm-dialog")).toBeNull();
    }
  );

  it("trashes the tab when the user confirms", () => {
    const panels = [
      makePanel({ id: "t-1", agentState: "working" as AgentState }),
      makePanel({ id: "t-2", agentState: "idle" as AgentState }),
    ];

    const { getByTestId } = render(
      <GridTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} focusedId="t-1" />
    );

    fireEvent.click(getByTestId("close-t-1"));
    fireEvent.click(getByTestId("dialog-confirm"));

    expect(trashPanelMock).toHaveBeenCalledWith("t-1");
    // Closing the active tab should switch to the next panel before trash.
    expect(setActiveTabMock).toHaveBeenCalledWith("g-1", "t-2");
    expect(setFocusedMock).toHaveBeenCalledWith("t-2");
  });

  it("does not trash the tab when the user cancels", () => {
    const panels = [
      makePanel({ id: "t-1", agentState: "working" as AgentState }),
      makePanel({ id: "t-2", agentState: "idle" as AgentState }),
    ];

    const { getByTestId, queryByTestId } = render(
      <GridTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} focusedId="t-1" />
    );

    fireEvent.click(getByTestId("close-t-1"));
    expect(getByTestId("confirm-dialog")).toBeTruthy();

    fireEvent.click(getByTestId("dialog-cancel"));

    expect(trashPanelMock).not.toHaveBeenCalled();
    expect(queryByTestId("confirm-dialog")).toBeNull();
  });

  it("treats a panel with no agentState as idle (closes immediately)", () => {
    const panels = [makePanel({ id: "t-1" }), makePanel({ id: "t-2" })];

    const { getByTestId, queryByTestId } = render(
      <GridTabGroup group={makeGroup(["t-1", "t-2"], "t-1")} panels={panels} focusedId="t-1" />
    );

    fireEvent.click(getByTestId("close-t-2"));

    expect(trashPanelMock).toHaveBeenCalledWith("t-2");
    expect(queryByTestId("confirm-dialog")).toBeNull();
  });
});
