// @vitest-environment jsdom
import { render, act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";

// FileBrowserPane hosts the tree column beside the viewer. #11328 adds a
// collapse toggle (in the viewer's header) that unmounts the tree column and a
// shared header height so the divider line reads continuous. These tests drive
// the pane with the heavy tree/viewer leaves stubbed, but keep the REAL
// FileBrowserViewer so the toggle and the shared toolbar `Root` actually render
// — that's what makes the aria-controls and header-alignment invariants real.

// The real DropdownMenu lazy-loads Radix and renders its content as null until
// that resolves, so the view-options menu — which now carries Refresh — would be
// unreachable here. Rendered inline and always open: these tests are about which
// layout OWNS the control, not about Radix's open/close machinery.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <button type="button">{children}</button>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div role="menu">{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onSelect,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    "data-testid"?: string;
  }) => (
    <button type="button" role="menuitem" data-testid={testId} onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuRadioGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioItem: ({ children }: { children: React.ReactNode }) => (
    <div role="menuitemradio">{children}</div>
  ),
  DropdownMenuCheckboxItem: ({
    children,
    checked,
    onCheckedChange,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    "data-testid"?: string;
  }) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      data-state={checked ? "checked" : "unchecked"}
      data-testid={testId}
      onClick={() => {
        onCheckedChange(!checked);
      }}
    >
      {children}
    </button>
  ),
}));

const {
  setFileBrowserViewMock,
  readMock,
  treeState,
  defaultRows,
  treeArgs,
  worktreeTicks,
  worktreeMock,
} = vi.hoisted(() => {
  const defaultRows = [
    {
      path: "src",
      name: "src",
      isDirectory: true,
      depth: 0,
      isExpanded: true,
      isLoading: false,
    },
    // A file row so a selection can resolve a real viewer path.
    {
      path: "src/app.ts",
      name: "app.ts",
      isDirectory: false,
      depth: 1,
      isExpanded: false,
      isLoading: false,
    },
  ];
  return {
    setFileBrowserViewMock: vi.fn(),
    readMock: vi.fn(),
    defaultRows,
    // Mutable so individual tests can drive error/loading/capture states.
    treeState: {
      rows: defaultRows as typeof defaultRows,
      isInitialLoading: false,
      rootError: null as string | null,
      hasHiddenDotfiles: false,
      hiddenCounts: { dotfiles: 0, alwaysHidden: 0 },
      ensureLoaded: vi.fn(),
      refresh: vi.fn(),
      isRefreshing: false,
      captureSnapshot: (() => null) as () => unknown,
      // Folder-listing surface (#11620). Defaulted to "no folder is being
      // listed" so every case below keeps exercising the file/empty branches;
      // `selectedNode` is filled in per render by the mock factory, which is
      // where the selected path is actually known.
      listingPath: null as string | null,
      listingRows: null as unknown[] | null,
      listingStatus: "ready" as "pending" | "ready" | "error",
      listingHasHiddenDotfiles: false,
    },
    // What the pane last handed the tree hook, so a test can assert the derived
    // change tick rather than only what renders.
    treeArgs: {
      changeTick: undefined as number | undefined,
      sort: undefined as { key: string; direction: string } | undefined,
      selectedPath: undefined as string | null | undefined,
    },
    // Ticks the worktree store reports for wt-1; both default to "never moved".
    worktreeTicks: { git: undefined as number | undefined, fs: undefined as number | undefined },
    // The rest of what the store reports for wt-1. `changes` stays null by
    // default so the bulk of this suite keeps the lastUpdated-only snapshot
    // shape it was written against — which is also a real runtime state (the
    // pane must not read a snapshot that hasn't populated yet).
    worktreeMock: {
      path: "/repo",
      changes: null as { path: string; status: string }[] | null,
      changesRootPath: "/repo",
    },
  };
});

interface MockPanel {
  id: string;
  kind: "file-browser";
  browserSelectedPath?: string;
  browserExpandedPaths?: string[];
  browserShowIgnored?: boolean;
  browserHideDotfiles?: boolean;
  browserRootPath?: string;
  browserSidebarCollapsed?: boolean;
  browserViewerCollapsed?: boolean;
  browserSidebarWidth?: number;
  browserWorkspaceRooted?: boolean;
}

const mockPanel: MockPanel = { id: "fb-1", kind: "file-browser" };
// A second browser panel, for the case where a tab group reuses one component
// instance across two of them.
const mockPanelTwo: MockPanel = { id: "fb-2", kind: "file-browser" };

// Mutable so a dock test can make this panel the active dock panel (or not) —
// the pane defers its reveal refresh while parked offscreen (#11588).
const dockState = { activeDockTerminalId: null as string | null };

vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (state: unknown) => unknown) =>
    selector({
      panelsById: { "fb-1": mockPanel, "fb-2": mockPanelTwo },
      setFileBrowserView: setFileBrowserViewMock,
      activeDockTerminalId: dockState.activeDockTerminalId,
    }),
}));

// #11588: returning to a cached project view. A real listener registry rather
// than a bare stub so unsubscribe-on-unmount is observable.
//
// `vi.hoisted`, not a plain const: this suite transitively pulls a module that
// subscribes at module scope, so the factory's `subscribeProjectViewLifecycle`
// runs while a module-scope `const` would still be in its TDZ. That throws
// during collection — and vitest still exits 0, so the whole file silently
// stops running while the summary reads green.
type LifecyclePhase = "cached" | "active" | "revealed";
const lifecycleListeners = vi.hoisted(() => new Set<(phase: LifecyclePhase) => void>());
// Every runtime export, not just the one this pane imports: a factory is a
// strict surface, and a module elsewhere in the graph reaching for a missing
// name fails the whole file at collection rather than at the call.
vi.mock("@/lib/viewCacheState", () => ({
  subscribeProjectViewLifecycle: (listener: (phase: LifecyclePhase) => void) => {
    lifecycleListeners.add(listener);
    return () => {
      lifecycleListeners.delete(listener);
    };
  },
  // The real module's own safe default — the un-demoted answer.
  isProjectViewCached: () => false,
  __resetProjectViewCacheStateForTests: () => {
    lifecycleListeners.clear();
  },
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (state: unknown) => unknown) =>
    selector({
      worktrees: new Map([
        [
          "wt-1",
          {
            path: worktreeMock.path,
            worktreeChanges:
              worktreeTicks.git === undefined && worktreeMock.changes === null
                ? undefined
                : {
                    lastUpdated: worktreeTicks.git,
                    // Only present once a test supplies them: the shipped store
                    // populates all three together, but the pane must survive a
                    // snapshot that carries the tick alone.
                    ...(worktreeMock.changes === null
                      ? {}
                      : {
                          changes: worktreeMock.changes,
                          rootPath: worktreeMock.changesRootPath,
                        }),
                  },
          },
        ],
      ]),
      // The pane reads the raw filesystem-write side map for its change tick
      // (#11330); an absent map would crash the `.get(worktreeId)` selector.
      workingTreeChangedAtById: new Map<string, number>(
        worktreeTicks.fs === undefined ? [] : [["wt-1", worktreeTicks.fs]]
      ),
    }),
}));

// The tree data hook does real IPC + virtualization; stub it to a mutable
// state bag so the tree column renders its header (and the FileTreeView stub
// below) without touching filesClient, and tests can drive error states.
vi.mock("../useFileBrowserTree", () => ({
  useFileBrowserTree: (args: {
    changeTick?: number;
    sort?: { key: string; direction: string };
    selectedPath?: string | null;
  }) => {
    treeArgs.changeTick = args.changeTick;
    treeArgs.sort = args.sort;
    treeArgs.selectedPath = args.selectedPath;
    // The real hook resolves this against its listings map; here the stubbed
    // rows are the only data there is, so match by path against them. That
    // reproduces what the pane used to compute for itself, keeping the
    // selection cases below unchanged by the move (#11620).
    const selectedNode =
      args.selectedPath == null
        ? undefined
        : treeState.rows.find((row) => row.path === args.selectedPath);
    return { ...treeState, selectedNode };
  },
}));

// The pane flushes panel persistence when the view hides; the real module
// drags the whole store graph into the suite.
const { flushPanelPersistenceMock } = vi.hoisted(() => ({
  flushPanelPersistenceMock: vi.fn(),
}));
vi.mock("@/store/slices", () => ({
  flushPanelPersistence: flushPanelPersistenceMock,
}));

// The stub renders the pane's own row context menu for one synthetic directory
// row, which is the only way to reach "Copy context" without the real tree.
// Radix is swapped for plain buttons below so the item is directly clickable.
const FOLDER_ROW = {
  path: "src/[draft]",
  name: "[draft]",
  isDirectory: true,
  depth: 0,
  isExpanded: false,
};
// A file row alongside it, so the pane's mapping onto the shared file-row menu
// (#11757) is exercised on the branch that actually has open/diff items.
const FILE_ROW = {
  path: "src/index.ts",
  name: "index.ts",
  isDirectory: false,
  depth: 1,
  isExpanded: false,
};
/** Flip to render FILE_ROW's menu instead of FOLDER_ROW's. */
const { renderFileRowRef } = vi.hoisted(() => ({
  renderFileRowRef: { current: false },
}));

// `onActivate` is captured rather than driven through a real row: Enter and
// double-click both land on it, and the pane's own file-vs-directory guard is
// what these tests are after.
const { treeProps } = vi.hoisted(() => ({
  treeProps: {
    onActivate: undefined as ((path: string) => void) | undefined,
    onInsertFileReference: undefined as ((path: string) => void) | undefined,
    canInsertFileReference: undefined as boolean | undefined,
    basePath: undefined as string | undefined,
    onSelect: undefined as ((path: string, isDirectory: boolean) => void) | undefined,
    onToggleExpanded: undefined as ((path: string, expand: boolean) => void) | undefined,
    cursorPath: undefined as string | null | undefined,
    openPath: undefined as string | null | undefined,
    // The derived git model the pane hands the tree. Captured rather than
    // rendered: what this suite owns is the derivation and the join, while how a
    // marker is drawn belongs to FileTreeView's own suite.
    gitStatusIndex: undefined as FileBrowserGitStatusIndex | null | undefined,
  },
}));
vi.mock("../FileTreeView", () => ({
  FileTreeView: ({
    rowContextMenu,
    onSelect,
    onToggleExpanded,
    onActivate,
    onInsertFileReference,
    canInsertFileReference,
    basePath,
    cursorPath,
    openPath,
    gitStatusIndex,
  }: {
    rowContextMenu?: (row: unknown) => React.ReactNode;
    onSelect?: (path: string, isDirectory: boolean) => void;
    onToggleExpanded?: (path: string, expand: boolean) => void;
    onActivate?: (path: string) => void;
    onInsertFileReference?: (path: string) => void;
    canInsertFileReference?: boolean;
    basePath?: string;
    cursorPath?: string | null;
    openPath?: string | null;
    gitStatusIndex?: FileBrowserGitStatusIndex | null;
  }) => {
    treeProps.onSelect = onSelect;
    treeProps.onToggleExpanded = onToggleExpanded;
    treeProps.cursorPath = cursorPath;
    treeProps.openPath = openPath;
    treeProps.onActivate = onActivate;
    treeProps.onInsertFileReference = onInsertFileReference;
    treeProps.canInsertFileReference = canInsertFileReference;
    treeProps.basePath = basePath;
    treeProps.gitStatusIndex = gitStatusIndex;
    return (
      <div data-testid="file-tree-view" role="tree" tabIndex={-1}>
        {/* Opt-in: both rows render the same shared core, so having them up at
            once would make every "Copy path"/"Copy context" query ambiguous. */}
        {renderFileRowRef.current ? (
          <div data-testid="file-row-menu">{rowContextMenu?.(FILE_ROW)}</div>
        ) : (
          rowContextMenu?.(FOLDER_ROW)
        )}
      </div>
    );
  },
}));

// The real hook subscribes to the panel/terminal/fleet stores; the pane's
// contract is only that it joins basePath and hands the result over.
const { insertFileReferenceMock, canInsertRef } = vi.hoisted(() => ({
  insertFileReferenceMock: vi.fn<(path: string) => boolean>(() => true),
  canInsertRef: { current: true },
}));
vi.mock("@/hooks/useInsertFileReference", () => ({
  useInsertFileReference: () => ({
    canInsert: canInsertRef.current,
    // The pane only reads the boolean; the reason is here so the shared menu
    // item renders the same shape it does in production.
    refusalReason: canInsertRef.current ? null : "multiple-eligible-agents",
    insert: insertFileReferenceMock,
  }),
}));

