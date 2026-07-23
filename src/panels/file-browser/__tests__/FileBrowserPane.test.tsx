// @vitest-environment jsdom
import { render, act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// FileBrowserPane hosts the tree column beside the viewer. #11328 adds a
// collapse toggle (in the viewer's header) that unmounts the tree column and a
// shared header height so the divider line reads continuous. These tests drive
// the pane with the heavy tree/viewer leaves stubbed, but keep the REAL
// FileBrowserViewer so the toggle and the shared toolbar `Root` actually render
// — that's what makes the aria-controls and header-alignment invariants real.

const { setFileBrowserViewMock } = vi.hoisted(() => ({ setFileBrowserViewMock: vi.fn() }));

interface MockPanel {
  id: string;
  kind: "file-browser";
  browserSelectedPath?: string;
  browserExpandedPaths?: string[];
  browserShowIgnored?: boolean;
  browserRootPath?: string;
  browserSidebarCollapsed?: boolean;
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
    }),
}));

// The tree data hook does real IPC + virtualization; stub it to a single row so
// the tree column renders its header (and the FileTreeView stub below), without
// touching filesClient.
vi.mock("../useFileBrowserTree", () => ({
  useFileBrowserTree: () => ({
    rows: [
      {
        path: "src",
        name: "src",
        isDirectory: true,
        depth: 0,
        isExpanded: false,
        isLoading: false,
        isIgnored: false,
      },
    ],
    isInitialLoading: false,
    rootError: null,
    ensureLoaded: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("../FileTreeView", () => ({
  FileTreeView: () => <div data-testid="file-tree-view" role="tree" tabIndex={-1} />,
}));

// ContentPanel is chrome around the body; render just the children so the
// pane's own layout is what's under test.
vi.mock("@/components/Panel/ContentPanel", () => ({
  ContentPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Viewer leaf modules the real FileBrowserViewer imports — never reached with no
// file selected, but stubbed so their heavy renderers stay out of the suite.
vi.mock("@/clients/filesClient", () => ({ filesClient: { read: vi.fn() } }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("@/components/Markdown/MarkdownViewer", () => ({ MarkdownViewer: () => null }));
vi.mock("@/components/FileViewer/CodeViewer", () => ({ CodeViewer: () => null }));
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
  mockPanel.browserSidebarCollapsed = undefined;
  mockPanel.browserSelectedPath = undefined;
  mockPanel.browserRootPath = undefined;
  mockPanel.browserShowIgnored = undefined;
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

    // Relational invariant: whatever the shared toolbar uses, the sidebar header
    // matches it — so the line under the two bars reads continuous. A regression
    // that reverts one side (py-1 / border-daintree-border) fails here.
    expect(sidebarHeader).not.toBe(toolbarRoot);
    expect(vPad(sidebarHeader)).toBe(vPad(toolbarRoot));
    expect(borderColor(sidebarHeader)).toBe(borderColor(toolbarRoot));
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
