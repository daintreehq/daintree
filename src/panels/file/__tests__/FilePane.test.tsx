// @vitest-environment jsdom
import type { ReactNode } from "react";
import { render, act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FilePane forwards a fixed prop list to ContentPanel; #10991 was a dropped
// `showRestoreControl`, which hid the inline "Move to grid" button on a docked
// single file panel. Stub ContentPanel to capture what FilePane forwards, and
// mock the heavy store/client/viewer surface so we render only FilePane's own
// wiring — the seam that shipped the bug. The stub also renders `toolbar`, so
// the toolbar-owned open-in-editor error banner (#11114) is observable.
const contentPanelProps: Array<Record<string, unknown>> = [];

vi.mock("@/components/Panel/ContentPanel", () => ({
  ContentPanel: (
    props: Record<string, unknown> & { toolbar?: ReactNode; children?: ReactNode }
  ) => {
    contentPanelProps.push(props);
    // Render children too so the Source/Rendered branch is observable, not just
    // the toolbar (#11191 HTML preview branch).
    return (
      <>
        {props.toolbar}
        {props.children}
      </>
    );
  },
}));

// Mutable so a test can seed a real file panel (giving FilePane a filePath, and
// therefore a toolbar) without disturbing the prop-forwarding tests.
const panelsById: Record<string, unknown> = {};

vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (state: unknown) => unknown) =>
    selector({ panelsById, setFileViewMode: vi.fn(), setFilePanelPath: vi.fn() }),
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) => selector({ currentProject: null }),
}));
vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: (selector: (state: unknown) => unknown) =>
    selector({ markdownWrapLines: false, setMarkdownWrapLines: vi.fn() }),
}));
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (state: unknown) => unknown) => selector({ worktrees: new Map() }),
}));
vi.mock("@/store/accessibilityAnnouncerStore", () => ({
  useAnnouncerStore: { getState: () => ({ announce: vi.fn() }) },
}));
const { readMock, searchMock } = vi.hoisted(() => ({
  readMock: vi.fn(),
  searchMock: vi.fn(),
}));
vi.mock("@/clients/filesClient", () => ({
  filesClient: { read: readMock, search: searchMock },
}));
// dispatch() resolves an ActionDispatchResult union and never rejects; callers
// branch on `.ok`, so the mock must honour that shape rather than resolve void.
const { dispatchMock, notifyMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  notifyMock: vi.fn(),
}));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/components/Markdown/MarkdownViewer", () => ({
  MarkdownViewer: () => <div data-testid="markdown-viewer-mock" />,
}));
vi.mock("@/components/FileViewer/CodeViewer", () => ({
  CodeViewer: () => <div data-testid="code-viewer-mock" />,
}));
vi.mock("@/components/Html/HtmlViewer", () => ({
  HtmlViewer: (props: { previewUrl: string | null; reloadNonce: number }) => (
    <div
      data-testid="html-viewer-mock"
      data-preview-url={props.previewUrl ?? ""}
      data-reload-nonce={props.reloadNonce}
    />
  ),
}));

import { FilePane } from "../FilePane";
import { TooltipProvider } from "@/components/ui/tooltip";

function lastContentPanelProps(): Record<string, unknown> {
  const props = contentPanelProps.at(-1);
  if (!props) throw new Error("ContentPanel was not rendered");
  return props;
}

beforeEach(() => {
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({ ok: true, result: undefined });
  // Reset per test so a prior test's read call can't satisfy a later
  // toHaveBeenCalledWith assertion (cross-test contamination).
  readMock.mockReset();
  readMock.mockResolvedValue({ content: "" });
  searchMock.mockReset();
  searchMock.mockResolvedValue({ files: [] });
  // InlineStatusBanner reads window.matchMedia at render time; jsdom does not
  // implement it, so provide a no-op stub.
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
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
});

afterEach(() => {
  contentPanelProps.length = 0;
  for (const key of Object.keys(panelsById)) delete panelsById[key];
});

