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
import { GridGroupTabReorderContext } from "@/components/Panel/gridGroupTabReorder";
import type { TabInfo } from "@/components/Panel/TabButton";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { usePanelStore } from "@/store/panelStore";
import { useLayoutUndoStore } from "@/store/layoutUndoStore";

interface PaneProps {
  id: string;
  title: string;
  isFocused: boolean;
  location?: "grid" | "dock" | "dialog";
  isMaximized?: boolean;
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
        isMaximized={props.isMaximized}
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

const SHOWN_BASE = { id: SHOWN, location: "grid" } as const;
const SHOWN_PANELS: Record<ShownKind, PanelInstance> = {
  browser: { ...SHOWN_BASE, kind: "browser", title: "Shown browser" },
  file: { ...SHOWN_BASE, kind: "file", title: "Shown file" },
  diff: { ...SHOWN_BASE, kind: "diff", title: "Shown diff" },
  terminal: {
    ...SHOWN_BASE,
    kind: "terminal",
    title: "Shown terminal",
    cwd: "/repo",
    cols: 80,
    rows: 24,
  },
};

function shellTab(id: string, title: string): PanelInstance {
  return { id, kind: "terminal", title, location: "grid", cwd: "/repo", cols: 80, rows: 24 };
}

function seed(kind: ShownKind) {
  const panels = [SHOWN_PANELS[kind], shellTab("second", "Second"), shellTab("third", "Third")];
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
function StoredGroup({ isMaximized = false }: { isMaximized?: boolean }) {
  const group = usePanelStore((s) => s.tabGroups.get(GROUP));
  return group ? (
    <GridTabGroup group={group} focusedId={null} isMultiPanelGrid isMaximized={isMaximized} />
  ) : null;
}

// jsdom lays nothing out: tabs sit side by side, every box around a single tab
// is the tab's own size, and the tablist is as wide as all of them. It has no
// scrollTo either, which the strip calls to bring a newly shown tab into view.
function stubLayout() {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value: () => {},
  });
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
const activeTabId = () => usePanelStore.getState().tabGroups.get(GROUP)?.activeTabId;
const shownBody = (id: string) =>
  screen.getByRole("tabpanel").closest(`[data-panel-id="${id}"]`) !== null;
const dragFlag = () => document.documentElement.dataset.dragging;
const nextTask = (ms = 0) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

function dragTranslateX(tabId: string): number {
  let node: HTMLElement | null = tab(tabId);
  while (node && !node.style.transform) node = node.parentElement;
  const match = node?.style.transform.match(/translate3d\((-?[\d.]+)px/);
  return match ? Number(match[1]) : 0;
}

/** Picks a tab up by its centre and carries it `by` pixels, the button held. */
function pickUp(tabId: string, by: number) {
  const x = TABS.indexOf(tabId) * TAB_WIDTH + TAB_WIDTH / 2;
  fireEvent.mouseDown(tab(tabId), { button: 0, clientX: x, clientY: 15 });
  fireEvent.mouseMove(document, { clientX: x + 10, clientY: 15, buttons: 1 });
  act(() => {
    fireEvent.mouseMove(document, { clientX: x + by, clientY: 15, buttons: 1 });
  });
  return x + by;
}

function dragTab(tabId: string, by: number) {
  const x = pickUp(tabId, by);
  act(() => {
    fireEvent.mouseUp(document, { clientX: x, clientY: 15 });
  });
}

const dragShownTabPastSecond = () => dragTab(SHOWN, TAB_WIDTH);

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
  delete document.documentElement.dataset.dragging;
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
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
    expect(activeTabId()).toBe(SHOWN);
    expect(shownBody(SHOWN)).toBe(true);
    act(() => useLayoutUndoStore.getState().undo());
    expect(storedOrder()).toEqual(TABS);
    expect(tabOrder()).toEqual(TABS);
    expect(activeTabId()).toBe(SHOWN);
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
    await nextTask();
    act(() => {
      fireEvent.keyDown(shown, { key: "ArrowRight", code: "ArrowRight" });
    });
    expect(dragTranslateX(SHOWN)).toBe(TAB_WIDTH);
    act(() => {
      fireEvent.keyDown(shown, { key: "Escape", code: "Escape" });
    });

    expect(dragTranslateX(SHOWN)).toBe(0);
    expect(storedOrder()).toEqual(TABS);
    expect(tabOrder()).toEqual(TABS);
    expect(useLayoutUndoStore.getState().undoStack).toHaveLength(0);

    // The strip's arrow keys are its own again once the drag is over.
    act(() => {
      fireEvent.keyDown(tab(SHOWN), { key: "ArrowRight", code: "ArrowRight" });
    });
    await nextTask(CLICK_GUARD_LAPSE_MS);
    expect(document.activeElement).toBe(tab("second"));
  });

  it("reorders from the strip of the tab it switches to", () => {
    seed("browser");
    stubLayout();
    render(<StoredGroup />);

    fireEvent.click(tab("second"));
    expect(activeTabId()).toBe("second");
    expect(shownBody("second")).toBe(true);

    dragTab("second", TAB_WIDTH);
    expect(storedOrder()).toEqual([SHOWN, "third", "second"]);
    expect(tabOrder()).toEqual([SHOWN, "third", "second"]);
    expect(activeTabId()).toBe("second");
  });

  it("reorders the tabs of a maximized group", () => {
    seed("diff");
    stubLayout();
    render(<StoredGroup isMaximized />);

    dragShownTabPastSecond();
    expect(storedOrder()).toEqual(["second", SHOWN, "third"]);
  });

  it("shields a browser pane's page from a tab drag, and takes the shield down after the drop", async () => {
    seed("browser");
    stubLayout();
    render(<StoredGroup />);

    const x = pickUp(SHOWN, TAB_WIDTH);
    expect(dragFlag()).toBe("true");
    act(() => {
      fireEvent.mouseUp(document, { clientX: x, clientY: 15 });
    });
    expect(storedOrder()).toEqual(["second", SHOWN, "third"]);
    await nextTask();
    expect(dragFlag()).toBeUndefined();
  });

  it("drops a tab drag whose release the page swallowed, and takes the next one", async () => {
    seed("browser");
    stubLayout();
    render(<StoredGroup />);

    pickUp(SHOWN, TAB_WIDTH);
    // Released over the page: the host's next move comes with no button held.
    act(() => {
      fireEvent.mouseMove(document, { clientX: 150, clientY: 300, buttons: 0 });
    });
    expect(storedOrder()).toEqual(TABS);
    await nextTask(CLICK_GUARD_LAPSE_MS);
    expect(dragFlag()).toBeUndefined();

    dragShownTabPastSecond();
    expect(storedOrder()).toEqual(["second", SHOWN, "third"]);
  });
});

