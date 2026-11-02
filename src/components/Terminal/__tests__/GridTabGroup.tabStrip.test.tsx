// @vitest-environment jsdom
/**
 * A grid tab group draws its tab strip whatever kind of pane it shows (#16159).
 * The group, its panel, the pane chrome and the dev-preview and file-browser
 * panes are real; only the panes' IPC-bound hooks and heavy leaves are stubbed.
 * The terminal tab is a stand-in that forwards the five tab props TerminalPane
 * forwards, so its strip is the one the other kinds are held to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
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

// The real duplication gate unless a test forces it, so the add-tab button can
// be checked in both states on both panes.
const duplication = vi.hoisted(() => ({ forced: null as boolean | null }));
vi.mock("@/services/terminal/panelDuplicationService", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/terminal/panelDuplicationService")>();
  return {
    ...actual,
    canDuplicatePanelKind: (kind: Parameters<typeof actual.canDuplicatePanelKind>[0]) =>
      duplication.forced ?? actual.canDuplicatePanelKind(kind),
  };
});
vi.mock("@/services/terminal/optimisticPanelClose", () => ({ requestPanelClose: vi.fn() }));
vi.mock("@/services/layout/reorderGroupTabs", () => ({ reorderGroupTabsWithUndo: vi.fn() }));
vi.mock("../useContentGridContext", () => ({ addTabForPanel: vi.fn() }));

// Dev preview: a stopped server, so the pane shows its empty state and mounts
// no guest.
vi.mock("@/hooks/useDevServer", () => ({
  useDevServer: () => ({
    status: "stopped",
    url: null,
    terminalId: null,
    error: null,
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    isRestarting: false,
  }),
}));
vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    saveSettings: vi.fn(),
    settings: null,
    detectedRunners: [],
    allDetectedRunners: [],
    isLoading: false,
    error: null,
    promoteToSaved: vi.fn(),
    removeFromSaved: vi.fn(),
    refresh: vi.fn(),
  }),
}));
vi.mock("@/hooks/useWebviewDialog", () => ({
  useWebviewDialog: () => ({ currentDialog: null, handleDialogRespond: vi.fn() }),
}));
vi.mock("@/components/Browser/BrowserToolbar", () => ({
  BrowserToolbar: () => <div data-testid="browser-toolbar" />,
}));
vi.mock("@/components/DevPreview/ConsoleDrawer", () => ({ ConsoleDrawer: () => null }));

// File browser: an empty tree with no IPC behind it.
vi.mock("@/panels/file-browser/useFileBrowserTree", () => ({
  useFileBrowserTree: () => ({
    rows: [],
    isInitialLoading: false,
    rootError: null,
    hasHiddenDotfiles: false,
    hiddenCounts: { dotfiles: 0, alwaysHidden: 0 },
    ensureLoaded: () => {},
    refresh: () => {},
    isRefreshing: false,
    captureSnapshot: () => null,
    listingPath: null,
    listingRows: null,
    listingStatus: "ready",
    listingHasHiddenDotfiles: false,
    listingHiddenCounts: { dotfiles: 0, alwaysHidden: 0 },
    selectedNode: undefined,
  }),
}));
vi.mock("@/panels/file-browser/FileTreeView", () => ({ FileTreeView: () => null }));
vi.mock("@/panels/file-browser/useWorkspaceRootPath", () => ({
  useWorkspaceRootPath: () => "/repo",
}));
vi.mock("@/hooks/useExternalChangeTick", () => ({ useExternalChangeTick: () => undefined }));

// Filled once the real panes have loaded: a factory that imported them would
// wait on itself, since the pane chrome reaches the registry too.
const registry = vi.hoisted(() => ({ definitions: {} as Record<string, unknown> }));

vi.mock("@/registry", () => ({
  getPanelKindDefinitionsSnapshot: () => registry.definitions,
  subscribeToPanelKindDefinitions: () => () => {},
}));

import { GridTabGroup } from "../GridTabGroup";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import type { TabInfo } from "@/components/Panel/TabButton";
import { DevPreviewPane } from "@/components/DevPreview/DevPreviewPane";
import { FileBrowserPane } from "@/panels/file-browser/FileBrowserPane";
import { canDuplicatePanelKind } from "@/services/terminal/panelDuplicationService";
import { requestPanelClose } from "@/services/terminal/optimisticPanelClose";
import { addTabForPanel } from "../useContentGridContext";
import { usePanelStore } from "@/store/panelStore";

interface TerminalStandInProps {
  id: string;
  title: string;
  isFocused: boolean;
  location?: "grid" | "dock" | "dialog";
  isMultiPanelGrid?: boolean;
  onFocus: () => void;
  onClose: () => void;
  tabs?: TabInfo[];
  onTabClick?: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabRename?: (tabId: string, newTitle: string) => void;
  onAddTab?: () => void;
}

function TerminalStandIn(props: TerminalStandInProps) {
  return (
    <ContentPanel
      id={props.id}
      title={props.title}
      kind="terminal"
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
}

registry.definitions = {
  terminal: { component: TerminalStandIn },
  "dev-preview": { component: DevPreviewPane },
  "file-browser": { component: FileBrowserPane },
};

const GROUP = "g-1";
const TERMINAL = "terminal-1";
const PREVIEW = "preview-1";
const FILES = "files-1";
const ORDER = [PREVIEW, TERMINAL, FILES];

const PANELS: Record<string, PanelInstance> = {
  [TERMINAL]: {
    id: TERMINAL,
    kind: "terminal",
    title: "Shell",
    location: "grid",
    cwd: "/repo",
    cols: 80,
    rows: 24,
  },
  [PREVIEW]: { id: PREVIEW, kind: "dev-preview", title: "Preview", location: "grid", cwd: "/repo" },
  [FILES]: { id: FILES, kind: "file-browser", title: "Files", location: "grid" },
};

const updateTitle = vi.fn();
const realUpdateTitle = usePanelStore.getState().updateTitle;

function seed(activeTabId: string) {
  const group: TabGroup = { id: GROUP, location: "grid", activeTabId, panelIds: ORDER };
  act(() => {
    usePanelStore.setState({
      panelsById: { ...PANELS },
      // Unlike the group's order, so a strip drawn in store order shows.
      panelIds: [...ORDER].reverse(),
      tabGroups: new Map([[GROUP, group]]),
      focusedId: null,
      updateTitle,
    });
  });
}

function mount(activeTabId: string) {
  seed(activeTabId);
  const view = render(
    <GridTabGroup group={usePanelStore.getState().tabGroups.get(GROUP)!} focusedId={null} />
  );
  const frame = (id: string) =>
    view.container.querySelector<HTMLElement>(`[data-panel-id="${id}"]`);
  const strip = () => within(view.container).getByRole("tablist", { name: "Panel tabs" });
  const tabs = () => within(strip()).getAllByRole("tab", { hidden: true });
  const tab = (id: string) => tabs().find((t) => t.dataset.tabId === id)!;
  /** The strip sits in this pane's own header, not elsewhere in its frame. */
  const stripInHeaderOf = (id: string) =>
    frame(id)?.querySelector("[data-pane-chrome]")?.contains(strip()) ?? false;
  return { ...view, frame, strip, tabs, tab, stripInHeaderOf };
}