vi.mock("@/components/ui/context-menu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/context-menu")>()),
  ContextMenuItem: ({
    children,
    onSelect,
    ...rest
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    // `rest` is forwarded so `disabled` and `aria-keyshortcuts` stay assertable
    // — a stub that swallowed them would let a broken gate pass.
    <button onClick={onSelect} {...rest}>
      {children}
    </button>
  ),
  // Stubbed explicitly: the real `ContextMenuActionItem` closes over the
  // module's own `ContextMenuItem`, so replacing that export alone would leave
  // every action item rendering the real (portal-only) primitive.
  ContextMenuActionItem: ({
    children,
    actionId,
    args,
    onSelect,
    ...rest
  }: {
    children: React.ReactNode;
    actionId: string;
    args?: unknown;
    onSelect?: () => void;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button
      onClick={() => {
        onSelect?.();
        void dispatchMock(actionId, args, { source: "context-menu" });
      }}
      {...rest}
    >
      {children}
    </button>
  ),
  ContextMenuShortcut: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  ContextMenuSeparator: () => null,
  // Flat, always-rendered stand-ins for the submenu primitives (#12206). The
  // real ones need a Radix menu root this harness never mounts, and gate their
  // content behind an open state — so every nested "Copy path" assertion here
  // would look for something that is not in the DOM and pass for the wrong
  // reason. What this suite owns is which path each item names, not Radix's
  // nesting; the hook's own suite drives the real submenus.
  ContextMenuSub: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuSubTrigger: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  // Marked rather than bare so a test can still tell a root row from a nested
  // one — flattening is what makes the items reachable here, and it is also
  // what would otherwise hide a regression that moved something up to the root.
  ContextMenuSubContent: ({ children }: { children: React.ReactNode }) => (
    <div data-submenu-content="">{children}</div>
  ),
  ContextMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// The view's own workspace root, behind a worktree-less browser (#11482). The
// real hook reads the project/scratch stores against the seeded view identity;
// this stands in for that resolution so the pane's branching is what's tested.
const { workspaceRootPathMock } = vi.hoisted(() => ({
  workspaceRootPathMock: vi.fn<() => string>(() => ""),
}));
vi.mock("../useWorkspaceRootPath", () => ({
  useWorkspaceRootPath: () => workspaceRootPathMock(),
}));

// The live signal for a root no worktree covers (#11590). Mocked so a test can
// drive the tick directly and so the real hook's IPC poll never runs here —
// without this the pane would depend on a `window.electron` jsdom doesn't have.
const { externalChangeTickMock } = vi.hoisted(() => ({
  externalChangeTickMock: vi.fn<(root: string, paths: readonly string[]) => number | undefined>(
    () => undefined
  ),
}));
vi.mock("@/hooks/useExternalChangeTick", () => ({
  NO_WATCHED_PATHS: Object.freeze([]),
  useExternalChangeTick: (root: string, paths: readonly string[], enabled: boolean) =>
    enabled ? externalChangeTickMock(root, paths) : undefined,
}));

const { copyContextWithFeedbackMock } = vi.hoisted(() => ({
  copyContextWithFeedbackMock: vi.fn<
    typeof import("@/hooks/useWorktreeActions").copyContextWithFeedback
  >(() => Promise.resolve()),
}));
vi.mock("@/hooks/useWorktreeActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useWorktreeActions")>()),
  copyContextWithFeedback: copyContextWithFeedbackMock,
}));

// The header's copy affordance raises the pane's clipboard-failure toast. Only
// `notify` is replaced — the module's other exports stay real, since shadowing
// them breaks unrelated consumers in this tree.
const { notifyMock } = vi.hoisted(() => ({
  notifyMock: vi.fn<typeof import("@/lib/notify").notify>(),
}));
vi.mock("@/lib/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify")>()),
  notify: notifyMock,
}));

