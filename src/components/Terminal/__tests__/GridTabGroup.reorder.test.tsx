// @vitest-environment jsdom
/**
 * A grid tab group's tabs reorder by drag whatever kind of pane it shows
 * (#16160). The group, its panel, the pane chrome, dnd-kit and the reorder
 * itself are real; the shown pane is a stand-in that renders `ContentPanel`
 * with the tab props the browser, file, diff and terminal panes forward, and
 * nothing about reordering.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PanelInstance, TabGroup } from "@shared/types/panel";

vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
  useWorktreeStoreOptional: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
}));

vi.mock("@/hooks/useWorktreeColorMap", () => ({
  useWorktreeColorMap: () => undefined,
}));

vi.mock("@/components/DragDrop", () => ({
  useIsDragging: () => false,
}));

vi.mock("@/components/Terminal/SubagentChip", () => ({
  SubagentChip: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

vi.mock("@/store", async () => {
  const { usePanelStore } = await import("@/store/panelStore");
  return {
    usePanelStore,
    usePreferencesStore: (
      selector: (s: { showGridAgentHighlights: boolean; showAgentTaskTitles: boolean }) => unknown
    ) => selector({ showGridAgentHighlights: false, showAgentTaskTitles: false }),
  };
});

vi.mock("@/services/terminal/panelDuplicationService", () => ({
  canDuplicatePanelKind: () => false,
}));
vi.mock("@/services/terminal/optimisticPanelClose", () => ({ requestPanelClose: vi.fn() }));
vi.mock("../useContentGridContext", () => ({ addTabForPanel: vi.fn() }));

// Filled once the real ContentPanel has loaded: a factory that imported it
// would wait on itself, since the pane chrome reaches the registry too.
const registry = vi.hoisted(() => ({ definitions: {} as Record<string, unknown> }));

vi.mock("@/registry", () => ({
  getPanelKindDefinitionsSnapshot: () => registry.definitions,
  subscribeToPanelKindDefinitions: () => () => {},
}));

import { GridTabGroup } from "../GridTabGroup";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import type { TabInfo } from "@/components/Panel/TabButton";
import { usePanelStore } from "@/store/panelStore";
import { useLayoutUndoStore } from "@/store/layoutUndoStore";

interface PaneProps {
  id: string;
  title: string;
  isFocused: boolean;
  location?: "grid" | "dock" | "dialog";
  isMultiPanelGrid?: boolean;
  onFocus: () => void;
  onClose: () => void;
  tabs?: TabInfo[];
  onTabClick?: (id: string) => void;
  onTabClose?: (id: string) => void;
  onTabRename?: (id: string, title: string) => void;
  onAddTab?: () => void;
}

const standIn = (kind: string) =>
  function StandInPane(props: PaneProps) {
    return (
      <ContentPanel
        id={props.id}
        title={props.title}
        kind={kind}
        isFocused={props.isFocused}
        location={props.location}
        isMultiPanelGrid={props.isMultiPanelGrid}
        onFocus={props.onFocus}
        onClose={props.onClose}
        tabs={props.tabs}
        onTabClick={props.onTabClick}
        onTabClose={props.onTabClose}
        onTabRename={props.onTabRename}
        onAddTab={props.onAddTab}
      >
        <div />
      </ContentPanel>
    );
  };

registry.definitions = {
  terminal: { component: standIn("terminal") },
  browser: { component: standIn("browser") },
  file: { component: standIn("file") },
  diff: { component: standIn("diff") },
};

type ShownKind = "browser" | "file" | "diff" | "terminal";

const GROUP = "g-1";
const SHOWN = "shown";
const TABS = [SHOWN, "second", "third"];
const TAB_WIDTH = 100;
// dnd-kit swallows clicks for 50ms after a drop.
const CLICK_GUARD_LAPSE_MS = 60;

function shownPanel(kind: ShownKind): PanelInstance {
  const base = { id: SHOWN, title: `Shown ${kind}`, location: "grid" } as const;
  if (kind === "terminal") return { ...base, kind, cwd: "/repo", cols: 80, rows: 24 };
  return { ...base, kind };
}

function shellTab(id: string, title: string): PanelInstance {
  return { id, kind: "terminal", title, location: "grid", cwd: "/repo", cols: 80, rows: 24 };
}

function seed(kind: ShownKind) {
  const panels = [shownPanel(kind), shellTab("second", "Second"), shellTab("third", "Third")];
  const group: TabGroup = { id: GROUP, location: "grid", activeTabId: SHOWN, panelIds: TABS };
  act(() => {
    usePanelStore.setState({
      panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
      panelIds: TABS,
      tabGroups: new Map([[GROUP, group]]),
      focusedId: null,
    });
  });
}

/** The group as the grid renders it: re-read from the store, so a reorder repaints. */
function StoredGroup() {
  const group = usePanelStore((s) => s.tabGroups.get(GROUP));
  return group ? <GridTabGroup group={group} focusedId={null} isMultiPanelGrid /> : null;
}