/** What a strip shows, independent of which tab it was drawn for. */
function readStrip(tabs: HTMLElement[]) {
  return tabs.map((t) => ({ id: t.dataset.tabId, text: t.textContent }));
}

// The bridge the dev preview subscribes through while it waits for a server.
beforeEach(() => {
  const unsubscribe = () => () => {};
  const settle = () => Promise.resolve();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      window: { onDestroyHiddenWebviews: unsubscribe },
      webview: {
        registerPanel: settle,
        onDialogRequest: unsubscribe,
        onFindShortcut: unsubscribe,
        onReloadShortcut: unsubscribe,
        onCloseShortcut: unsubscribe,
        onNavigationBlocked: unsubscribe,
        onOAuthLoopbackStatus: unsubscribe,
        setLifecycleState: settle,
        getScrollPosition: () => Promise.resolve(0),
        startConsoleCapture: settle,
        stopConsoleCapture: settle,
        onConsoleMessage: unsubscribe,
        onConsoleContextCleared: unsubscribe,
        onUnresponsive: unsubscribe,
        onResponsive: unsubscribe,
      },
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "electron");
  usePanelStore.setState({
    panelsById: {},
    panelIds: [],
    tabGroups: new Map(),
    focusedId: null,
    updateTitle: realUpdateTitle,
  });
  duplication.forced = null;
  vi.clearAllMocks();
});