// ContentPanel is chrome around the body; render just the children so the
// pane's own layout is what's under test.
vi.mock("@/components/Panel/ContentPanel", () => ({
  ContentPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Viewer leaf modules the real FileBrowserViewer imports. Stubbed so their heavy
// renderers stay out of the suite; CodeViewer surfaces a marker so a selected
// file's viewer is observable across a collapse.
vi.mock("@/clients/filesClient", () => ({ filesClient: { read: readMock } }));
// Row activation dispatches `file.openPanel` through here; the default is the
// success shape so tests that don't care about failure don't have to arrange it.
const { dispatchMock } = vi.hoisted(() => ({
  dispatchMock:
    vi.fn<
      (
        id: string,
        args?: unknown,
        opts?: unknown
      ) => Promise<{ ok: true; result: unknown } | { ok: false; error: { message: string } }>
    >(),
}));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));
vi.mock("@/components/Markdown/MarkdownViewer", () => ({ MarkdownViewer: () => null }));
vi.mock("@/components/FileViewer/CodeViewer", () => ({
  CodeViewer: () => <div data-testid="code-viewer" />,
}));
vi.mock("@/components/Html/HtmlViewer", () => ({ HtmlViewer: () => null }));

import { FileBrowserPane } from "../FileBrowserPane";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { UI_ACTION_SUCCESS_DWELL_MS } from "@/lib/animationUtils";
import {
  FILE_BROWSER_SIDEBAR_DEFAULT_WIDTH as DEFAULT_W,
  FILE_BROWSER_SIDEBAR_MIN_WIDTH as MIN_W,
  FILE_BROWSER_SIDEBAR_MAX_WIDTH as MAX_W,
  FILE_BROWSER_SIDEBAR_RESIZE_STEP as STEP_W,
  FILE_BROWSER_SIDEBAR_RESIZE_STEP_COARSE as COARSE_W,
} from "../sidebarWidth";
import { TooltipProvider } from "@/components/ui/tooltip";
import { revealCopy } from "@/components/FileViewer/revealCopy";
import {
  getFileBrowserRowGitStatus,
  type FileBrowserGitStatusIndex,
} from "../fileBrowserGitStatus";

function paneJsx(props: { worktreeId?: string } = { worktreeId: "wt-1" }) {
  return (
    <TooltipProvider>
      <FileBrowserPane
        id="fb-1"
        title="Files"
        {...props}
        isFocused
        location="grid"
        onFocus={vi.fn()}
        onClose={vi.fn()}
      />
    </TooltipProvider>
  );
}

function renderPane(props: { worktreeId?: string } = { worktreeId: "wt-1" }) {
  return render(paneJsx(props));
}

function classToken(el: Element, predicate: (cls: string) => boolean): string | undefined {
  return Array.from(el.classList).find(predicate);
}

// jsdom ships no `navigator.clipboard`; the header copy gesture writes through it.
let writeTextMock: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

beforeEach(() => {
  setFileBrowserViewMock.mockReset();
  readMock.mockReset();
  readMock.mockResolvedValue({ content: "hello" });
  flushPanelPersistenceMock.mockReset();
  notifyMock.mockReset();
  copyContextWithFeedbackMock.mockClear();
  workspaceRootPathMock.mockReset();
  workspaceRootPathMock.mockReturnValue("");
  externalChangeTickMock.mockReset();
  externalChangeTickMock.mockReturnValue(undefined);
  // Module-global and never reset by the store itself, so a message left by an
  // earlier test would satisfy the next one's announcement assertion.
  useAnnouncerStore.setState({ polite: null, assertive: null });
  writeTextMock = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    writable: true,
    configurable: true,
    value: { writeText: writeTextMock },
  });
  treeState.rows = defaultRows;
  treeState.rootError = null;
  treeState.isInitialLoading = false;
  treeState.captureSnapshot = () => null;
  // Created once in `vi.hoisted`, so without these the manual-refresh call
  // counts and the spinner state would leak between tests.
  treeState.refresh.mockClear();
  treeState.isRefreshing = false;
  mockPanel.browserSidebarCollapsed = undefined;
  mockPanel.browserViewerCollapsed = undefined;
  mockPanel.browserSelectedPath = undefined;
  mockPanel.browserRootPath = undefined;
  mockPanel.browserShowIgnored = undefined;
  mockPanel.browserSidebarWidth = undefined;
  mockPanel.browserWorkspaceRooted = undefined;
  mockPanel.browserExpandedPaths = undefined;
  treeArgs.changeTick = undefined;
  treeProps.onActivate = undefined;
  treeProps.onInsertFileReference = undefined;
  treeProps.canInsertFileReference = undefined;
  treeProps.basePath = undefined;
  treeProps.onSelect = undefined;
  treeProps.onToggleExpanded = undefined;
  treeProps.cursorPath = undefined;
  treeProps.openPath = undefined;
  insertFileReferenceMock.mockClear();
  canInsertRef.current = true;
  renderFileRowRef.current = false;
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({ ok: true, result: { panelId: "file-1" } });
  worktreeTicks.git = undefined;
  worktreeTicks.fs = undefined;
  worktreeMock.path = "/repo";
  worktreeMock.changes = null;
  worktreeMock.changesRootPath = "/repo";
  treeProps.gitStatusIndex = undefined;
  lifecycleListeners.clear();
  dockState.activeDockTerminalId = null;
  for (const name of ["matchMedia"] as const) {
    if (typeof window[name] !== "function") {
      Object.defineProperty(window, name, {
        writable: true,
        configurable: true,
        value: vi.fn().mockImplementation((query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
      });
    }
  }
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

describe("FileBrowserPane collapsible sidebar (#11328)", () => {
  it("renders the tree column when open and names it from the toggle's aria-controls", () => {
    renderPane();

    expect(screen.getByTestId("file-tree-view")).toBeTruthy();
    const toggle = screen.getByTestId("file-browser-sidebar-toggle");
    const controlsId = toggle.getAttribute("aria-controls");
    // The disclosure names a region that actually exists in the DOM — not a
    // dangling id.
    expect(controlsId).toBeTruthy();
    expect(document.getElementById(controlsId!)).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("unmounts the tree column when collapsed and drops the dangling aria-controls", () => {
    const { rerender } = renderPane();
    const controlsId = screen
      .getByTestId("file-browser-sidebar-toggle")
      .getAttribute("aria-controls");
    expect(document.getElementById(controlsId!)).not.toBeNull();

    mockPanel.browserSidebarCollapsed = true;
    rerender(
      <TooltipProvider>
        <FileBrowserPane
          id="fb-1"
          title="Files"
          worktreeId="wt-1"
          isFocused
          location="grid"
          onFocus={vi.fn()}
          onClose={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(screen.queryByTestId("file-tree-view")).toBeNull();
    const toggle = screen.getByTestId("file-browser-sidebar-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.hasAttribute("aria-controls")).toBe(false);
    // The named region is gone, so nothing resolves the old id either.
    expect(document.getElementById(controlsId!)).toBeNull();
  });

  it("shares one height and border token between the two header bars", () => {
    renderPane();

    const treeColumn = document.getElementById(
      screen.getByTestId("file-browser-sidebar-toggle").getAttribute("aria-controls")!
    )!;
    // The tree column's own header row (border-b) sits beside the viewer toolbar.
    const sidebarHeader = treeColumn.querySelector<HTMLElement>(":scope > div")!;
    const toolbarRoot = screen
      .getByTestId("file-browser-sidebar-toggle")
      .closest<HTMLElement>("[class~='border-b']")!;

    const vPad = (el: Element) => classToken(el, (c) => /^py-/.test(c));
    const borderColor = (el: Element) =>
      classToken(el, (c) => c === "border-overlay" || c === "border-border-default");
    const iconSize = (el: Element) => classToken(el.querySelector("svg")!, (c) => /^h-/.test(c));

    // Guard against a vacuous undefined === undefined pass.
    expect(sidebarHeader).not.toBe(toolbarRoot);
    expect(vPad(sidebarHeader)).toBeDefined();
    expect(borderColor(sidebarHeader)).toBeDefined();
    expect(iconSize(sidebarHeader)).toBeDefined();

    // Relational invariant: whatever the shared toolbar uses, the sidebar header
    // matches it — so the line under the two bars reads continuous. A regression
    // that reverts one side (py-1 / border-border-default / h-3.5 icons) fails
    // here. Icon height is the row's tallest child, so it drives the height parity.
    expect(vPad(sidebarHeader)).toBe(vPad(toolbarRoot));
    expect(borderColor(sidebarHeader)).toBe(borderColor(toolbarRoot));
    expect(iconSize(sidebarHeader)).toBe(iconSize(toolbarRoot));
  });

  it("toggles the persisted collapsed state on click, inverting the current value", () => {
    renderPane();

    act(() => {
      screen
        .getByTestId("file-browser-sidebar-toggle")
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(setFileBrowserViewMock).toHaveBeenCalledWith("fb-1", {
      browserSidebarCollapsed: true,
    });
  });

  it("re-opens from the collapsed state, so the toggle inverts rather than always collapsing", () => {
    // Without this, a handler hardcoded to always write `true` would pass every
    // other test while stranding the user in a collapsed tree they can't reopen.
    mockPanel.browserSidebarCollapsed = true;
    renderPane();

    act(() => {
      screen
        .getByTestId("file-browser-sidebar-toggle")
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(setFileBrowserViewMock).toHaveBeenCalledWith("fb-1", {
      browserSidebarCollapsed: false,
    });
  });

  it("keeps the selected file's viewer mounted when the sidebar collapses", async () => {
    mockPanel.browserSelectedPath = "src/app.ts";
    const { rerender } = renderPane();
    // The viewer resolves and renders the (stubbed) code viewer for the selection.
    await waitFor(() => expect(screen.getByTestId("code-viewer")).toBeTruthy());
    expect(screen.getByTestId("file-tree-view")).toBeTruthy();

    mockPanel.browserSidebarCollapsed = true;
    rerender(
      <TooltipProvider>
        <FileBrowserPane
          id="fb-1"
          title="Files"
          worktreeId="wt-1"
          isFocused
          location="grid"
          onFocus={vi.fn()}
          onClose={vi.fn()}
        />
      </TooltipProvider>
    );

    // The viewer lives in the non-collapsing column, so collapsing the tree must
    // not blank or reload it — only the tree column disappears.
    expect(screen.queryByTestId("file-tree-view")).toBeNull();
    expect(screen.getByTestId("code-viewer")).toBeTruthy();
  });

  it("keeps keyboard focus on the toggle across a collapse", () => {
    const { rerender } = renderPane();
    const toggle = screen.getByTestId("file-browser-sidebar-toggle");
    act(() => toggle.focus());
    expect(document.activeElement).toBe(toggle);

    mockPanel.browserSidebarCollapsed = true;
    rerender(
      <TooltipProvider>
        <FileBrowserPane
          id="fb-1"
          title="Files"
          worktreeId="wt-1"
          isFocused
          location="grid"
          onFocus={vi.fn()}
          onClose={vi.fn()}
        />
      </TooltipProvider>
    );

    // The single persistent Root keeps the same toggle node, so focus survives
    // the tree column unmounting rather than falling to <body>.
    expect(document.activeElement).toBe(screen.getByTestId("file-browser-sidebar-toggle"));
  });
});

describe("root error rendering (#11367)", () => {
  it("renders the error inline above a populated tree rather than replacing it", () => {
    treeState.rootError = "boom";
    renderPane();

    // Both at once: the banner names a refresh failure, the last-known rows
    // stay on screen beneath it.
    expect(screen.getByText("Couldn't refresh this worktree")).toBeTruthy();
    expect(screen.getByTestId("file-tree-view")).toBeTruthy();
  });

  it("keeps the full-pane error when there are genuinely no rows to show", () => {
    treeState.rootError = "boom";
    treeState.rows = [];
    renderPane();

    // Generic "folder" copy: the same banner now covers a scratch or
    // worktree-less project root, which is not a worktree (#11482).
    expect(screen.getByText("Couldn't read this folder")).toBeTruthy();
    expect(screen.queryByTestId("file-tree-view")).toBeNull();
  });
});

describe("last-known tree capture (#11367)", () => {
  const snapshot = {
    worktreeId: "wt-1",
    rootPath: "",
    listings: [{ dirPath: "", nodes: [{ name: "src", path: "src", isDirectory: true }] }],
  };

  function hideDocument() {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  }

  afterEach(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });

  it("captures and flushes when the view hides — the going-away point that precedes eviction", () => {
    treeState.captureSnapshot = () => snapshot;
    renderPane();
    expect(setFileBrowserViewMock).not.toHaveBeenCalledWith("fb-1", {
      browserTreeSnapshot: snapshot,
    });

    hideDocument();

    expect(setFileBrowserViewMock).toHaveBeenCalledWith("fb-1", {
      browserTreeSnapshot: snapshot,
    });
    // The hidden renderer may be torn down before the 500ms persistence
    // debounce fires; the flush is what makes this save real on app quit.
    expect(flushPanelPersistenceMock).toHaveBeenCalled();
  });

  it("captures the outgoing tree on unmount for the next restore", () => {
    treeState.captureSnapshot = () => snapshot;
    const { unmount } = renderPane();
    unmount();

    expect(setFileBrowserViewMock).toHaveBeenCalledWith("fb-1", {
      browserTreeSnapshot: snapshot,
    });
  });

  it("writes nothing when there is nothing worth keeping", () => {
    treeState.captureSnapshot = () => null;
    const { unmount } = renderPane();
    hideDocument();
    unmount();

    // A null capture must not clobber a previously persisted snapshot.
    expect(setFileBrowserViewMock).not.toHaveBeenCalled();
  });
});

describe("FileBrowserPane resizable sidebar (#11331)", () => {
  // A fresh element per call: React's reconciler bails on a referentially-equal
  // root element, so reusing one constant across two rerenders would silently
  // skip the second (the mock store is only re-read when the tree reconciles).
  const paneJsx = () => (
    <TooltipProvider>
      <FileBrowserPane
        id="fb-1"
        title="Files"
        worktreeId="wt-1"
        isFocused
        location="grid"
        onFocus={vi.fn()}
        onClose={vi.fn()}
      />
    </TooltipProvider>
  );

  function treeColumn(): HTMLElement {
    const controlsId = screen
      .getByTestId("file-browser-sidebar-toggle")
      .getAttribute("aria-controls")!;
    return document.getElementById(controlsId)!;
  }

  function separator(): HTMLElement {
    return screen.getByTestId("file-browser-sidebar-resize");
  }

  // A width the store setter can't produce by default (min < X < max, not the
  // default) so the assertion proves the wiring carried the stored value, not a
  // coincidental default.
  const STORED = MIN_W + 137;

  // Make the (otherwise non-reactive) panel-store mock stateful, so a sequence
  // of interactions reads the width the previous one wrote — the only way to
  // test cumulative keyboard steps and a real collapse→reopen restore.
  function makeStoreStateful() {
    setFileBrowserViewMock.mockImplementation((_id: string, patch: Partial<MockPanel>) => {
      Object.assign(mockPanel, patch);
    });
  }

  it("drives the tree column width and separator value from the stored width", () => {
    mockPanel.browserSidebarWidth = STORED;
    renderPane();

    expect(treeColumn().style.width).toBe(`${STORED}px`);
    expect(separator().getAttribute("aria-valuenow")).toBe(String(STORED));
  });

  it("falls back to the default width when none is stored", () => {
    renderPane();

    // Wiring, not a copied literal: the rendered width tracks the module default,
    // whatever it is, so changing the constant can't silently strand this.
    expect(treeColumn().style.width).toBe(`${DEFAULT_W}px`);
    expect(separator().getAttribute("aria-valuenow")).toBe(String(DEFAULT_W));
  });

  it("names the separator and points aria-controls at the resolvable tree column", () => {
    renderPane();
    // Query by the accessible role + name so a broken aria-label actually fails.
    const handle = screen.getByRole("separator", { name: "Resize file tree" });

    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuemin")).toBe(String(MIN_W));
    expect(handle.getAttribute("aria-valuemax")).toBe(String(MAX_W));
    expect(handle.tabIndex).toBe(0);
    // aria-controls resolves to the actual tree column, not a dangling id.
    const controls = handle.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls!)).toBe(treeColumn());
  });

  it("widens on a rightward drag and narrows on a leftward drag, writing every move", () => {
    mockPanel.browserSidebarWidth = STORED;
    renderPane();
    const handle = separator();

    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 150, buttons: 1 }); // +50
    fireEvent.mouseMove(document, { clientX: 80, buttons: 1 }); // -20 vs start
    fireEvent.mouseUp(document);

    // Continuous writes, one per move, delta derived from the mousedown-captured
    // start — expectations computed from the inputs, not hard-coded pixels.
    expect(setFileBrowserViewMock).toHaveBeenNthCalledWith(1, "fb-1", {
      browserSidebarWidth: STORED + 50,
    });
    expect(setFileBrowserViewMock).toHaveBeenNthCalledWith(2, "fb-1", {
      browserSidebarWidth: STORED - 20,
    });

    // Releasing ends the drag: a later move must not keep resizing.
    setFileBrowserViewMock.mockClear();
    fireEvent.mouseMove(document, { clientX: 500, buttons: 1 });
    expect(setFileBrowserViewMock).not.toHaveBeenCalled();
  });

  it("clamps a drag past either bound to the min and max", () => {
    renderPane(); // default
    const handle = separator();

    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 100 + (MAX_W - DEFAULT_W) + 500, buttons: 1 }); // past max
    fireEvent.mouseMove(document, { clientX: 100 - (DEFAULT_W - MIN_W) - 500, buttons: 1 }); // past min
    fireEvent.mouseUp(document);

    expect(setFileBrowserViewMock).toHaveBeenNthCalledWith(1, "fb-1", {
      browserSidebarWidth: MAX_W,
    });
    expect(setFileBrowserViewMock).toHaveBeenNthCalledWith(2, "fb-1", {
      browserSidebarWidth: MIN_W,
    });
  });

  it("mounts a drag shield only while resizing so a child iframe can't swallow the drag", () => {
    renderPane();
    expect(screen.queryByTestId("file-browser-resize-shield")).toBeNull();

    fireEvent.mouseDown(separator(), { clientX: 100 });
    expect(screen.getByTestId("file-browser-resize-shield")).toBeTruthy();

    fireEvent.mouseUp(document);
    expect(screen.queryByTestId("file-browser-resize-shield")).toBeNull();
  });

  it("ends the drag when the button is released off-document (buttons === 0)", () => {
    renderPane();
    const handle = separator();

    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 150, buttons: 1 }); // a real move writes
    expect(setFileBrowserViewMock).toHaveBeenCalledTimes(1);

    // Released over the iframe / outside the window: the next move reports no
    // buttons, so the drag self-terminates instead of wedging.
    fireEvent.mouseMove(document, { clientX: 200, buttons: 0 });
    fireEvent.mouseMove(document, { clientX: 260, buttons: 1 });
    expect(setFileBrowserViewMock).toHaveBeenCalledTimes(1); // no writes after recovery
    expect(screen.queryByTestId("file-browser-resize-shield")).toBeNull();
  });

  it("ignores the second mousedown of a double-click so the reset doesn't jitter first", () => {
    renderPane();
    const handle = separator();

    // detail > 1 is the browser's synthetic second mousedown before dblclick.
    fireEvent.mouseDown(handle, { clientX: 100, detail: 2 });
    fireEvent.mouseMove(document, { clientX: 300, buttons: 1 });

    // No drag listener was attached, so the move writes nothing.
    expect(setFileBrowserViewMock).not.toHaveBeenCalled();
  });

  it("does not start a drag from a non-primary mouse button", () => {
    renderPane();

    fireEvent.mouseDown(separator(), { clientX: 100, button: 2 });
    fireEvent.mouseMove(document, { clientX: 300, buttons: 2 });

    expect(setFileBrowserViewMock).not.toHaveBeenCalled();
  });

  it("resets to the default width on double-click", () => {
    mockPanel.browserSidebarWidth = MAX_W;
    renderPane();

    fireEvent.doubleClick(separator());

    expect(setFileBrowserViewMock).toHaveBeenCalledWith("fb-1", { browserSidebarWidth: DEFAULT_W });
  });

  it("steps by the fine step, coarsens under Shift, and jumps to the bounds", () => {
    renderPane(); // default
    const handle = separator();

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(setFileBrowserViewMock).toHaveBeenLastCalledWith("fb-1", {
      browserSidebarWidth: DEFAULT_W + STEP_W,
    });

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(setFileBrowserViewMock).toHaveBeenLastCalledWith("fb-1", {
      browserSidebarWidth: DEFAULT_W - STEP_W,
    });

    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(setFileBrowserViewMock).toHaveBeenLastCalledWith("fb-1", {
      browserSidebarWidth: DEFAULT_W + COARSE_W,
    });

    fireEvent.keyDown(handle, { key: "Home" });
    expect(setFileBrowserViewMock).toHaveBeenLastCalledWith("fb-1", { browserSidebarWidth: MIN_W });

    fireEvent.keyDown(handle, { key: "End" });
    expect(setFileBrowserViewMock).toHaveBeenLastCalledWith("fb-1", { browserSidebarWidth: MAX_W });
  });

  it("accumulates keyboard steps against the live width, not a stale base", () => {
    makeStoreStateful();
    const { rerender } = renderPane(); // default

    fireEvent.keyDown(separator(), { key: "ArrowRight" }); // +1 step
    rerender(paneJsx());
    fireEvent.keyDown(separator(), { key: "ArrowRight" }); // +2 steps, reading the live width
    rerender(paneJsx());

    // A handler reading a stale base would stall at +1 step; the width must
    // compound across presses.
    expect(mockPanel.browserSidebarWidth).toBe(DEFAULT_W + 2 * STEP_W);
    expect(treeColumn().style.width).toBe(`${DEFAULT_W + 2 * STEP_W}px`);

    fireEvent.keyDown(separator(), { key: "ArrowLeft" }); // back down one
    rerender(paneJsx());
    expect(mockPanel.browserSidebarWidth).toBe(DEFAULT_W + STEP_W);
  });

  it("ignores keys that aren't resize controls", () => {
    renderPane();

    fireEvent.keyDown(separator(), { key: "a" });

    expect(setFileBrowserViewMock).not.toHaveBeenCalled();
  });

  it("renders no resize separator while the sidebar is collapsed", () => {
    mockPanel.browserSidebarCollapsed = true;
    renderPane();

    expect(screen.queryByTestId("file-browser-sidebar-resize")).toBeNull();
  });

  it("keeps a resized width across a real collapse and reopen (driven through the store)", () => {
    makeStoreStateful();
    const { rerender } = renderPane();

    // Widen to the max via the keyboard; the stateful store now holds it.
    fireEvent.keyDown(separator(), { key: "End" });
    rerender(paneJsx());
    expect(mockPanel.browserSidebarWidth).toBe(MAX_W);

    // Collapse via the toggle — the pane writes only the collapsed flag, so a
    // regression that also cleared the width here would strand the reopen.
    fireEvent.click(screen.getByTestId("file-browser-sidebar-toggle"));
    rerender(paneJsx());
    expect(screen.queryByTestId("file-browser-sidebar-resize")).toBeNull();
    expect(mockPanel.browserSidebarWidth).toBe(MAX_W);

    // Reopen — the width is restored from the store, not reset to default.
    fireEvent.click(screen.getByTestId("file-browser-sidebar-toggle"));
    rerender(paneJsx());
    expect(treeColumn().style.width).toBe(`${MAX_W}px`);
  });

  it("drops the document listeners when the pane unmounts mid-drag", () => {
    const { unmount } = renderPane();

    fireEvent.mouseDown(separator(), { clientX: 100 });
    unmount();
    // The unmount effect fired the drag cleanup, so this move reaches no listener.
    fireEvent.mouseMove(document, { clientX: 400, buttons: 1 });

    expect(setFileBrowserViewMock).not.toHaveBeenCalled();
  });

  it("drops the document listeners when the sidebar collapses mid-drag", () => {
    const { rerender } = renderPane();

    fireEvent.mouseDown(separator(), { clientX: 100 });
    // Collapse unmounts the grip but not the pane, so a dedicated effect must
    // fire the same cleanup — otherwise the document listeners keep writing.
    mockPanel.browserSidebarCollapsed = true;
    rerender(paneJsx());
    fireEvent.mouseMove(document, { clientX: 400, buttons: 1 });

    expect(setFileBrowserViewMock).not.toHaveBeenCalled();
  });
});

describe("tree-header root path copy (#11407)", () => {
  const ROOT = "src/panels";
  // The worktree in the store mock is `/repo`, so this is what a row's
  // "Copy path" would produce for the same folder.
  const ABSOLUTE = "/repo/src/panels";

  const paneJsx = () => (
    <TooltipProvider>
      <FileBrowserPane
        id="fb-1"
        title="Files"
        worktreeId="wt-1"
        isFocused
        location="grid"
        onFocus={vi.fn()}
        onClose={vi.fn()}
      />
    </TooltipProvider>
  );

  function copyButton(): HTMLElement {
    return screen.getByRole("button", { name: /copy folder path/i });
  }

  /** The header label, whichever element currently occupies that slot. */
  function label(): HTMLElement {
    const treeColumn = document.getElementById(
      screen.getByTestId("file-browser-sidebar-toggle").getAttribute("aria-controls")!
    )!;
    const header = treeColumn.querySelector<HTMLElement>(":scope > div")!;
    return header.querySelector<HTMLElement>("[class~='flex-1']")!;
  }

  function lastAnnouncement() {
    return useAnnouncerStore.getState().polite;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves the label inert at the worktree root", () => {
    // No rootPath — the label is a bare basename, not a path worth copying.
    render(paneJsx());

    expect(screen.queryByRole("button", { name: /copy folder path/i })).toBeNull();

    const el = label();
    expect(el.tagName).toBe("SPAN");
    // Not focusable, and the hover text still resolves the worktree.
    expect(el.hasAttribute("tabindex")).toBe(false);
    expect(el.getAttribute("title")).toBe("/repo");

    fireEvent.click(el);
    expect(writeTextMock).not.toHaveBeenCalled();
  });

  it("stays inert when the root is set but the worktree cannot be resolved", () => {
    // A restored panel can carry a root for a worktree the store has not (or no
    // longer) resolves — there is no absolute path to build, so no affordance.
    mockPanel.browserRootPath = ROOT;
    render(
      <TooltipProvider>
        <FileBrowserPane
          id="fb-1"
          title="Files"
          worktreeId="wt-missing"
          isFocused
          location="grid"
          onFocus={vi.fn()}
          onClose={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(screen.queryByRole("button", { name: /copy folder path/i })).toBeNull();
    expect(label().tagName).toBe("SPAN");
  });

  it("copies the absolute path, not the relative text it displays", async () => {
    mockPanel.browserRootPath = ROOT;
    render(paneJsx());

    const button = copyButton();
    // A native button, not a role-annotated div: that's what makes it reachable
    // by Tab and activatable by Enter/Space without bespoke key handling.
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    // The visible label stays the compact relative path…
    expect(button.textContent).toBe(ROOT);
    // …while the accessible name names what actually lands on the clipboard.
    expect(button.getAttribute("aria-label")).toContain(ABSOLUTE);

    await act(async () => {
      fireEvent.click(button);
    });

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith(ABSOLUTE);
  });

  it("announces the copy and keeps the accessible name stable", async () => {
    mockPanel.browserRootPath = ROOT;
    render(paneJsx());

    const button = copyButton();
    const nameBefore = button.getAttribute("aria-label");
    const announcedBefore = lastAnnouncement();

    await act(async () => {
      fireEvent.click(button);
    });

    const announced = lastAnnouncement();
    expect(announced?.msg).toBe("Path copied");
    // A fresh entry, not the one some earlier test left behind.
    expect(announced?.id).not.toBe(announcedBefore?.id);
    // The live region is the sole SR signal; a label that flipped to "Copied"
    // would double-announce.
    expect(button.getAttribute("aria-label")).toBe(nameBefore);
  });

  it("shows copied feedback for the dwell window, then restores the idle styling", async () => {
    vi.useFakeTimers();
    mockPanel.browserRootPath = ROOT;
    render(paneJsx());

    const idle = copyButton().className;

    await act(async () => {
      fireEvent.click(copyButton());
    });
    const copied = copyButton().className;
    expect(copied).not.toBe(idle);

    // Still lit just before the shared dwell elapses.
    act(() => {
      vi.advanceTimersByTime(UI_ACTION_SUCCESS_DWELL_MS - 1);
    });
    expect(copyButton().className).toBe(copied);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(copyButton().className).toBe(idle);
  });

  it("drops stale feedback when the tree is re-rooted inside the dwell window", async () => {
    vi.useFakeTimers();
    mockPanel.browserRootPath = ROOT;
    const { rerender } = render(paneJsx());

    const idle = copyButton().className;
    await act(async () => {
      fireEvent.click(copyButton());
    });
    expect(copyButton().className).not.toBe(idle);

    // Up one level, well inside the dwell: the success color would otherwise
    // describe a folder the header no longer points at.
    mockPanel.browserRootPath = "src";
    rerender(paneJsx());

    expect(copyButton().className).toBe(idle);
  });

  it("reports a failed write and lets Retry complete the copy", async () => {
    mockPanel.browserRootPath = ROOT;
    writeTextMock.mockRejectedValueOnce(new Error("denied"));
    render(paneJsx());

    const announcedBefore = lastAnnouncement();
    const idle = copyButton().className;

    await act(async () => {
      fireEvent.click(copyButton());
    });

    // A silent failure would leave the previous clipboard contents in place.
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = notifyMock.mock.calls[0]?.[0];
    expect(payload?.type).toBe("error");
    expect(payload?.action?.label).toBe("Retry");
    // The inbox drops onClick actions, so a demoted toast would lose the Retry.
    expect(payload?.priority).toBe("high");
    expect(payload?.context?.eventKind).toBe("uiFeedback");
    // Naming the origin surface marks the failure as already visible there and
    // suppresses the toast — but this label shows nothing when a write fails,
    // so the Retry would become unreachable.
    expect(payload?.context?.panelId).toBeUndefined();
    expect(payload?.context?.worktreeId).toBeUndefined();
    // Nothing claims success: no announcement, no lit label.
    expect(lastAnnouncement()?.id).toBe(announcedBefore?.id);
    expect(copyButton().className).toBe(idle);

    await act(async () => {
      await payload?.action?.onClick();
    });

    // A Retry that never re-wrote would still satisfy a "last call" assertion,
    // since the failed attempt already passed ABSOLUTE — so count the writes.
    expect(writeTextMock).toHaveBeenCalledTimes(2);
    expect(writeTextMock.mock.calls[1]?.[0]).toBe(ABSOLUTE);
    // The retry re-enters the whole gesture, so feedback lands on the second try.
    const announced = lastAnnouncement();
    expect(announced?.msg).toBe("Path copied");
    expect(announced?.id).not.toBe(announcedBefore?.id);
    expect(copyButton().className).not.toBe(idle);
    // The successful retry raises no second toast.
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});

describe("file row context menu", () => {
  // The pane's job here is the mapping: it turns a tree row into the shared
  // menu's target (#11757). What the menu then renders is the hook's own
  // contract, so these assert the join and the gating, not the item list.
  function renderFileRow() {
    renderFileRowRef.current = true;
    renderPane();
    return screen.getByTestId("file-row-menu");
  }

  it("joins the row path onto the browser root for the path-scoped actions", async () => {
    const menu = renderFileRow();

    await act(async () => {
      fireEvent.click(within(menu).getByRole("button", { name: "Copy path" }));
    });

    expect(writeTextMock).toHaveBeenCalledWith(`/repo/${FILE_ROW.path}`);
  });

  it("copies the row path verbatim as the relative path", async () => {
    const menu = renderFileRow();

    await act(async () => {
      fireEvent.click(within(menu).getByRole("button", { name: "Copy relative path" }));
    });

    // `row.path` is already relative to the true root even when the tree has
    // been re-rooted, so re-deriving it would double-prefix a correct value.
    expect(writeTextMock).toHaveBeenCalledWith(FILE_ROW.path);
  });

  it("offers no diff for a file git reported no change on", () => {
    const menu = renderFileRow();

    expect(within(menu).queryByRole("button", { name: "Open diff" })).toBeNull();
    // …while the rest of the core is still there: a file must not lose Copy
    // path by which panel happens to list it.
    expect(within(menu).getByRole("button", { name: "Copy path" })).toBeTruthy();
  });

  it("offers the diff once the file appears in the worktree's changes", () => {
    worktreeMock.changes = [{ path: FILE_ROW.path, status: "modified" }];
    const menu = renderFileRow();

    expect(within(menu).getByRole("button", { name: "Open diff" })).toBeTruthy();
  });
});

describe("folder context menu", () => {
  async function copyFolderContext() {
    renderPane();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy context" }));
    });
    return copyContextWithFeedbackMock.mock.calls[0]?.[2];
  }

  it("scopes the copy to the folder instead of building a match pattern", async () => {
    const options = await copyFolderContext();

    expect(options?.scopePaths).toEqual([FOLDER_ROW.path]);
    // Patterns are what made the folder copy diverge from a whole-worktree one.
    expect(options?.includePaths).toBeUndefined();
  });

  it("sends the row path untouched, with no escaping or glob suffix", async () => {
    const options = await copyFolderContext();

    // `src/[draft]` survives verbatim: scope takes literal paths, so escaping
    // it for minimatch would now name a folder that doesn't exist.
    expect(options?.scopePaths?.[0]).toBe(FOLDER_ROW.path);
  });

  it("targets the worktree the pane is bound to", async () => {
    renderPane();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy context" }));
    });

    expect(copyContextWithFeedbackMock).toHaveBeenCalledWith(
      "wt-1",
      "context-menu",
      expect.anything(),
      // The dispatch source cannot tell this apart from a worktree-card copy,
      // so the pane names its own surface for the run history (#11732).
      "file-browser"
    );
  });
});

/** #11577: send a row to the last agent without dragging it there. */
describe("insert file reference", () => {
  const insertItem = () => screen.getByRole("button", { name: /Insert file reference/ });

  it("hands the agent an absolute path built from the browser's base", () => {
    renderPane();
    fireEvent.click(insertItem());

    // Absolute, matching what a Finder drop into the hybrid input produces —
    // a bare row path would name nothing the agent can open.
    expect(insertFileReferenceMock).toHaveBeenCalledWith(`/repo/${FOLDER_ROW.path}`);
  });

  it("joins against the workspace root for a worktree-less browser", () => {
    workspaceRootPathMock.mockReturnValue("/scratches/one");
    renderPane({});
    fireEvent.click(insertItem());

    expect(insertFileReferenceMock).toHaveBeenCalledWith(`/scratches/one/${FOLDER_ROW.path}`);
  });

  it("disables the item when no agent resolves", () => {
    canInsertRef.current = false;
    renderPane();

    expect(insertItem().hasAttribute("disabled")).toBe(true);
    // The hint would be a lie on a dead item.
    expect(insertItem().hasAttribute("aria-keyshortcuts")).toBe(false);
  });

  it("offers no menu at all when nothing resolves a base path", () => {
    // The pane shows its placeholder instead of a tree, so there is no row to
    // right-click — the handler's own basePath guard is belt-and-braces, not
    // the reachable gate.
    renderPane({});
    expect(screen.queryByRole("button", { name: /Insert file reference/ })).toBeNull();
  });

  it("advertises the shortcut on the live item", () => {
    renderPane();
    expect(insertItem().getAttribute("aria-keyshortcuts")).toBeTruthy();
  });

  it("gives the tree the same handler and gate as the menu", () => {
    // Both gestures must resolve one target the same way; a tree wired to a
    // different callback would drift from the menu silently.
    renderPane();
    expect(treeProps.canInsertFileReference).toBe(true);
    treeProps.onInsertFileReference?.(FOLDER_ROW.path);
    expect(insertFileReferenceMock).toHaveBeenCalledWith(`/repo/${FOLDER_ROW.path}`);
  });

  it("closes the tree's gate when the pane's is closed", () => {
    canInsertRef.current = false;
    renderPane();
    expect(treeProps.canInsertFileReference).toBe(false);
  });

  // The tree's rows are relative, so the drag source (#11576) needs the same
  // absolute base the menu's own join uses.
  it("hands the tree the base path its rows are relative to", () => {
    renderPane();
    expect(treeProps.basePath).toBe("/repo");
  });

  // `row.path` stays relative to the true source root after a re-root, so the
  // base must not follow the tree down. Joining the two would spell
  // `/repo/src/src/App.tsx` for every dragged row.
  it("keeps the base at the source root when the tree is re-rooted", () => {
    mockPanel.browserRootPath = "src";
    renderPane();
    expect(treeProps.basePath).toBe("/repo");
  });
});

/**
 * #11482: a scratch or worktree-less project has no worktree, so the pane roots
 * itself at the view's own workspace folder instead of showing the placeholder.
 */
describe("workspace-rooted browser", () => {
  it("browses the workspace folder when the panel names no worktree", () => {
    workspaceRootPathMock.mockReturnValue("/scratches/one");
    renderPane({});

    expect(screen.getByTestId("file-tree-view")).toBeTruthy();
    expect(screen.queryByText("Open a folder to browse its files")).toBeNull();
  });

  it("shows the placeholder only when nothing at all resolves", () => {
    // No worktree and no workspace — the genuinely unbound case.
    renderPane({});
    expect(screen.getByText("Open a folder to browse its files")).toBeTruthy();
  });

  it("joins copied paths against the workspace root, not the worktree", async () => {
    workspaceRootPathMock.mockReturnValue("/scratches/one");
    renderPane({});

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
    });

    expect(writeTextMock).toHaveBeenCalledWith(`/scratches/one/${FOLDER_ROW.path}`);
  });

  it("hides Copy context for a workspace root", () => {
    // CopyTree is worktree-scoped, so an enabled item here would be a dead
    // affordance rather than a degraded one.
    workspaceRootPathMock.mockReturnValue("/scratches/one");
    renderPane({});

    expect(screen.queryByRole("button", { name: "Copy context" })).toBeNull();
  });

  it("keeps Copy context for a worktree", () => {
    renderPane();
    expect(screen.getByRole("button", { name: "Copy context" })).toBeTruthy();
  });

  it("does not fall back to the workspace when a named worktree hasn't resolved", () => {
    // Opening the project root in place of the requested worktree would be the
    // wrong folder, not a degraded one.
    workspaceRootPathMock.mockReturnValue("/projects/a");
    renderPane({ worktreeId: "wt-missing" });

    expect(screen.getByText("Open a folder to browse its files")).toBeTruthy();
  });
});