describe("ContentPanel's share of a group's reorder", () => {
  const stripTabs: TabInfo[] = TABS.map((id) => ({
    id,
    title: id,
    chrome: deriveTerminalChrome(),
    kind: "terminal",
    isActive: id === SHOWN,
  }));

  function renderPanel(location: "grid" | "dock", reorderFor: string) {
    const onTabReorder = vi.fn();
    stubLayout();
    render(
      <GridGroupTabReorderContext.Provider
        value={{ panelId: reorderFor, groupId: GROUP, onTabReorder }}
      >
        <ContentPanel
          id={SHOWN}
          title="Shown"
          kind="browser"
          isFocused={false}
          location={location}
          onFocus={() => {}}
          onClose={() => {}}
          tabs={stripTabs}
          onTabClick={() => {}}
        >
          <div />
        </ContentPanel>
      </GridGroupTabReorderContext.Provider>
    );
    return onTabReorder;
  }

  it("takes the reorder for its own tab in the grid", () => {
    const onTabReorder = renderPanel("grid", SHOWN);
    dragShownTabPastSecond();
    expect(onTabReorder).toHaveBeenCalledWith(["second", SHOWN, "third"]);
  });

  it("takes no reorder meant for another tab", () => {
    const onTabReorder = renderPanel("grid", "second");
    dragShownTabPastSecond();
    expect(onTabReorder).not.toHaveBeenCalled();
  });

  it("takes no group reorder in the dock", () => {
    const onTabReorder = renderPanel("dock", SHOWN);
    expect(tabOrder()).toEqual(TABS);
    dragShownTabPastSecond();
    expect(onTabReorder).not.toHaveBeenCalled();
  });
});