// jsdom lays nothing out: tabs sit side by side, every box around a single tab
// is the tab's own size, and the tablist is as wide as all of them.
function stubLayout() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.getAttribute("role") === "tablist") {
      return DOMRect.fromRect({ x: 0, y: 0, width: TABS.length * TAB_WIDTH, height: 30 });
    }
    const tabEls = [...document.querySelectorAll<HTMLElement>("[data-tab-id]")];
    const inside = tabEls.filter((tab) => this.contains(tab));
    const tab = inside.length === 1 ? inside[0] : this.closest<HTMLElement>("[data-tab-id]");
    if (tab) {
      return DOMRect.fromRect({
        x: tabEls.indexOf(tab) * TAB_WIDTH,
        y: 0,
        width: TAB_WIDTH,
        height: 30,
      });
    }
    if (inside.length > 1) {
      return DOMRect.fromRect({ x: 0, y: 0, width: inside.length * TAB_WIDTH, height: 30 });
    }
    return DOMRect.fromRect({ x: 0, y: 0, width: 1200, height: 800 });
  });
}

const tabOrder = () =>
  [...document.querySelectorAll<HTMLElement>("[data-tab-id]")].map((el) => el.dataset.tabId);
const storedOrder = () => usePanelStore.getState().tabGroups.get(GROUP)?.panelIds;
const tab = (id: string) => document.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!;

function dragShownTabPastSecond() {
  fireEvent.mouseDown(tab(SHOWN), { button: 0, clientX: 50, clientY: 15 });
  fireEvent.mouseMove(document, { clientX: 60, clientY: 15 });
  act(() => {
    fireEvent.mouseMove(document, { clientX: 150, clientY: 15 });
  });
  act(() => {
    fireEvent.mouseUp(document, { clientX: 150, clientY: 15 });
  });
}

afterEach(async () => {
  // A failed assertion mid-drag skips the drop, and the sensors' document
  // listeners stay attached until a drag ends.
  act(() => {
    fireEvent.mouseUp(document);
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, CLICK_GUARD_LAPSE_MS)));
  cleanup();
  usePanelStore.setState({ panelsById: {}, panelIds: [], tabGroups: new Map(), focusedId: null });
  useLayoutUndoStore.getState().clearHistory();
  vi.restoreAllMocks();
});

const KINDS: ShownKind[] = ["browser", "file", "diff", "terminal"];

describe("GridTabGroup tab reorder (#16160)", () => {
  it.each(KINDS)("reorders the tabs by drag while a %s pane is shown", (kind) => {
    seed(kind);
    stubLayout();
    render(<StoredGroup />);
    expect(tabOrder()).toEqual(TABS);

    dragShownTabPastSecond();

    expect(storedOrder()).toEqual(["second", SHOWN, "third"]);
    expect(tabOrder()).toEqual(["second", SHOWN, "third"]);
    // The moved tab stays the one shown, and the move can be undone.
    expect(usePanelStore.getState().tabGroups.get(GROUP)?.activeTabId).toBe(SHOWN);
    expect(screen.getByRole("tabpanel").closest(`[data-panel-id="${SHOWN}"]`)).not.toBeNull();
    expect(useLayoutUndoStore.getState().undoStack).toHaveLength(1);
  });

  it.each(KINDS)("reorders the tabs by keyboard while a %s pane is shown", async (kind) => {
    seed(kind);
    stubLayout();
    render(<StoredGroup />);

    const shown = tab(SHOWN);
    act(() => shown.focus());
    fireEvent.keyDown(shown, { key: " ", code: "Space" });
    // The sensor starts listening for moves on the next task.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    act(() => {
      fireEvent.keyDown(shown, { key: "ArrowRight", code: "ArrowRight" });
    });
    act(() => {
      fireEvent.keyDown(shown, { key: " ", code: "Space" });
    });

    expect(storedOrder()).toEqual(["second", SHOWN, "third"]);
    expect(tabOrder()).toEqual(["second", SHOWN, "third"]);
  });

  it("leaves the order and the undo history alone when a drag is cancelled", async () => {
    seed("browser");
    stubLayout();
    render(<StoredGroup />);

    const shown = tab(SHOWN);
    act(() => shown.focus());
    fireEvent.keyDown(shown, { key: " ", code: "Space" });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    act(() => {
      fireEvent.keyDown(shown, { key: "ArrowRight", code: "ArrowRight" });
    });
    act(() => {
      fireEvent.keyDown(shown, { key: "Escape", code: "Escape" });
    });

    expect(storedOrder()).toEqual(TABS);
    expect(tabOrder()).toEqual(TABS);
    expect(useLayoutUndoStore.getState().undoStack).toHaveLength(0);
  });
});