/**
 * Promotion into the grid stamps the active worktree onto a workspace-rooted
 * panel so it lands in a rendered index bucket (#11290). That id is placement
 * only — a resolvable one, so nothing fails loudly; the panel just quietly
 * showed the wrong folder until #11489.
 */
describe("promoted workspace-rooted browser (#11489)", () => {
  it("keeps browsing the workspace after promotion stamps a placement worktree", async () => {
    workspaceRootPathMock.mockReturnValue("/scratches/one");
    mockPanel.browserWorkspaceRooted = true;
    renderPane({ worktreeId: "wt-1" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
    });

    // wt-1 resolves to "/repo", which is what this joined against before the fix.
    expect(writeTextMock).toHaveBeenCalledWith(`/scratches/one/${FOLDER_ROW.path}`);
  });

  it("hides Copy context for a promoted workspace-rooted browser", () => {
    workspaceRootPathMock.mockReturnValue("/scratches/one");
    mockPanel.browserWorkspaceRooted = true;
    renderPane({ worktreeId: "wt-1" });

    expect(screen.queryByRole("button", { name: "Copy context" })).toBeNull();
  });

  it("still refuses to render when the workspace root is unknown", () => {
    // The placement worktree resolves, but it is not this panel's folder — so
    // an unresolved workspace is the unbound case, not a reason to use it.
    mockPanel.browserWorkspaceRooted = true;
    renderPane({ worktreeId: "wt-1" });

    expect(screen.getByText("Open a folder to browse its files")).toBeTruthy();
  });

  it("leaves an unmarked worktree panel on its worktree", () => {
    workspaceRootPathMock.mockReturnValue("/scratches/one");
    renderPane({ worktreeId: "wt-1" });

    expect(screen.getByRole("button", { name: "Copy context" })).toBeTruthy();
  });

  it("follows its own worktree's git tick when it is not workspace-rooted", () => {
    // Asserted per source rather than together: with both set, the larger one
    // alone satisfies the Math.max and a disconnected sibling selector reads
    // green.
    worktreeTicks.git = 450;
    worktreeTicks.fs = 120;
    renderPane({ worktreeId: "wt-1" });

    expect(treeArgs.changeTick).toBe(450);
  });

  it("follows its own worktree's filesystem tick when it is not workspace-rooted", () => {
    worktreeTicks.fs = 300;
    renderPane({ worktreeId: "wt-1" });

    expect(treeArgs.changeTick).toBe(300);
  });

  it("ignores the placement worktree's change ticks once workspace-rooted", () => {
    // Both worktree tick maps are keyed by worktree id, so following the
    // placement worktree's would refresh the tree on writes in a folder this
    // panel isn't showing. Its own signal comes from the external tick instead.
    worktreeTicks.git = 120;
    worktreeTicks.fs = 450;
    workspaceRootPathMock.mockReturnValue("/scratches/one");
    mockPanel.browserWorkspaceRooted = true;
    renderPane({ worktreeId: "wt-1" });

    expect(treeArgs.changeTick).toBeUndefined();
  });

  it("takes its tick from the external signal once workspace-rooted (#11590)", () => {
    worktreeTicks.git = 120;
    worktreeTicks.fs = 450;
    workspaceRootPathMock.mockReturnValue("/scratches/one");
    mockPanel.browserWorkspaceRooted = true;
    externalChangeTickMock.mockReturnValue(777);
    renderPane({ worktreeId: "wt-1" });

    // Not either worktree tick: the external signal is the only one describing
    // the folder this panel is actually showing.
    expect(treeArgs.changeTick).toBe(777);
  });

  it("watches the browsed root and the selected file, in that priority order", () => {
    // The selected file has to be in the watched set: an in-place rewrite moves
    // neither its parent directory's mtime nor that parent's child-name digest,
    // so nothing else in the set can see it — and the viewer beside the tree is
    // what's showing it.
    workspaceRootPathMock.mockReturnValue("/scratches/one");
    mockPanel.browserWorkspaceRooted = true;
    mockPanel.browserRootPath = "src";
    mockPanel.browserSelectedPath = "src/notes.md";
    mockPanel.browserExpandedPaths = ["src/deep"];
    renderPane({ worktreeId: "wt-1" });

    const [root, watched] = externalChangeTickMock.mock.calls[0] ?? [];
    expect(root).toBe("/scratches/one");
    expect(watched?.slice(0, 2)).toEqual(["/scratches/one/src", "/scratches/one/src/notes.md"]);
    expect(watched).toContain("/scratches/one/src/deep");
  });

  it("does not poll externally when the source is a worktree", () => {
    // The workspace host's recursive watcher already covers a worktree, and a
    // second signal for it would be pure duplicate work.
    workspaceRootPathMock.mockReturnValue("/scratches/one");
    mockPanel.browserWorkspaceRooted = false;
    renderPane({ worktreeId: "wt-1" });

    expect(externalChangeTickMock).not.toHaveBeenCalled();
  });
});

