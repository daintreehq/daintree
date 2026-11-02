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

function seed(activeTabId: string) {
  const group: TabGroup = { id: GROUP, location: "grid", activeTabId, panelIds: ORDER };
  act(() => {
    usePanelStore.setState({
      panelsById: { ...PANELS },
      panelIds: [...ORDER],
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
  return { ...view, frame, strip, tabs, tab };
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
  });
  vi.clearAllMocks();
});

const SHOWN = [
  ["dev-preview", PREVIEW],
  ["file-browser", FILES],
] as const;

describe("GridTabGroup tab strip on every shown kind", () => {
  it.each(SHOWN)("draws every tab, in group order, on a shown %s pane", (_kind, shownId) => {
    const view = mount(shownId);

    // The strip is the shown pane's own header, not a stray one.
    expect(view.frame(shownId)?.contains(view.strip())).toBe(true);
    expect(view.tabs().map((t) => t.dataset.tabId)).toEqual(ORDER);
    for (const t of view.tabs()) {
      expect(t.textContent).toContain(PANELS[t.dataset.tabId!]!.title);
      expect(t.getAttribute("aria-selected")).toBe(String(t.dataset.tabId === shownId));
    }
  });

  it("draws the same strip on a shown dev preview or file browser as on a shown terminal", () => {
    const terminal = mount(TERMINAL);
    const expected = readStrip(terminal.tabs());
    terminal.unmount();

    for (const [, shownId] of SHOWN) {
      const view = mount(shownId);
      expect(readStrip(view.tabs())).toEqual(expected);
      view.unmount();
    }
  });

  it.each(SHOWN)("switches to another tab from a shown %s pane", (_kind, shownId) => {
    const view = mount(shownId);
    const target = ORDER.find((id) => id !== shownId)!;

    fireEvent.click(view.tab(target));

    expect(usePanelStore.getState().tabGroups.get(GROUP)?.activeTabId).toBe(target);
    expect(view.frame(target)?.contains(view.strip())).toBe(true);
    expect(view.frame(shownId)).toBeNull();
  });

  it.each(SHOWN)("closes the tab it was asked to from a shown %s pane", (_kind, shownId) => {
    const view = mount(shownId);
    const target = ORDER.find((id) => id !== shownId)!;

    const tab = view.tab(target);
    tab.focus();
    fireEvent.keyDown(tab, { key: "Delete" });

    expect(vi.mocked(requestPanelClose)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(requestPanelClose).mock.calls[0]![0].hideIds).toEqual([target]);
  });

  it.each(SHOWN)("renames the tab it was asked to from a shown %s pane", (_kind, shownId) => {
    const view = mount(shownId);
    const target = ORDER.find((id) => id !== shownId)!;

    fireEvent.keyDown(view.tab(target), { key: "F2" });
    const input = within(view.container).getByRole("textbox", {
      name: `Rename tab ${PANELS[target]!.title}`,
    });
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(updateTitle).toHaveBeenCalledWith(target, "Renamed");
  });

  it.each(SHOWN)(
    "offers to duplicate a shown %s pane exactly when its kind can be duplicated",
    (kind, shownId) => {
      const view = mount(shownId);
      expect(view.frame(shownId)?.contains(view.strip())).toBe(true);
      const addTab = within(view.container).queryByRole("button", {
        name: "Duplicate panel as new tab",
      });

      expect(addTab !== null).toBe(canDuplicatePanelKind(kind));
      if (!addTab) return;
      fireEvent.click(addTab);
      expect(vi.mocked(addTabForPanel)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(addTabForPanel).mock.calls[0]![0].id).toBe(shownId);
    }
  );
});
