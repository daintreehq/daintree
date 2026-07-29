// @vitest-environment jsdom
import { render, act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FileBrowserPane hosts the tree column beside the viewer. #11328 adds a
// collapse toggle (in the viewer's header) that unmounts the tree column and a
// shared header height so the divider line reads continuous. These tests drive
// the pane with the heavy tree/viewer leaves stubbed, but keep the REAL
// FileBrowserViewer so the toggle and the shared toolbar `Root` actually render
// — that's what makes the aria-controls and header-alignment invariants real.

const { setFileBrowserViewMock, readMock, treeState, defaultRows } = vi.hoisted(() => {
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
      ensureLoaded: vi.fn(),
      refresh: vi.fn(),
      isRefreshing: false,
      captureSnapshot: (() => null) as () => unknown,
    },
  };
});

interface MockPanel {
  id: string;
  kind: "file-browser";
  browserSelectedPath?: string;
  browserExpandedPaths?: string[];
  browserShowIgnored?: boolean;
  browserRootPath?: string;
  browserSidebarCollapsed?: boolean;
  browserSidebarWidth?: number;
}

const mockPanel: MockPanel = { id: "fb-1", kind: "file-browser" };

vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (state: unknown) => unknown) =>
    selector({
      panelsById: { "fb-1": mockPanel },
      setFileBrowserView: setFileBrowserViewMock,
    }),
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (state: unknown) => unknown) =>
    selector({
      worktrees: new Map([["wt-1", { path: "/repo", worktreeChanges: undefined }]]),
      // The pane reads the raw filesystem-write side map for its change tick
      // (#11330); an absent map would crash the `.get(worktreeId)` selector.
      workingTreeChangedAtById: new Map<string, number>(),
    }),
}));

// The tree data hook does real IPC + virtualization; stub it to a mutable
// state bag so the tree column renders its header (and the FileTreeView stub
// below) without touching filesClient, and tests can drive error states.
vi.mock("../useFileBrowserTree", () => ({
  useFileBrowserTree: () => ({ ...treeState }),
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
vi.mock("../FileTreeView", () => ({
  FileTreeView: ({ rowContextMenu }: { rowContextMenu?: (row: unknown) => React.ReactNode }) => (
    <div data-testid="file-tree-view" role="tree" tabIndex={-1}>
      {rowContextMenu?.(FOLDER_ROW)}
    </div>
  ),
}));

vi.mock("@/components/ui/context-menu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/context-menu")>()),
  ContextMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => <button onClick={onSelect}>{children}</button>,
  ContextMenuSeparator: () => null,
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
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
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

function renderPane(props: { worktreeId?: string } = { worktreeId: "wt-1" }) {
  return render(
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
  mockPanel.browserSidebarCollapsed = undefined;
  mockPanel.browserSelectedPath = undefined;
  mockPanel.browserRootPath = undefined;
  mockPanel.browserShowIgnored = undefined;
  mockPanel.browserSidebarWidth = undefined;
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
      classToken(el, (c) => c === "border-overlay" || c === "border-daintree-border");
    const iconSize = (el: Element) => classToken(el.querySelector("svg")!, (c) => /^h-/.test(c));

    // Guard against a vacuous undefined === undefined pass.
    expect(sidebarHeader).not.toBe(toolbarRoot);
    expect(vPad(sidebarHeader)).toBeDefined();
    expect(borderColor(sidebarHeader)).toBeDefined();
    expect(iconSize(sidebarHeader)).toBeDefined();

    // Relational invariant: whatever the shared toolbar uses, the sidebar header
    // matches it — so the line under the two bars reads continuous. A regression
    // that reverts one side (py-1 / border-daintree-border / h-3.5 icons) fails
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
  // "Copy full path" would produce for the same folder.
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
      expect.anything()
    );
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
      fireEvent.click(screen.getByRole("button", { name: "Copy full path" }));
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