describe("FileBrowserPane collapsible viewer (#11496)", () => {
  const paneJsx = () => (
    <TooltipProvider>
      <FileBrowserPane
        id="fb-1"
        title="Files"
        worktreeId="wt-1"
        isFocused
        location="grid"
        onFocus={vi.fn()}
        onClose={vi.fn()}
      />
    </TooltipProvider>
  );

  // Both toggles write through the store, so a click has to be reflected back
  // before the next assertion — otherwise every test would only ever see the
  // pane's initial layout.
  function makeStoreStateful() {
    setFileBrowserViewMock.mockImplementation((_id: string, patch: Partial<MockPanel>) => {
      Object.assign(mockPanel, patch);
    });
  }

  const viewerToggle = () => screen.getByTestId("file-browser-viewer-toggle");
  const treeColumn = () =>
    document.getElementById(
      screen.getByTestId("file-browser-sidebar-toggle").getAttribute("aria-controls")!
    )!;

  it("homes the viewer's toggle in the tree header and names the region it discloses", () => {
    renderPane();

    const toggle = viewerToggle();
    // The toggle for each column lives in the other column's header: this one
    // has to be inside the tree, which is what makes "both collapsed"
    // unreachable rather than merely discouraged.
    expect(treeColumn().contains(toggle)).toBe(true);
    const controlsId = toggle.getAttribute("aria-controls");
    expect(controlsId).toBeTruthy();
    expect(document.getElementById(controlsId!)).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("sits last in the tree header, against the divider", () => {
    renderPane();

    // The header located from the column rather than from the toggle itself:
    // asking the toggle for its own parent would keep passing if a wrapper
    // moved the control into the middle of the row.
    const header = treeColumn().querySelector<HTMLElement>(":scope > div")!;
    expect(header.contains(viewerToggle())).toBe(true);
    // Mirrors where the tree's toggle sits in the viewer's toolbar (first, also
    // against the divider), so the two disclosures frame the split.
    expect(header.lastElementChild).toBe(viewerToggle());
  });

  it("carries disclosure semantics rather than a pressed toggle", () => {
    renderPane();

    const toggle = viewerToggle();
    // A disclosure, like the tree's: it hides a region, so `aria-expanded` is
    // the state — not `aria-pressed`, which would describe a mode switch.
    expect(toggle.hasAttribute("aria-expanded")).toBe(true);
    expect(toggle.hasAttribute("aria-pressed")).toBe(false);
  });

  it("keeps one static label across both states", () => {
    makeStoreStateful();
    const { rerender } = renderPane();
    const labelWhenOpen = viewerToggle().getAttribute("aria-label");

    fireEvent.click(viewerToggle());
    rerender(paneJsx());

    expect(viewerToggle().getAttribute("aria-label")).toBe(labelWhenOpen);
    expect(labelWhenOpen).toBeTruthy();
  });

  it("unmounts the viewer column and drops the dangling aria-controls", async () => {
    mockPanel.browserSelectedPath = "src/app.ts";
    const { rerender } = renderPane();
    const controlsId = viewerToggle().getAttribute("aria-controls");
    expect(document.getElementById(controlsId!)).not.toBeNull();
    // Established BEFORE collapsing: without this the "code viewer is gone"
    // assertion below would also pass if the selected file never rendered.
    await waitFor(() => expect(screen.getByTestId("code-viewer")).toBeTruthy());

    mockPanel.browserViewerCollapsed = true;
    rerender(paneJsx());

    // The whole viewer goes, including the file body and the tree's own toggle
    // that lived in it — the tree header's control is the only way back.
    expect(screen.queryByTestId("code-viewer")).toBeNull();
    expect(screen.queryByTestId("file-browser-sidebar-toggle")).toBeNull();
    expect(screen.getByTestId("file-tree-view")).toBeTruthy();
    expect(viewerToggle().getAttribute("aria-expanded")).toBe("false");
    expect(viewerToggle().hasAttribute("aria-controls")).toBe(false);
    expect(document.getElementById(controlsId!)).toBeNull();
  });

  it("leaves exactly one collapse control mounted in either collapsed layout", () => {
    // The structural invariant behind "both collapsed is impossible": whichever
    // column is hidden takes its sibling's toggle with it, so the only control
    // on screen is the one that reopens what's missing.
    mockPanel.browserViewerCollapsed = true;
    const { unmount } = renderPane();
    expect(screen.queryByTestId("file-browser-sidebar-toggle")).toBeNull();
    expect(screen.getByTestId("file-browser-viewer-toggle")).toBeTruthy();
    unmount();

    // A fresh root rather than a rerender: the mirror layout is a different
    // mount, and rerendering an unmounted one asserts nothing.
    mockPanel.browserViewerCollapsed = undefined;
    mockPanel.browserSidebarCollapsed = true;
    renderPane();
    expect(screen.queryByTestId("file-browser-viewer-toggle")).toBeNull();
    expect(screen.getByTestId("file-browser-sidebar-toggle")).toBeTruthy();
  });

  it("keeps the viewer visible when a corrupted record collapses both columns", () => {
    // Unreachable by gesture, reachable on disk. The sidebar bit decides, so the
    // tree stays hidden and the viewer is forced open — whichever column wins,
    // the point is that the panel can never render empty with no way out.
    mockPanel.browserSidebarCollapsed = true;
    mockPanel.browserViewerCollapsed = true;
    renderPane();

    expect(screen.queryByTestId("file-tree-view")).toBeNull();
    expect(screen.getByTestId("file-browser-sidebar-toggle")).toBeTruthy();
  });

  it("toggles the persisted flag on click, inverting the current value", () => {
    renderPane();

    fireEvent.click(viewerToggle());

    expect(setFileBrowserViewMock).toHaveBeenCalledWith("fb-1", {
      browserViewerCollapsed: true,
    });
  });

  it("re-opens from the collapsed state rather than always collapsing", () => {
    mockPanel.browserViewerCollapsed = true;
    renderPane();

    fireEvent.click(viewerToggle());

    expect(setFileBrowserViewMock).toHaveBeenCalledWith("fb-1", {
      browserViewerCollapsed: false,
    });
  });

  it("hands the tree the whole panel, dropping the split width and the grip", () => {
    mockPanel.browserSidebarWidth = 420;
    makeStoreStateful();
    const { rerender } = renderPane();

    // Split layout: a fixed column with a grip against the viewer.
    const splitColumn = treeColumn();
    expect(splitColumn.style.width).toBe("420px");
    expect(screen.getByTestId("file-browser-sidebar-resize")).toBeTruthy();
    const fillToken = classToken(splitColumn.parentElement!.lastElementChild!, (c) =>
      /^flex-1$/.test(c)
    );
    // Guard against a vacuous undefined === undefined pass below.
    expect(fillToken).toBeDefined();

    fireEvent.click(viewerToggle());
    rerender(paneJsx());

    // Sole column: no inline width, nothing to resize against, and it takes the
    // same fill token the viewer used — so a 600px-capped tree can't strand
    // dead space beside it.
    const soleColumn = screen.getByTestId("file-tree-view").closest<HTMLElement>("[id]")!;
    expect(soleColumn.style.width).toBe("");
    expect(screen.queryByTestId("file-browser-sidebar-resize")).toBeNull();
    expect(classToken(soleColumn, (c) => /^flex-1$/.test(c))).toBe(fillToken);
  });

  it("restores the remembered split and the selected file when the viewer reopens", async () => {
    mockPanel.browserSidebarWidth = 420;
    mockPanel.browserSelectedPath = "src/app.ts";
    makeStoreStateful();
    const { rerender } = renderPane();
    await waitFor(() => expect(screen.getByTestId("code-viewer")).toBeTruthy());

    fireEvent.click(viewerToggle());
    rerender(paneJsx());
    // Collapsing must not clear the width, only stop applying it.
    expect(mockPanel.browserSidebarWidth).toBe(420);

    fireEvent.click(viewerToggle());
    rerender(paneJsx());

    expect(treeColumn().style.width).toBe("420px");
    expect(screen.getByTestId("file-browser-sidebar-resize")).toBeTruthy();
    // The selection outlived the unmount, so reopening reads the same file back
    // rather than returning to the empty state.
    await waitFor(() => expect(screen.getByTestId("code-viewer")).toBeTruthy());
  });

  it("drops the document listeners when the viewer collapses mid-drag", () => {
    const { rerender } = renderPane();

    fireEvent.mouseDown(screen.getByTestId("file-browser-sidebar-resize"), { clientX: 100 });
    // Collapsing the viewer takes the grip away without unmounting the pane, so
    // the same cleanup the tree-collapse path uses has to fire here too.
    mockPanel.browserViewerCollapsed = true;
    rerender(paneJsx());
    setFileBrowserViewMock.mockClear();
    fireEvent.mouseMove(document, { clientX: 400, buttons: 1 });

    expect(setFileBrowserViewMock).not.toHaveBeenCalled();
  });

  // The redirect runs inside a requestAnimationFrame, so a synchronous assertion
  // would pass whether or not a frame was ever queued — which is exactly the
  // regression these two tests exist to catch. Queue the callbacks and flush them
  // after the collapsed rerender, the order production sees.
  function queueFrames() {
    const queued: FrameRequestCallback[] = [];
    const spy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => queued.push(cb));
    return {
      spy,
      count: () => queued.length,
      flush: () => {
        const pending = queued.splice(0);
        act(() => {
          for (const cb of pending) cb(0);
        });
      },
    };
  }

  it("leaves focus on the toggle when the click itself collapses the viewer", () => {
    makeStoreStateful();
    const frames = queueFrames();
    try {
      const { rerender } = renderPane();
      act(() => viewerToggle().focus());

      fireEvent.click(viewerToggle());
      rerender(paneJsx());
      // No frame requested at all: the toggle lives in the tree header, so it
      // survives its own collapse and there is nothing to recover from.
      expect(frames.count()).toBe(0);
      frames.flush();

      // Flushed anyway, so an unconditional redirect would have yanked focus off
      // the button the user just pressed and failed here.
      expect(document.activeElement).toBe(viewerToggle());
    } finally {
      frames.spy.mockRestore();
    }
  });

  it("hands focus to the tree when a collapse unmounts the focused viewer control", () => {
    makeStoreStateful();
    const frames = queueFrames();
    try {
      const { rerender } = renderPane();
      // Focus something inside the viewer, then collapse from elsewhere (an
      // assistive or programmatic activation) — the focused node is about to go.
      act(() => screen.getByTestId("file-browser-sidebar-toggle").focus());

      act(() => {
        viewerToggle().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      rerender(paneJsx());
      frames.flush();

      expect(document.activeElement).toBe(screen.getByTestId("file-tree-view"));
    } finally {
      frames.spy.mockRestore();
    }
  });

  it("still lands focus in the tree column when there is no tree to focus", () => {
    // The loading, error and empty branches render no role="tree" at all, so a
    // redirect that only looked for one would drop focus to the document.
    treeState.rows = [];
    makeStoreStateful();
    const frames = queueFrames();
    try {
      const { rerender } = renderPane();
      // Captured before the collapse: the helper resolves the column through the
      // viewer's toggle, which is exactly what unmounts here. The column element
      // itself survives, so hold the reference.
      const column = treeColumn();
      act(() => screen.getByTestId("file-browser-sidebar-toggle").focus());

      act(() => {
        viewerToggle().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      rerender(paneJsx());
      frames.flush();

      expect(screen.queryByRole("tree")).toBeNull();
      expect(column.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(document.body);
    } finally {
      frames.spy.mockRestore();
    }
  });
});

describe("FileBrowserPane row activation (#11496)", () => {
  // Invoked non-optionally: with `?.` the negative cases below would pass even if
  // the pane had never wired the prop, proving nothing about their guards.
  const activate = async (path: string) => {
    const onActivate = treeProps.onActivate;
    expect(onActivate).toBeTypeOf("function");
    await act(async () => {
      onActivate!(path);
      await Promise.resolve();
    });
  };

  it("opens a file row in its own panel, resolved to an absolute path", async () => {
    renderPane();

    await activate("src/app.ts");

    // The worktree in the store mock is /repo, so the action gets the same
    // absolute path a row's "Copy path" would produce.
    expect(dispatchMock.mock.calls).toEqual([
      ["file.openPanel", { path: "/repo/src/app.ts" }, { source: "user" }],
    ]);
  });

  it("ignores a directory row, so Enter on a folder stays a no-op", async () => {
    // The key resolver reports `activate` for whatever row is selected, folders
    // included, so this guard is the only thing keeping Enter on a folder from
    // trying to open a directory as a file panel.
    renderPane();

    await activate("src");

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("ignores a path with no row behind it", async () => {
    // A stale path (the listing changed under a keypress) is not known to be a
    // file, so it must not be treated as one.
    renderPane();

    await activate("src/gone.ts");

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("resolves the path against a workspace root, not the placement worktree", async () => {
    // A promoted workspace-rooted panel carries a placement `worktreeId` whose
    // path is NOT what it browses (#11489), so reading that instead of the
    // resolved base would open a file from the wrong folder.
    workspaceRootPathMock.mockReturnValue("/scratches/one");
    mockPanel.browserWorkspaceRooted = true;
    renderPane({ worktreeId: "wt-1" });

    await activate("src/app.ts");

    expect(dispatchMock.mock.calls).toEqual([
      ["file.openPanel", { path: "/scratches/one/src/app.ts" }, { source: "user" }],
    ]);
  });

  // `onClose` is what the dialog host wires to its own close for this panel, so
  // asserting on it is asserting the dialog gets dismissed.
  const renderDialogPane = (onClose: () => void) =>
    render(
      <TooltipProvider>
        <FileBrowserPane
          id="fb-1"
          title="Files"
          worktreeId="wt-1"
          isFocused
          location="dialog"
          onFocus={vi.fn()}
          onClose={onClose}
        />
      </TooltipProvider>
    );

  it("closes the browser dialog so the panel it opened is not stranded behind it", async () => {
    // `worktree.openFileBrowser` opens this pane as a modal, so the grid panel
    // the action just created would sit under a focus-trapping dialog and the
    // gesture would look like it did nothing.
    const onClose = vi.fn();
    renderDialogPane(onClose);

    await activate("src/app.ts");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves the dialog open when the open failed", async () => {
    // Closing on failure would dismiss the browser and show nothing in its place.
    dispatchMock.mockResolvedValue({ ok: false, error: { message: "panel limit reached" } });
    const onClose = vi.fn();
    renderDialogPane(onClose);

    await activate("src/app.ts");

    expect(onClose).not.toHaveBeenCalled();
  });

  it("never closes a grid-hosted browser, where onClose would destroy the panel", async () => {
    // Same prop, very different meaning outside a dialog: in the grid it closes
    // the browser itself, so the location guard is load-bearing.
    const onClose = vi.fn();
    render(
      <TooltipProvider>
        <FileBrowserPane
          id="fb-1"
          title="Files"
          worktreeId="wt-1"
          isFocused
          location="grid"
          onFocus={vi.fn()}
          onClose={onClose}
        />
      </TooltipProvider>
    );

    await activate("src/app.ts");

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reports a failed open without raising a second toast over addPanel's own", async () => {
    // The realistic failure is the panel ceiling, which `addPanel` already warns
    // about — a toast here would report one gesture twice.
    dispatchMock.mockResolvedValue({ ok: false, error: { message: "panel limit reached" } });
    renderPane();

    await activate("src/app.ts");

    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe("FileBrowserPane Refresh reachability and media wiring (#11586, #11938)", () => {
  // Refresh once lived only in the tree header, which unmounts with the tree
  // column — so the viewer-only layout had no way to refresh at all. The viewer
  // grows its own for exactly that layout. What decides which one is on screen
  // is whether the tree is mounted, and nothing else: selection used to move it
  // too, which is what made it read as missing at panel width (#11938).
  const AUDIO_ROW = {
    path: "media/track.mp3",
    name: "track.mp3",
    isDirectory: false,
    depth: 1,
    isExpanded: false,
    isLoading: false,
  };

  // Refresh is a menu item now, not a header button. The invariant is unchanged
  // — exactly one must be REACHABLE in every layout — so this counts the item
  // wherever it lives rather than asserting a particular chrome slot.
  function refreshButtons(): HTMLElement[] {
    return screen.queryAllByTestId("file-browser-refresh");
  }

  it("keeps exactly one Refresh reachable in each of the three layouts", () => {
    const { rerender } = renderPane();

    // Both columns: the tree header owns it, and the viewer must not add a
    // second identical control beside it.
    expect(refreshButtons()).toHaveLength(1);
    const treeColumn = document.getElementById(
      screen.getByTestId("file-browser-sidebar-toggle").getAttribute("aria-controls")!
    )!;
    expect(treeColumn.contains(refreshButtons()[0]!)).toBe(true);

    // Viewer collapsed: the tree header is still mounted and still owns it.
    mockPanel.browserViewerCollapsed = true;
    rerender(paneJsx());
    expect(refreshButtons()).toHaveLength(1);

    // Sidebar collapsed: the tree header is gone, so the viewer's takes over —
    // this is the layout that had no Refresh at all.
    mockPanel.browserViewerCollapsed = undefined;
    mockPanel.browserSidebarCollapsed = true;
    rerender(paneJsx());
    expect(screen.queryByTestId("file-tree-view")).toBeNull();
    expect(refreshButtons()).toHaveLength(1);
  });

  it("keeps Refresh in the tree header while a file is open, without showing two", async () => {
    // The one layout where both headers are on screen at once, and the one this
    // suite used to assert the other way round: opening a file handed Refresh
    // to the viewer, putting it at the far edge of a grid-width panel. It stays
    // in the tree header now, and the viewer must not add a second button named
    // "Refresh" wired to the same handler beside it.
    mockPanel.browserSelectedPath = "src/app.ts";
    renderPane();

    // Wait for the file to actually be on screen. Asserting placement while the
    // selection is still unresolved would pass for the wrong reason — the tree
    // header owns Refresh with nothing open too.
    await screen.findByTestId("code-viewer");

    const treeColumn = document.getElementById(
      screen.getByTestId("file-browser-sidebar-toggle").getAttribute("aria-controls")!
    )!;
    expect(refreshButtons()).toHaveLength(1);
    expect(treeColumn.contains(refreshButtons()[0]!)).toBe(true);

    // And it works from here. Every other Refresh press in this file collapses
    // the sidebar first, so without this the layout Refresh now lives in by
    // default could go inert — visible, unwired — with the suite still green.
    act(() => {
      fireEvent.click(refreshButtons()[0]!);
    });
    expect(treeState.refresh).toHaveBeenCalledWith({ manual: true });
  });

  it("keeps the tree's Refresh when a selected file's viewer is collapsed", () => {
    // A file is selected and the viewer that would once have owned Refresh is
    // gone. The tree header is mounted, so it owns it — the same answer as the
    // layout above, reached from the other direction.
    mockPanel.browserSelectedPath = "src/app.ts";
    mockPanel.browserViewerCollapsed = true;
    renderPane();

    // The viewer column is unmounted — its tree toggle is the tell — so the
    // tree column is the only place the remaining one can be.
    expect(screen.queryByTestId("file-browser-sidebar-toggle")).toBeNull();
    expect(screen.getByTestId("file-tree-view")).toBeTruthy();
    expect(refreshButtons()).toHaveLength(1);
  });

  it("runs the pane's manual refresh from the viewer with nothing selected", () => {
    // Nothing selected is not a dead layout: Refresh re-reads the tree, and a
    // browser whose source has no worktree tick (a workspace root) is left with
    // just the polled reconcile (#11590) until someone asks.
    mockPanel.browserSidebarCollapsed = true;
    renderPane();

    // getByRole, not the plural helper: this must be the one and only Refresh,
    // and a missing button should fail here rather than inside fireEvent.
    act(() => {
      fireEvent.click(screen.getByTestId("file-browser-refresh"));
    });

    expect(treeState.refresh).toHaveBeenCalledTimes(1);
    expect(treeState.refresh).toHaveBeenCalledWith({ manual: true });
  });

  it("refetches the open media preview when the viewer's Refresh is pressed", async () => {
    // The end-to-end shape of the bug: the pane merges its change tick and its
    // manual nonce into one `revision` string, and the media branches ignore
    // that string wholesale. Handing the nonce over separately is what makes
    // this pass — passing `revision` through instead would refetch on every
    // ambient worktree write, which is the thing the merge was avoiding.
    let objectUrlSequence = 0;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: () => Promise.resolve(new Blob(["x"])),
    });
    vi.stubGlobal("fetch", fetchMock);
    // Saved by hand: these are methods on URL, not globals, so
    // `unstubAllGlobals` can't put them back and a later test would inherit
    // this suite's sequence counter.
    const realCreateObjectURL = URL.createObjectURL;
    const realRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => `blob:app://daintree/pane-audio-${objectUrlSequence++}`);
    URL.revokeObjectURL = vi.fn();

    try {
      treeState.rows = [...defaultRows, AUDIO_ROW];
      mockPanel.browserSelectedPath = AUDIO_ROW.path;
      mockPanel.browserSidebarCollapsed = true;
      const { container } = renderPane();

      await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
      const firstSrc = container.querySelector("audio")?.getAttribute("src");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain("v=0");

      act(() => {
        fireEvent.click(screen.getByTestId("file-browser-refresh"));
      });

      // The tree refreshes and the preview re-requests — one gesture, both
      // halves, no rerender needed because the nonce is the pane's own state.
      expect(treeState.refresh).toHaveBeenCalledWith({ manual: true });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      // The one place the `v=` spelling is worth pinning: this is the whole
      // thesis of the fix, that the pane's nonce survives the trip through the
      // viewer into the leaf's request URL. A fetch count alone wouldn't say
      // the nonce is what drove it.
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain("v=1");
      // One waitFor for the whole claim: the hook nulls its object URL while
      // refetching, so a bare src comparison would go green on the empty gap
      // without the replacement player ever arriving.
      await waitFor(() => {
        const refreshed = container.querySelector("audio");
        expect(refreshed).not.toBeNull();
        expect(refreshed?.getAttribute("src")).not.toBe(firstSrc);
      });
      // Media never round-trips through the text-read IPC path.
      expect(readMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      URL.createObjectURL = realCreateObjectURL;
      URL.revokeObjectURL = realRevokeObjectURL;
    }
  });
});

describe("FileBrowserPane refresh signal reaches both viewer paths (#11586)", () => {
  // The nonce travels to the viewer twice over: merged into `viewerRevision`
  // and handed across on its own. These drive the pane's REAL Refresh button so
  // they exercise that formula — the viewer-level suite manufactures the
  // revision string itself and would stay green if the merge were dropped,
  // which is exactly the "simplification" the comment there warns against.
  it("re-reads the open text file when Refresh is pressed", async () => {
    mockPanel.browserSelectedPath = "src/app.ts";
    mockPanel.browserSidebarCollapsed = true;
    renderPane();

    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1));

    act(() => {
      fireEvent.click(screen.getByTestId("file-browser-refresh"));
    });

    // Drop the nonce from `viewerRevision` and this never moves: the tree
    // refreshes, the file on screen silently keeps its stale bytes.
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(2));
  });

  it("recovers a media preview stuck in its error state when Refresh is pressed", async () => {
    // The media half of the same invariant. A failed fetch unmounts the player,
    // so the direct `reloadKey` handoff has nothing to reach — only the
    // revision-driven reclassification can bring it back.
    let objectUrlSequence = 0;
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("protocol unavailable"))
      .mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        blob: () => Promise.resolve(new Blob(["x"])),
      });
    vi.stubGlobal("fetch", fetchMock);
    const realCreateObjectURL = URL.createObjectURL;
    const realRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => `blob:app://daintree/pane-retry-${objectUrlSequence++}`);
    URL.revokeObjectURL = vi.fn();

    try {
      treeState.rows = [
        ...defaultRows,
        {
          path: "media/track.mp3",
          name: "track.mp3",
          isDirectory: false,
          depth: 1,
          isExpanded: false,
          isLoading: false,
        },
      ];
      mockPanel.browserSelectedPath = "media/track.mp3";
      mockPanel.browserSidebarCollapsed = true;
      const { container } = renderPane();

      await screen.findByText("This audio file couldn't be played");
      expect(container.querySelector("audio")).toBeNull();

      act(() => {
        fireEvent.click(screen.getByTestId("file-browser-refresh"));
      });

      await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
      expect(screen.queryByText("This audio file couldn't be played")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      URL.createObjectURL = realCreateObjectURL;
      URL.revokeObjectURL = realRevokeObjectURL;
    }
  });
});

// #11588: a project switch is not a page load. Caching a view is
// `removeChildView` + `setVisible(false)`, so `document.visibilityState` never
// moves; the change tick keeps running but deliberately never reaches the media
// previews' reload key. Coming back is the only moment the tree and the open
// file can learn what happened while the project sat in the background.
describe("FileBrowserPane re-reads when the project view is revealed (#11588)", () => {
  const PDF_ROW = {
    path: "docs/spec.pdf",
    name: "spec.pdf",
    isDirectory: false,
    depth: 1,
    isExpanded: false,
    isLoading: false,
  };

  function paneElement(location: "grid" | "dock" = "grid") {
    return (
      <TooltipProvider>
        <FileBrowserPane
          id="fb-1"
          title="Files"
          worktreeId="wt-1"
          isFocused
          location={location}
          onFocus={vi.fn()}
          onClose={vi.fn()}
        />
      </TooltipProvider>
    );
  }

  async function emit(phase: LifecyclePhase) {
    await act(async () => {
      for (const listener of Array.from(lifecycleListeners)) listener(phase);
    });
  }

  it("re-lists the tree on reveal", async () => {
    renderPane();

    await emit("revealed");

    expect(treeState.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not spin the toolbar icon: reveal is not a gesture", async () => {
    // `manual` exists only to drive the Refresh spinner, and reporting a
    // gesture nobody made would be a lie about who asked for the work.
    renderPane();

    await emit("revealed");

    expect(treeState.refresh).toHaveBeenCalledWith(undefined);
    expect(treeState.refresh).not.toHaveBeenCalledWith({ manual: true });
  });

  it("stays put on cached and active", async () => {
    renderPane();

    await emit("cached");
    await emit("active");

    expect(treeState.refresh).not.toHaveBeenCalled();
  });

  it("re-reads the open text file on reveal", async () => {
    // The nonce reaches the viewer through `viewerRevision`; drop it from that
    // formula and the tree still refreshes while the file on screen goes stale.
    mockPanel.browserSelectedPath = "src/app.ts";
    mockPanel.browserSidebarCollapsed = true;
    renderPane();
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1));

    await emit("revealed");

    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(2));
  });

  it("re-navigates the open PDF on reveal", async () => {
    // The surface with no other safety net: `revision` never reaches the PDF
    // branch, so before this the only way to see the rewritten bytes was
    // pressing Refresh.
    treeState.rows = [...defaultRows, PDF_ROW];
    mockPanel.browserSelectedPath = PDF_ROW.path;
    mockPanel.browserSidebarCollapsed = true;
    const { container } = renderPane();
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const srcBefore = container.querySelector("iframe")?.getAttribute("src");

    await emit("revealed");

    await waitFor(() =>
      expect(container.querySelector("iframe")?.getAttribute("src")).not.toBe(srcBefore)
    );
  });

  it("leaves the open PDF alone on an ambient change tick", async () => {
    // The invariant the reveal path must not trample: an agent writing any file
    // in the worktree still must not throw away the reader's page and zoom.
    treeState.rows = [...defaultRows, PDF_ROW];
    mockPanel.browserSelectedPath = PDF_ROW.path;
    mockPanel.browserSidebarCollapsed = true;
    worktreeTicks.git = 100;
    const { container, rerender } = renderPane();
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const srcBefore = container.querySelector("iframe")?.getAttribute("src");

    worktreeTicks.git = 200;
    await act(async () => {
      rerender(paneElement());
    });

    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(srcBefore);
  });

  it("stops listening once the pane unmounts", () => {
    const { unmount } = renderPane();

    unmount();

    expect(lifecycleListeners.size).toBe(0);
  });

  // #12165: the media nonce is split from `surfaceRefreshNonce` so a reveal can
  // hold it still without also stalling the text re-read, the PDF frame, or the
  // reclassification that revives a failed preview.
  describe("playing media (#12165)", () => {
    // Both kinds, because FileBrowserViewer wires them in two separate branches:
    // an audio-only suite would let the video one drift back to the surface
    // nonce with everything still green.
    const KINDS = [
      { tag: "audio" as const, path: "media/track.mp3", next: "media/other.mp3" },
      { tag: "video" as const, path: "media/demo.mp4", next: "media/other.mp4" },
    ];
    const row = (path: string) => ({
      path,
      name: path.split("/").pop()!,
      isDirectory: false,
      depth: 1,
      isExpanded: false,
      isLoading: false,
    });

    const mediaFetchMock = vi.fn();
    const realCreateObjectURL = URL.createObjectURL;
    const realRevokeObjectURL = URL.revokeObjectURL;

    beforeEach(() => {
      let objectUrlSequence = 0;
      mediaFetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        blob: () => Promise.resolve(new Blob(["x"])),
      });
      vi.stubGlobal("fetch", mediaFetchMock);
      // Unique per call: a constant would let a stale response satisfy an
      // assertion that a fresh one arrived.
      URL.createObjectURL = vi.fn(() => `blob:app://daintree/pane-play-${objectUrlSequence++}`);
      URL.revokeObjectURL = vi.fn();
      treeState.rows = [
        ...defaultRows,
        ...KINDS.flatMap((kind) => [row(kind.path), row(kind.next)]),
      ];
      mockPanel.browserSidebarCollapsed = true;
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      mediaFetchMock.mockReset();
      // `vi.unstubAllGlobals` does not restore a directly assigned method.
      URL.createObjectURL = realCreateObjectURL;
      URL.revokeObjectURL = realRevokeObjectURL;
    });

    // jsdom neither decodes media nor tracks playback: `fireEvent.play` fires
    // the event but leaves `paused` true, so the preview's own paused/ended
    // read would see the opposite of what the test just said happened.
    function setPlaybackState(
      element: HTMLMediaElement,
      state: { paused: boolean; ended?: boolean }
    ): void {
      Object.defineProperty(element, "paused", { configurable: true, value: state.paused });
      Object.defineProperty(element, "ended", { configurable: true, value: state.ended ?? false });
    }

    async function renderPlaying(kind: (typeof KINDS)[number]) {
      mockPanel.browserSelectedPath = kind.path;
      const view = renderPane();
      await waitFor(() => expect(view.container.querySelector(kind.tag)).not.toBeNull());
      const player = view.container.querySelector<HTMLMediaElement>(kind.tag)!;
      setPlaybackState(player, { paused: false });
      fireEvent.play(player);
      return { ...view, player };
    }

    for (const kind of KINDS) {
      it(`leaves a playing ${kind.tag} alone on reveal while still re-listing the tree`, async () => {
        // Both halves matter: a re-fetch mints a new object URL and drops the
        // listener back to zero, while the tree has nothing to protect and must
        // still catch up on what changed while the project sat cached.
        const { player, container } = await renderPlaying(kind);
        const fetchesBefore = mediaFetchMock.mock.calls.length;
        const srcBefore = player.getAttribute("src");

        await emit("revealed");

        expect(mediaFetchMock.mock.calls.length).toBe(fetchesBefore);
        // The same element, still pointed at the same blob — a src comparison
        // alone would go green on the empty gap while a replacement loads.
        expect(container.querySelector(kind.tag)).toBe(player);
        expect(player.getAttribute("src")).toBe(srcBefore);
        expect(treeState.refresh).toHaveBeenCalledTimes(1);
      });

      it(`re-fetches the ${kind.tag} on the next reveal once it ends`, async () => {
        // The suppression is scoped to playback, not permanent — and the spec
        // leaves `paused` false at the end, so `ended` is what says it stopped.
        const { player } = await renderPlaying(kind);
        const fetchesBefore = mediaFetchMock.mock.calls.length;

        await emit("revealed");
        expect(mediaFetchMock.mock.calls.length).toBe(fetchesBefore);

        setPlaybackState(player, { paused: false, ended: true });
        fireEvent.ended(player);
        await emit("revealed");

        await waitFor(() => expect(mediaFetchMock.mock.calls.length).toBe(fetchesBefore + 1));
      });

      it(`still re-fetches the ${kind.tag} when Refresh is pressed`, async () => {
        // A gesture outranks playback: someone pressing Refresh mid-track is
        // asking for the rewritten bytes and accepts losing their place.
        await renderPlaying(kind);
        const fetchesBefore = mediaFetchMock.mock.calls.length;

        act(() => {
          fireEvent.click(screen.getByTestId("file-browser-refresh"));
        });

        await waitFor(() => expect(mediaFetchMock.mock.calls.length).toBe(fetchesBefore + 1));
      });

      it(`does not carry ${kind.tag} playing state to the next selected file`, async () => {
        // The stale-flag failure this would otherwise invite: a track left
        // playing, a different file selected, and every later reveal silently
        // refusing to refresh a player that was never running.
        const { rerender, container } = await renderPlaying(kind);

        mockPanel.browserSelectedPath = kind.next;
        await act(async () => {
          rerender(paneElement());
        });
        await waitFor(() => expect(container.querySelector(kind.tag)).not.toBeNull());
        const fetchesBefore = mediaFetchMock.mock.calls.length;

        await emit("revealed");

        await waitFor(() => expect(mediaFetchMock.mock.calls.length).toBe(fetchesBefore + 1));
      });

      it(`re-reads a text file revealed after a played ${kind.tag}`, async () => {
        // The player is gone by the time this reveal lands, so the flag must be
        // too. It is retracted when the preview unmounts, not by anything the
        // pane does — leave that out of the leaf and the open file goes stale
        // for the rest of the session.
        const { rerender } = await renderPlaying(kind);

        mockPanel.browserSelectedPath = "src/app.ts";
        await act(async () => {
          rerender(paneElement());
        });
        await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1));

        await emit("revealed");

        await waitFor(() => expect(readMock).toHaveBeenCalledTimes(2));
      });
    }
  });

  describe("dock parking", () => {
    it("defers the refresh while parked offscreen, then runs it once on activation", async () => {
      // A dock panel stays mounted in the offscreen parking container whether
      // or not its popover is open, so an ungated reveal would re-list the tree
      // and restart any media for something nobody can see.
      dockState.activeDockTerminalId = "other-panel";
      const { rerender } = render(paneElement("dock"));

      await emit("revealed");
      await emit("revealed");
      expect(treeState.refresh).not.toHaveBeenCalled();

      dockState.activeDockTerminalId = "fb-1";
      await act(async () => {
        rerender(paneElement("dock"));
      });

      // Two missed reveals owe one catch-up — the work is "list what is on disk
      // now", not "replay every switch".
      expect(treeState.refresh).toHaveBeenCalledTimes(1);
    });

    it("refreshes immediately when the dock panel is the active one", async () => {
      dockState.activeDockTerminalId = "fb-1";
      render(paneElement("dock"));

      await emit("revealed");

      expect(treeState.refresh).toHaveBeenCalledTimes(1);
    });
  });
});

