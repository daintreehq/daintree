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

vi.mock("../FileTreeView", () => ({
  FileTreeView: () => <div data-testid="file-tree-view" role="tree" tabIndex={-1} />,
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
import { TooltipProvider } from "@/components/ui/tooltip";

function renderPane() {
  return render(
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
}

function classToken(el: Element, predicate: (cls: string) => boolean): string | undefined {
  return Array.from(el.classList).find(predicate);
}

beforeEach(() => {
  setFileBrowserViewMock.mockReset();
  readMock.mockReset();
  readMock.mockResolvedValue({ content: "hello" });
  flushPanelPersistenceMock.mockReset();
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

    expect(screen.getByText("Couldn't read this worktree")).toBeTruthy();
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

  it("drives the tree column width and separator value from the stored width", () => {
    mockPanel.browserSidebarWidth = 400;
    renderPane();

    expect(treeColumn().style.width).toBe("400px");
    expect(separator().getAttribute("aria-valuenow")).toBe("400");
  });

  it("falls back to the 288px default when no width is stored", () => {
    renderPane();

    expect(treeColumn().style.width).toBe("288px");
    expect(separator().getAttribute("aria-valuenow")).toBe("288");
  });

  it("exposes a focusable vertical separator with the bounds as ARIA values", () => {
    renderPane();
    const handle = separator();

    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuemin")).toBe("200");
    expect(handle.getAttribute("aria-valuemax")).toBe("600");
    expect(handle.getAttribute("tabindex")).toBe("0");
  });

  it("widens on a rightward drag and narrows on a leftward drag, writing every move", () => {
    renderPane(); // starts at 288
    const handle = separator();

    fireEvent.mouseDown(handle, { clientX: 100, detail: 1 });
    fireEvent.mouseMove(document, { clientX: 150 }); // +50 → 338
    fireEvent.mouseMove(document, { clientX: 120 }); // -20 vs start → 308
    fireEvent.mouseUp(document);

    // Continuous writes, one per move, delta from the mousedown-captured start.
    expect(setFileBrowserViewMock).toHaveBeenNthCalledWith(1, "fb-1", { browserSidebarWidth: 338 });
    expect(setFileBrowserViewMock).toHaveBeenNthCalledWith(2, "fb-1", { browserSidebarWidth: 308 });
  });

  it("clamps a drag past either bound to the min and max", () => {
    renderPane();
    const handle = separator();

    fireEvent.mouseDown(handle, { clientX: 100, detail: 1 });
    fireEvent.mouseMove(document, { clientX: 1200 }); // +1100 → clamp 600
    fireEvent.mouseMove(document, { clientX: 0 }); // -100 vs start → clamp 200
    fireEvent.mouseUp(document);

    expect(setFileBrowserViewMock).toHaveBeenNthCalledWith(1, "fb-1", { browserSidebarWidth: 600 });
    expect(setFileBrowserViewMock).toHaveBeenNthCalledWith(2, "fb-1", { browserSidebarWidth: 200 });
  });

  it("ignores the second mousedown of a double-click so the reset doesn't jitter first", () => {
    renderPane();
    const handle = separator();

    // detail > 1 is the browser's synthetic second mousedown before dblclick.
    fireEvent.mouseDown(handle, { clientX: 100, detail: 2 });
    fireEvent.mouseMove(document, { clientX: 300 });

    // No drag listener was attached, so the move writes nothing.
    expect(setFileBrowserViewMock).not.toHaveBeenCalled();
  });

  it("resets to the default width on double-click", () => {
    mockPanel.browserSidebarWidth = 500;
    renderPane();

    fireEvent.doubleClick(separator());

    expect(setFileBrowserViewMock).toHaveBeenCalledWith("fb-1", { browserSidebarWidth: 288 });
  });

  it("resizes from the keyboard: arrows step, Shift coarsens, Home/End jump to bounds", () => {
    renderPane(); // 288
    const handle = separator();

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(setFileBrowserViewMock).toHaveBeenLastCalledWith("fb-1", { browserSidebarWidth: 298 });

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(setFileBrowserViewMock).toHaveBeenLastCalledWith("fb-1", { browserSidebarWidth: 278 });

    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(setFileBrowserViewMock).toHaveBeenLastCalledWith("fb-1", { browserSidebarWidth: 338 });

    fireEvent.keyDown(handle, { key: "Home" });
    expect(setFileBrowserViewMock).toHaveBeenLastCalledWith("fb-1", { browserSidebarWidth: 200 });

    fireEvent.keyDown(handle, { key: "End" });
    expect(setFileBrowserViewMock).toHaveBeenLastCalledWith("fb-1", { browserSidebarWidth: 600 });
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

  it("restores the previously-dragged width after collapse and re-expand", () => {
    mockPanel.browserSidebarWidth = 420;
    const { rerender } = renderPane();
    expect(treeColumn().style.width).toBe("420px");

    mockPanel.browserSidebarCollapsed = true;
    rerender(paneJsx());
    expect(screen.queryByTestId("file-browser-sidebar-resize")).toBeNull();

    // Width is decoupled from the collapsed flag, so re-opening comes back at the
    // last-dragged width rather than the default.
    mockPanel.browserSidebarCollapsed = false;
    rerender(paneJsx());
    expect(treeColumn().style.width).toBe("420px");
    expect(separator().getAttribute("aria-valuenow")).toBe("420");
  });

  it("drops the document listeners when the pane unmounts mid-drag", () => {
    const { unmount } = renderPane();

    fireEvent.mouseDown(separator(), { clientX: 100, detail: 1 });
    unmount();
    // The unmount effect fired the drag cleanup, so this move reaches no listener.
    fireEvent.mouseMove(document, { clientX: 400 });

    expect(setFileBrowserViewMock).not.toHaveBeenCalled();
  });

  it("drops the document listeners when the sidebar collapses mid-drag", () => {
    const { rerender } = renderPane();

    fireEvent.mouseDown(separator(), { clientX: 100, detail: 1 });
    // Collapse unmounts the grip but not the pane, so a dedicated effect must
    // fire the same cleanup — otherwise the document listeners keep writing.
    mockPanel.browserSidebarCollapsed = true;
    rerender(paneJsx());
    fireEvent.mouseMove(document, { clientX: 400 });

    expect(setFileBrowserViewMock).not.toHaveBeenCalled();
  });
});