describe("FilePane restore-control wiring", () => {
  it("forwards showRestoreControl so a single docked file panel shows the inline restore button", () => {
    render(
      <FilePane
        id="file-1"
        title="spec.md"
        isFocused={false}
        location="dock"
        onFocus={() => {}}
        onClose={() => {}}
        onRestore={() => {}}
        showRestoreControl={true}
      />
    );

    const props = lastContentPanelProps();
    expect(props.showRestoreControl).toBe(true);
    expect(props.onRestore).toBeTypeOf("function");
  });

  it("forwards showRestoreControl=false so grouped docked panels keep the inline button hidden", () => {
    render(
      <FilePane
        id="file-2"
        title="spec.md"
        isFocused={false}
        location="dock"
        onFocus={() => {}}
        onClose={() => {}}
        onRestore={() => {}}
        showRestoreControl={false}
      />
    );

    expect(lastContentPanelProps().showRestoreControl).toBe(false);
  });
});

// #11114: dispatch() resolves {ok:false} rather than rejecting, so the old
// `.catch(logError)` was dead code and a failed open produced no feedback at all.
describe("FilePane open-in-editor failure feedback (#11114)", () => {
  function renderFilePane() {
    panelsById["file-1"] = { id: "file-1", kind: "file", filePath: "/repo/src/index.ts" };
    // The toolbar's path pill is a Radix Tooltip, which needs a provider once
    // the ContentPanel stub actually renders the toolbar.
    return render(
      <TooltipProvider>
        <FilePane
          id="file-1"
          title="index.ts"
          isFocused={false}
          location="grid"
          onFocus={() => {}}
          onClose={() => {}}
        />
      </TooltipProvider>
    );
  }

  function clickOpenInEditor(container: HTMLElement) {
    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Open in editor"
    );
    if (!button) throw new Error("Open in editor button not rendered");
    return act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("stays silent when the open succeeds", async () => {
    const { container } = renderFilePane();
    await clickOpenInEditor(container);

    expect(dispatchMock).toHaveBeenCalledWith(
      "file.openInEditor",
      { path: "/repo/src/index.ts" },
      { source: "user" }
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("surfaces the dispatch error inline when the open fails", async () => {
    const message = "No editor configured for .ts files";
    dispatchMock.mockResolvedValue({ ok: false, error: { code: "EXECUTION_ERROR", message } });

    const { container } = renderFilePane();
    await clickOpenInEditor(container);

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain(message);
    // Tier 3 is pane-local — the failure must not also fire a global toast.
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("collapses a double-click into a single editor launch", async () => {
    let resolveDispatch: (value: unknown) => void = () => {};
    dispatchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveDispatch = resolve;
      })
    );

    const { container } = renderFilePane();
    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Open in editor"
    )!;

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Without a synchronous guard the second click starts a second OS launch,
    // whose late failure could then paper over the first launch's success.
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDispatch({ ok: true, result: undefined });
    });

    // The guard released — the button is usable again, not latched.
    await clickOpenInEditor(container);
    expect(dispatchMock).toHaveBeenCalledTimes(2);
  });

  it("drops a stale failure when the pane switched files mid-flight", async () => {
    let resolveDispatch: (value: unknown) => void = () => {};
    dispatchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveDispatch = resolve;
      })
    );

    const { container, rerender } = renderFilePane();
    await clickOpenInEditor(container);

    // The pane is repointed at another file while the open is still in flight.
    panelsById["file-1"] = { id: "file-1", kind: "file", filePath: "/repo/src/other.ts" };
    rerender(
      <TooltipProvider>
        <FilePane
          id="file-1"
          title="other.ts"
          isFocused={false}
          location="grid"
          onFocus={() => {}}
          onClose={() => {}}
        />
      </TooltipProvider>
    );

    await act(async () => {
      resolveDispatch({
        ok: false,
        error: { code: "EXECUTION_ERROR", message: "Stale failure for index.ts" },
      });
    });

    // The old file's failure must not be reported against the new one.
    expect(container.querySelector('[role="alert"]')).toBeNull();

    // ...and the switch must have released the in-flight guard, or the button
    // would be permanently dead on the new file.
    dispatchMock.mockResolvedValue({ ok: true, result: undefined });
    await clickOpenInEditor(container);
    expect(dispatchMock).toHaveBeenLastCalledWith(
      "file.openInEditor",
      { path: "/repo/src/other.ts" },
      { source: "user" }
    );
  });

  it("clears the error once a retry succeeds", async () => {
    dispatchMock.mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "Editor launch failed" },
    });
    const { container } = renderFilePane();
    await clickOpenInEditor(container);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    dispatchMock.mockResolvedValue({ ok: true, result: undefined });
    const retry = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Retry")
    );
    await act(async () => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Retry must re-run the action against the same file, not merely dismiss.
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(dispatchMock).toHaveBeenLastCalledWith(
      "file.openInEditor",
      { path: "/repo/src/index.ts" },
      { source: "user" }
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

// #11191: HTML files get the same Source/Rendered toggle as Markdown; rendered
// HTML routes to the sandboxed-iframe HtmlViewer.
describe("FilePane HTML Source/Rendered (#11191)", () => {
  function renderPane(filePath: string, fileViewMode?: "source" | "rendered") {
    panelsById["file-1"] = { id: "file-1", kind: "file", filePath, fileViewMode };
    return render(
      <TooltipProvider>
        <FilePane
          id="file-1"
          title={filePath.split("/").pop() ?? filePath}
          isFocused={false}
          location="grid"
          onFocus={() => {}}
          onClose={() => {}}
        />
      </TooltipProvider>
    );
  }

  it("shows the Source/Rendered toggle for an .html file", async () => {
    renderPane("/repo/dist/report.html");
    // SegmentedToggle labels are literal text; both appear only for renderable files.
    expect(await screen.findByText("Rendered")).toBeTruthy();
    expect(screen.getByText("Source")).toBeTruthy();
  });

  it("shows the toggle for a .htm file", async () => {
    renderPane("/repo/dist/page.htm");
    expect(await screen.findByText("Rendered")).toBeTruthy();
  });

  it("does not show the toggle for a non-renderable file (.css)", async () => {
    renderPane("/repo/src/index.css");
    // Wait for load to settle so we're not asserting on a pre-render frame.
    await screen.findByTestId("code-viewer-mock");
    expect(screen.queryByText("Rendered")).toBeNull();
  });

  it("routes rendered HTML to the sandboxed HtmlViewer with the minted preview URL", async () => {
    readMock.mockResolvedValue({
      content: "<h1>x</h1>",
      htmlPreviewUrl: "daintree-html://tok/report.html",
    });
    renderPane("/repo/dist/report.html", "rendered");
    const viewer = await screen.findByTestId("html-viewer-mock");
    // The URL from files:read must reach HtmlViewer's previewUrl prop.
    expect(viewer.getAttribute("data-preview-url")).toBe("daintree-html://tok/report.html");
    expect(screen.queryByTestId("code-viewer-mock")).toBeNull();
  });

  it("routes source HTML to the CodeViewer, not the HtmlViewer", async () => {
    renderPane("/repo/dist/report.html", "source");
    expect(await screen.findByTestId("code-viewer-mock")).toBeTruthy();
    expect(screen.queryByTestId("html-viewer-mock")).toBeNull();
  });

  it("passes htmlPreview:true to files:read for HTML files", async () => {
    renderPane("/repo/dist/report.html", "rendered");
    await waitFor(() =>
      expect(readMock).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/repo/dist/report.html", htmlPreview: true })
      )
    );
  });

  it("passes htmlPreview:false to files:read for non-HTML files", async () => {
    renderPane("/repo/src/index.css");
    await waitFor(() =>
      expect(readMock).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/repo/src/index.css", htmlPreview: false })
      )
    );
  });

  it("still routes rendered Markdown to the MarkdownViewer (regression)", async () => {
    renderPane("/repo/docs/spec.md", "rendered");
    expect(await screen.findByTestId("markdown-viewer-mock")).toBeTruthy();
    expect(screen.queryByTestId("html-viewer-mock")).toBeNull();
  });
});