// Git status reaching the tree and the idle viewer (#11614). The store snapshot
// already carried per-file status; the pane only read its tick.
describe("FileBrowserPane git status derivation", () => {
  /** The realpath-resolved root git reports, distinct from the worktree path. */
  function setChanges(
    changes: { path: string; status: string }[],
    opts: { worktreePath?: string; changesRootPath?: string } = {}
  ) {
    worktreeTicks.git = 100;
    worktreeMock.path = opts.worktreePath ?? "/repo";
    worktreeMock.changesRootPath = opts.changesRootPath ?? worktreeMock.path;
    worktreeMock.changes = changes;
  }

  it("joins changes on the snapshot root, not the raw worktree path", async () => {
    // The regression this whole derivation exists to avoid. On macOS a worktree
    // under a symlinked ancestor reports `/tmp/...` as its path while git
    // resolves `/private/tmp/...`; stripping the worktree path off an absolute
    // change would leave it absolute, matching no row, and the feature would
    // silently mark nothing on exactly the machines it was written for.
    setChanges([{ path: "/private/tmp/wt/src/app.ts", status: "modified" }], {
      worktreePath: "/tmp/wt",
      changesRootPath: "/private/tmp/wt",
    });
    renderPane();

    await waitFor(() => expect(treeProps.gitStatusIndex).toBeTruthy());

    // Passed straight through: the lookup already accepts a missing index, so a
    // null one fails these assertions rather than needing a cast to rule out.
    expect(getFileBrowserRowGitStatus(treeProps.gitStatusIndex, "src/app.ts", false)).toBe(
      "modified"
    );
    expect(getFileBrowserRowGitStatus(treeProps.gitStatusIndex, "src", true)).toBe("modified");
  });

  it("summarises the changed files when nothing is selected", async () => {
    setChanges([{ path: "/repo/src/app.ts", status: "modified" }]);
    renderPane();

    expect(await screen.findByRole("button", { name: /Read src\/app\.ts/ })).toBeTruthy();
  });

  it("opens a summarised file whose tree row is not flattened", async () => {
    // `src` is collapsed here, so the changed file has no row at all. Requiring
    // one would make the summary click do nothing visible.
    treeState.rows = [
      {
        path: "src",
        name: "src",
        isDirectory: true,
        depth: 0,
        isExpanded: false,
        isLoading: false,
      },
    ];
    setChanges([{ path: "/repo/src/app.ts", status: "modified" }]);
    const { rerender } = renderPane();

    const row = await screen.findByRole("button", { name: /Read src\/app\.ts/ });
    await act(async () => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(setFileBrowserViewMock).toHaveBeenCalledWith(
      "fb-1",
      expect.objectContaining({ browserSelectedPath: "src/app.ts" })
    );

    // The store mock is non-reactive, so replay the write the pane just asked
    // for and re-render to see what the selection resolves to.
    mockPanel.browserSelectedPath = "src/app.ts";
    await act(async () => {
      rerender(paneJsx());
    });

    await waitFor(() => expect(readMock).toHaveBeenCalled());
    expect(readMock.mock.calls[0]?.[0]).toMatchObject({ path: "/repo/src/app.ts" });
  });

  it("refuses to open a deleted file that has no row", async () => {
    // Nothing on disk to read: admitting it would swap the pane for a
    // file-not-found error the moment a live delete landed on the open
    // selection. The pane stays on its idle body — here the summary, since the
    // deletion is itself a change worth listing.
    treeState.rows = [];
    setChanges([{ path: "/repo/src/gone.ts", status: "deleted" }]);
    mockPanel.browserSelectedPath = "src/gone.ts";
    renderPane();

    const row = await screen.findByRole("button", { name: /src\/gone\.ts/ });
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(readMock).not.toHaveBeenCalled();
  });

  it("drops a change whose path could not be made worktree-relative", async () => {
    // A root that doesn't prefix the change leaves it absolute; persisting one
    // as the selection would aim the viewer outside the worktree.
    setChanges([{ path: "/elsewhere/src/app.ts", status: "modified" }], {
      changesRootPath: "/repo",
    });
    renderPane();

    await screen.findByText("Nothing selected");
    // Git said there were changes and none survived: that is an unusable
    // snapshot, not an empty one. Calling it clean would state the opposite of
    // what git reported.
    expect(screen.queryByText("Worktree is clean")).toBeNull();
    expect(screen.queryByRole("button", { name: /Read/ })).toBeNull();
    expect(treeProps.gitStatusIndex).toBeNull();
  });

  it("expands a summarised file's ancestors so it stays findable in the tree", async () => {
    // Both halves of the feature exist for this: the summary is replaced by the
    // file the moment it opens, so the row has to be waiting behind it.
    treeState.rows = [
      {
        path: "src",
        name: "src",
        isDirectory: true,
        depth: 0,
        isExpanded: false,
        isLoading: false,
      },
    ];
    setChanges([{ path: "/repo/src/panels/app.ts", status: "modified" }]);
    renderPane();

    const row = await screen.findByRole("button", { name: /Read src\/panels\/app\.ts/ });
    await act(async () => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(setFileBrowserViewMock).toHaveBeenCalledWith("fb-1", {
      browserSelectedPath: "src/panels/app.ts",
      browserExpandedPaths: ["src", "src/panels"],
    });
  });

  it("refuses to read a changed path the tree knows is a directory", async () => {
    // Git reports a dirty submodule as a changed path while the filesystem calls
    // it a directory. The row wins: handing the viewer a directory to read is
    // exactly what the original file check existed to prevent.
    treeState.rows = [
      {
        path: "vendor",
        name: "vendor",
        isDirectory: true,
        depth: 0,
        isExpanded: false,
        isLoading: false,
      },
    ];
    setChanges([{ path: "/repo/vendor", status: "modified" }]);
    mockPanel.browserSelectedPath = "vendor";
    renderPane();

    await waitFor(() => expect(treeProps.gitStatusIndex).toBeTruthy());
    expect(readMock).not.toHaveBeenCalled();
  });

  it("says the worktree is clean only on a populated, empty snapshot", async () => {
    setChanges([]);
    renderPane();

    expect(await screen.findByText("Worktree is clean")).toBeTruthy();
  });

  it("keeps the generic placeholder when the snapshot carries only a tick", async () => {
    // The shape the store reports before changes populate. Reporting it as clean
    // would tell the user nothing changed when nothing is actually known.
    worktreeTicks.git = 100;
    worktreeMock.changes = null;
    renderPane();

    expect(await screen.findByText("Nothing selected")).toBeTruthy();
    expect(screen.queryByText("Worktree is clean")).toBeNull();
    expect(treeProps.gitStatusIndex).toBeNull();
  });

  it("gives a workspace-rooted browser no git status at all", async () => {
    workspaceRootPathMock.mockReturnValue("/workspace");
    setChanges([{ path: "/repo/src/app.ts", status: "modified" }]);
    renderPane({});

    expect(await screen.findByText("Nothing selected")).toBeTruthy();
    expect(treeProps.gitStatusIndex).toBeNull();
  });

  it("still derives the combined change tick from the fuller snapshot", async () => {
    // The tick now comes off the selected object rather than its own selector;
    // the fs side must still win when it is the more recent of the two.
    setChanges([{ path: "/repo/src/app.ts", status: "modified" }]);
    worktreeTicks.git = 120;
    worktreeTicks.fs = 450;
    renderPane();

    await waitFor(() => expect(treeArgs.changeTick).toBe(450));
  });
});

describe("a selection the dotfile filter hides (#11620)", () => {
  beforeEach(() => {
    treeState.rows = [
      {
        path: ".env",
        name: ".env",
        isDirectory: false,
        depth: 0,
        isExpanded: false,
        isLoading: false,
      },
    ] as typeof treeState.rows;
    mockPanel.browserSelectedPath = ".env";
    mockPanel.browserHideDotfiles = false;
  });

  afterEach(() => {
    treeState.rows = defaultRows as typeof treeState.rows;
    delete mockPanel.browserSelectedPath;
    delete mockPanel.browserHideDotfiles;
  });

  it("previews a dotfile while dotfiles are visible", () => {
    renderPane();
    expect(treeArgs.selectedPath).toBe(".env");
    expect(screen.queryByText("Nothing selected")).toBeNull();
  });

  it("stops previewing it once the dotfile toggle hides it", () => {
    // The node now resolves from the listings map rather than from the
    // rendered rows, so it survives the filter that removed its row — without
    // an explicit visibility gate the viewer would keep the file's contents on
    // screen while the tree stopped showing the file at all.
    mockPanel.browserHideDotfiles = true;
    renderPane();
    expect(screen.getByText("Nothing selected")).toBeTruthy();
  });
});

// The tree navigates; the viewer only moves when asked. Folder-click used to do
// both at once, so opening a branch to look for something else threw away the
// file the user was reading. These pin the split from the pane's side — the
// tree's own suite proves the row kind reaches this handler at all.
describe("FileBrowserPane tree navigation vs the viewer", () => {
  /** Did anything ask the viewer to move? */
  function viewerWrites(): unknown[] {
    return setFileBrowserViewMock.mock.calls
      .filter(([, patch]) => "browserSelectedPath" in (patch as object))
      .map(([, patch]) => (patch as { browserSelectedPath: string }).browserSelectedPath);
  }

  it("leaves the viewer alone when the cursor lands on a folder", () => {
    mockPanel.browserSelectedPath = "src/app.ts";
    renderPane();

    act(() => {
      treeProps.onSelect?.("src", true);
    });

    // The whole point: the open file survives navigating past a folder.
    expect(viewerWrites()).toEqual([]);
  });

  it("moves the viewer when the cursor lands on a file", () => {
    renderPane();

    act(() => {
      treeProps.onSelect?.("src/app.ts", false);
    });

    // A leaf has nothing to navigate into, so opening it is the only thing the
    // gesture could mean — the asymmetry that keeps single-click browsing.
    expect(viewerWrites()).toEqual(["src/app.ts"]);
  });

  it("moves the tree cursor for both kinds, viewer or no viewer", () => {
    renderPane();

    act(() => {
      treeProps.onSelect?.("src", true);
    });
    expect(treeProps.cursorPath).toBe("src");

    act(() => {
      treeProps.onSelect?.("src/app.ts", false);
    });
    expect(treeProps.cursorPath).toBe("src/app.ts");
  });

  it("opens a folder in the viewer on activate, the deliberate half of the split", () => {
    renderPane();

    act(() => {
      treeProps.onActivate?.("src");
    });

    // Enter is a folder's only keyboard route to the listing now that clicking
    // one is pure navigation. It must not also try to open a file panel.
    expect(viewerWrites()).toEqual(["src"]);
    // Not "wasn't called with these exact options" — a dispatch with slightly
    // different options would slip through that. Nothing should dispatch here.
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("gives the mouse the same route through the row menu", () => {
    // Without this item the folder listing would be keyboard-only, which would
    // read as the feature having been removed rather than made deliberate.
    renderPane();

    act(() => {
      screen.getByText("Show contents").click();
    });

    expect(viewerWrites()).toEqual([FOLDER_ROW.path]);
  });

  it("reads as one menu: the folder prefix, then the shared direct actions", () => {
    // The prefix lives here and the core lives in the shared hook, so nothing
    // else asserts that they compose. Order only — this suite's menu stub
    // renders no separators, and the hook's own suite counts those.
    renderPane();

    const menu = screen.getByTestId("file-tree-view");
    expect(
      within(menu)
        .getAllByRole("button")
        .filter((item) => item.closest("[data-submenu-content]") === null)
        .map((item) => item.textContent ?? "")
    ).toEqual([
      "Show contents",
      "Set as root",
      "Refresh",
      revealCopy().label,
      expect.stringContaining("Insert file reference"),
      "Copy",
    ]);
  });

  it("reveals a collapsed viewer for both explicit folder routes", () => {
    // The viewer column unmounts while collapsed, and these two gestures are a
    // folder's only routes to the listing — so on their own they would write a
    // selection nobody can see and tree-only mode would lose folder viewing
    // outright. One handler serves both, hence one test.
    mockPanel.browserViewerCollapsed = true;
    renderPane();

    act(() => {
      treeProps.onActivate?.("src");
    });
    act(() => {
      screen.getByText("Show contents").click();
    });

    expect(
      setFileBrowserViewMock.mock.calls
        .map(([, patch]) => patch as Record<string, unknown>)
        .filter((patch) => "browserSelectedPath" in patch)
    ).toEqual([
      { browserSelectedPath: "src", browserViewerCollapsed: false },
      { browserSelectedPath: FOLDER_ROW.path, browserViewerCollapsed: false },
    ]);
  });

  it("tells the tree which row the viewer is on, so it can be marked", () => {
    // The cursor and the open row are different questions once they diverge;
    // the tree needs both to answer either.
    mockPanel.browserSelectedPath = "src/app.ts";
    renderPane();

    act(() => {
      treeProps.onSelect?.("src", true);
    });

    expect(treeProps.cursorPath).toBe("src");
    expect(treeProps.openPath).toBe("src/app.ts");
  });

  it("rehomes a cursor stranded inside a branch the user collapsed", () => {
    // Collapsing takes every descendant row with it. A cursor left naming one
    // of them resolves to nothing, and every key that reads it goes dead —
    // Enter and the arrows included. The viewer's reveal strip can't rescue it
    // because collapsing never touched the viewer.
    renderPane();
    act(() => {
      treeProps.onSelect?.("src/app.ts", false);
    });
    expect(treeProps.cursorPath).toBe("src/app.ts");

    act(() => {
      treeProps.onToggleExpanded?.("src", false);
    });

    expect(treeProps.cursorPath).toBe("src");
  });

  it("leaves a cursor outside the collapsed branch alone", () => {
    // Prefix matching has to be path-segment honest: collapsing "src" must not
    // capture a cursor on a sibling that merely starts with the same letters.
    renderPane();
    act(() => {
      treeProps.onSelect?.("srcache/note.md", false);
    });

    act(() => {
      treeProps.onToggleExpanded?.("src", false);
    });

    expect(treeProps.cursorPath).toBe("srcache/note.md");
  });

  it("does not carry one panel's cursor into another", () => {
    // A tab group renders one unkeyed GridPanel for whichever tab is active, so
    // this component is reused rather than remounted when the user switches
    // between two file browsers. Keying the sync on the path alone would leak
    // the cursor whenever both panels' viewers agreed — including when both are
    // empty, which is every freshly opened pair.
    const { rerender } = render(
      <TooltipProvider>
        <FileBrowserPane
          id="fb-1"
          title="Files"
          worktreeId="wt-1"
          isFocused
          location="grid"
          onFocus={vi.fn()}
          onClose={vi.fn()}
        />
      </TooltipProvider>
    );
    act(() => {
      treeProps.onSelect?.("src", true);
    });
    expect(treeProps.cursorPath).toBe("src");

    rerender(
      <TooltipProvider>
        <FileBrowserPane
          id="fb-2"
          title="Files"
          worktreeId="wt-1"
          isFocused
          location="grid"
          onFocus={vi.fn()}
          onClose={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(treeProps.cursorPath).toBeNull();
  });

  it("re-points the cursor when the viewer is moved from outside the tree", () => {
    // `worktree.openFileBrowser` reveals a path this panel never clicked, and a
    // restored panel arrives the same way. The tree has to follow, or its
    // aria-activedescendant names a row that is no longer the subject.
    mockPanel.browserSelectedPath = "src/app.ts";
    const { rerender } = renderPane();
    act(() => {
      treeProps.onSelect?.("src", true);
    });
    expect(treeProps.cursorPath).toBe("src");

    mockPanel.browserSelectedPath = "src/other.ts";
    rerender(paneJsx({ worktreeId: "wt-1" }));

    expect(treeProps.cursorPath).toBe("src/other.ts");
  });
});