// Each shown kind with something only its real pane draws, so a placeholder
// ContentPanel (an unregistered kind, say) can't stand in for it.
const SHOWN = [
  ["dev-preview", PREVIEW, "browser-toolbar"],
  ["file-browser", FILES, "file-browser-tree-column"],
] as const;

/** Every other tab of the group, from each shown kind. */
const TARGETS = SHOWN.flatMap(([kind, shownId]) =>
  ORDER.filter((id) => id !== shownId).map((target) => [kind, shownId, target] as const)
);

describe("GridTabGroup tab strip on every shown kind", () => {
  it.each(SHOWN)("draws every tab, in group order, on a shown %s pane", (_kind, shownId, body) => {
    const view = mount(shownId);

    expect(view.frame(shownId)?.querySelector(`[data-testid="${body}"]`)).not.toBeNull();
    expect(view.stripInHeaderOf(shownId)).toBe(true);
    expect(view.tabs().map((t) => t.dataset.tabId)).toEqual(ORDER);
    for (const t of view.tabs()) {
      expect(t.textContent).toContain(PANELS[t.dataset.tabId!]!.title);
      expect(t.getAttribute("aria-selected")).toBe(String(t.dataset.tabId === shownId));
    }
  });

  it("draws the same strip on a shown dev preview or file browser as the terminal stand-in", () => {
    const terminal = mount(TERMINAL);
    const expected = readStrip(terminal.tabs());
    terminal.unmount();

    for (const [, shownId] of SHOWN) {
      const view = mount(shownId);
      expect(readStrip(view.tabs())).toEqual(expected);
      view.unmount();
    }
  });

  it.each(TARGETS)("switches from a shown %s pane (%s) to %s", (_kind, shownId, target) => {
    const view = mount(shownId);

    fireEvent.click(view.tab(target));

    expect(usePanelStore.getState().tabGroups.get(GROUP)?.activeTabId).toBe(target);
    expect(view.stripInHeaderOf(target)).toBe(true);
    expect(view.frame(shownId)).toBeNull();
  });

  it.each(TARGETS)("closes from a shown %s pane (%s) the tab %s", (_kind, shownId, target) => {
    const view = mount(shownId);

    const tab = view.tab(target);
    tab.focus();
    fireEvent.keyDown(tab, { key: "Delete" });

    expect(vi.mocked(requestPanelClose)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(requestPanelClose).mock.calls[0]![0].hideIds).toEqual([target]);
  });

  it.each(TARGETS)("renames from a shown %s pane (%s) the tab %s", (_kind, shownId, target) => {
    const view = mount(shownId);
    const newTitle = `Renamed ${target}`;

    fireEvent.keyDown(view.tab(target), { key: "F2" });
    const input = within(view.container).getByRole("textbox", {
      name: `Rename tab ${PANELS[target]!.title}`,
    });
    fireEvent.change(input, { target: { value: newTitle } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(updateTitle.mock.calls).toEqual([[target, newTitle]]);
  });

  it.each(SHOWN)(
    "offers to duplicate a shown %s pane exactly when its kind can be duplicated",
    (kind, shownId) => {
      const view = mount(shownId);
      expect(view.stripInHeaderOf(shownId)).toBe(true);
      const addTab = within(view.container).queryByRole("button", {
        name: "Duplicate panel as new tab",
      });

      expect(addTab !== null).toBe(canDuplicatePanelKind(kind));
    }
  );

  it.each(
    SHOWN.flatMap(([kind, shownId]) => [true, false].map((on) => [kind, shownId, on] as const))
  )(
    "draws the group's add-tab on a shown %s pane (%s) only when it hands one: %s",
    (_kind, shownId, duplicable) => {
      duplication.forced = duplicable;
      const view = mount(shownId);
      expect(view.stripInHeaderOf(shownId)).toBe(true);
      const addTab = within(view.container).queryByRole("button", {
        name: "Duplicate panel as new tab",
      });

      expect(addTab !== null).toBe(duplicable);
      if (!addTab) return;
      fireEvent.click(addTab);
      expect(vi.mocked(addTabForPanel).mock.calls.map(([panel]) => panel.id)).toEqual([shownId]);
    }
  );
});
