// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { forwardRef, useEffect, useState, type ReactNode } from "react";

let mockObserverInstances: MockIntersectionObserver[] = [];

class MockIntersectionObserver {
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  observed: Element[] = [];

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
    mockObserverInstances.push(this);
  }

  observe(target: Element) {
    this.observed.push(target);
  }

  unobserve(target: Element) {
    this.observed = this.observed.filter((el) => el !== target);
  }

  disconnect() {
    this.observed = [];
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
// jsdom does not implement Trusted Types. Mock the renderer policy module
// with pass-through spies so the modal renders sanitized SVG inline AND we
// can assert the policy is exercised on the SVG path. See #6392.
const { mockCreateTrustedHTML } = vi.hoisted(() => ({
  mockCreateTrustedHTML: vi.fn((s: string) => s),
}));
vi.mock("@/lib/trustedTypesPolicy", () => ({
  createTrustedHTML: mockCreateTrustedHTML,
  setTrustedInnerHTML: (el: Element, html: string) => {
    el.innerHTML = html;
  },
}));

import { FileViewerModal } from "../FileViewerModal";
import { useDiffViewedStore } from "@/store/diffViewedStore";

const { capturedDialogProps } = vi.hoisted(() => ({
  capturedDialogProps: { restoreFocusTo: undefined as unknown },
}));

vi.mock("@/components/ui/AppDialog", () => {
  interface MockProps {
    isOpen: boolean;
    children: ReactNode;
    onClose: () => void;
    restoreFocusTo?: unknown;
  }
  interface SectionProps {
    children: ReactNode;
    className?: string;
  }

  const AppDialog = ({ isOpen, children, restoreFocusTo }: MockProps) => {
    capturedDialogProps.restoreFocusTo = restoreFocusTo;
    return isOpen ? <div data-testid="app-dialog">{children}</div> : null;
  };

  AppDialog.Header = ({ children, className }: SectionProps) => (
    <div className={className}>{children}</div>
  );
  AppDialog.Title = ({ children, className }: SectionProps) => (
    <h2 className={className}>{children}</h2>
  );
  AppDialog.CloseButton = () => <button type="button">close</button>;
  AppDialog.BodyScroll = ({ children, className }: SectionProps) => (
    <div className={className}>{children}</div>
  );

  return { AppDialog };
});

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode; asChild?: boolean }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// Controls whether the mock DiffViewer starts collapsed (no hunk rows in the
// DOM until the user expands). Defaults to false so existing tests render hunks
// immediately; the collapsed-by-default regression test flips it to true.
const { mockDiffViewerControl } = vi.hoisted(() => ({
  mockDiffViewerControl: { startCollapsed: false },
}));

vi.mock("@/components/Worktree/DiffViewer", () => ({
  DiffViewer: forwardRef<
    HTMLDivElement,
    {
      onRetry?: () => void;
      onToggleCollapse?: () => void;
      searchQuery?: string;
      onTokensRendered?: () => void;
    }
  >(({ onRetry, onToggleCollapse, searchQuery, onTokensRendered }, ref) => {
    // Mirrors the real DiffViewer: when a file is collapsed by default, its
    // hunk rows are absent from the DOM until the user expands, at which point
    // it fires onToggleCollapse so the modal can re-scan. Collapsing again
    // removes the rows and fires the callback once more. See #10013.
    const [expanded, setExpanded] = useState(!mockDiffViewerControl.startCollapsed);
    // Mirrors the real DiffViewer's token pass: search marks land in the DOM
    // and onTokensRendered fires so the modal re-scans for matches.
    useEffect(() => {
      onTokensRendered?.();
    }, [searchQuery, onTokensRendered]);
    return (
      <div ref={ref} data-testid="diff-viewer" data-has-retry={onRetry ? "true" : "false"}>
        <button
          type="button"
          data-testid="collapse-toggle"
          onClick={() => {
            onToggleCollapse?.();
            setExpanded((prev) => !prev);
          }}
        >
          {expanded ? "Hide diff" : "Show diff"}
        </button>
        {expanded && (
          // Two stub hunk rows so hunk-nav tests have predictable targets.
          // Each tbody must contain a tr:first-child for the IntersectionObserver
          // to observe (tbody alone collapses to 0 height in Chromium).
          <table>
            <tbody className="diff-hunk" data-testid="hunk-0">
              <tr>
                <td>hunk 0</td>
              </tr>
            </tbody>
            <tbody className="diff-hunk" data-testid="hunk-1">
              <tr>
                <td>hunk 1</td>
              </tr>
            </tbody>
          </table>
        )}
        {expanded && searchQuery && (
          // Two stub match spans, standing in for the token-pass highlights
          // (gone while collapsed, like the real token spans).
          <>
            <span className="diff-search-match" data-testid="match-0">
              m0
            </span>
            <span className="diff-search-match" data-testid="match-1">
              m1
            </span>
          </>
        )}
      </div>
    );
  }),
}));

const setDiffViewTypeMock = vi.fn();
const setDiffShowFileListMock = vi.fn();
const setDiffFontSizeMock = vi.fn();
const usePreferencesStoreMock = vi.fn((selector?: (s: Record<string, unknown>) => unknown) => {
  const state = {
    diffViewType: "split" as const,
    setDiffViewType: setDiffViewTypeMock,
    diffShowFileList: true,
    setDiffShowFileList: setDiffShowFileListMock,
    diffFontSize: "m" as const,
    setDiffFontSize: setDiffFontSizeMock,
  };
  return selector ? selector(state) : state;
});
vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: (selector?: (s: Record<string, unknown>) => unknown) =>
    usePreferencesStoreMock(selector),
}));

vi.mock("../CodeViewer", () => ({
  CodeViewer: forwardRef((_props: Record<string, unknown>, _ref: unknown) => (
    <div data-testid="code-viewer" />
  )),
}));

const mockRead = vi.fn();
vi.mock("@/clients/filesClient", () => ({
  filesClient: {
    read: (...args: unknown[]) => mockRead(...args),
  },
}));

const mockDispatch = vi.fn().mockResolvedValue({ ok: true, result: undefined });
vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => mockDispatch(...args),
  },
}));

const { mockSanitizeSvg } = vi.hoisted(() => ({
  mockSanitizeSvg: vi.fn(
    (
      content: string
    ): { ok: true; svg: string; modified: boolean } | { ok: false; error: string } => ({
      ok: true,
      svg: content,
      modified: false,
    })
  ),
}));
vi.mock("@shared/utils/svgSanitizer", () => ({
  sanitizeSvg: mockSanitizeSvg,
}));

const scrollIntoViewCalls: HTMLElement[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mockObserverInstances = [];
  mockDiffViewerControl.startCollapsed = false;
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  mockRead.mockResolvedValue({ content: "file content" });
  setDiffViewTypeMock.mockReset();
  usePreferencesStoreMock.mockImplementation(
    (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = {
        diffViewType: "split" as const,
        setDiffViewType: setDiffViewTypeMock,
        diffShowFileList: true,
        setDiffShowFileList: setDiffShowFileListMock,
        diffFontSize: "m" as const,
        setDiffFontSize: setDiffFontSizeMock,
      };
      return selector ? selector(state) : state;
    }
  );
  // jsdom does not implement scrollIntoView; record the receiver for hunk-nav.
  scrollIntoViewCalls.length = 0;
  Element.prototype.scrollIntoView = vi.fn(function (this: HTMLElement) {
    scrollIntoViewCalls.push(this);
  });
});

describe("FileViewerModal", () => {
  const defaultProps = {
    isOpen: true,
    filePath: "/project/src/index.ts",
    rootPath: "/project",
    onClose: vi.fn(),
  };

  it("renders code viewer for non-image files", async () => {
    render(<FileViewerModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("code-viewer")).toBeTruthy();
    });

    expect(screen.getByLabelText("Open in editor")).toBeTruthy();
    expect(screen.queryByLabelText("Open in image viewer")).toBeNull();
  });

  it("renders inline image for PNG files without calling filesClient.read", async () => {
    render(<FileViewerModal {...defaultProps} filePath="/project/assets/logo.png" />);

    await waitFor(() => {
      const img = screen.getByRole("img");
      expect(img).toBeTruthy();
      expect(img.getAttribute("src")).toContain("daintree-file://load");
      expect(img.getAttribute("src")).toContain(encodeURIComponent("/project/assets/logo.png"));
    });

    expect(mockRead).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Open in image viewer")).toBeTruthy();
    expect(screen.queryByLabelText("Open in editor")).toBeNull();
  });

  it.each(["jpg", "jpeg", "gif", "webp", "bmp", "ico"])(
    "renders inline image for .%s files",
    async (ext) => {
      render(<FileViewerModal {...defaultProps} filePath={`/project/image.${ext}`} />);

      await waitFor(() => {
        expect(screen.getByRole("img")).toBeTruthy();
      });

      expect(mockRead).not.toHaveBeenCalled();
    }
  );

  it("renders sanitized SVG inline through the trusted types policy", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>';
    mockRead.mockResolvedValue({ content: svg });

    const { container } = render(
      <FileViewerModal {...defaultProps} filePath="/project/icon.svg" />
    );

    await waitFor(() => {
      expect(mockRead).toHaveBeenCalledWith({
        path: "/project/icon.svg",
        rootPath: "/project",
      });
    });

    await waitFor(() => {
      expect(container.querySelector("svg")).toBeTruthy();
    });
    expect(container.innerHTML).toContain('<circle r="10">');
    expect(mockCreateTrustedHTML).toHaveBeenCalledWith(svg);
    expect(screen.getByLabelText("Open in image viewer")).toBeTruthy();
    expect(screen.queryByLabelText("Open in editor")).toBeNull();
  });

  it("shows the sanitizer's error message when SVG sanitization fails", async () => {
    mockRead.mockResolvedValue({ content: "not an svg" });
    mockSanitizeSvg.mockReturnValueOnce({
      ok: false,
      error: "Content does not appear to be a valid SVG",
    });

    render(<FileViewerModal {...defaultProps} filePath="/project/icon.svg" />);

    await waitFor(() => {
      expect(screen.getByText("Content does not appear to be a valid SVG")).toBeTruthy();
    });

    expect(screen.queryByText("Invalid file path")).toBeNull();
    const errorContainer = screen
      .getByText("Content does not appear to be a valid SVG")
      .closest("div")!;
    expect(
      within(errorContainer).getByRole("button", { name: "Open in image viewer" })
    ).toBeTruthy();
    expect(screen.queryByText("Open in Image Viewer")).toBeNull();
  });

  it("shows a generic error when an image fails to load", async () => {
    render(<FileViewerModal {...defaultProps} filePath="/project/photo.png" />);

    await waitFor(() => {
      expect(screen.getByRole("img")).toBeTruthy();
    });

    fireEvent.error(screen.getByRole("img"));

    await waitFor(() => {
      expect(screen.getByText("Unable to display image")).toBeTruthy();
    });

    expect(screen.queryByText("File no longer exists")).toBeNull();
    const errorContainer = screen.getByText("Unable to display image").closest("div")!;
    expect(
      within(errorContainer).getByRole("button", { name: "Open in image viewer" })
    ).toBeTruthy();
  });

  it("shows the file-read error message when reading an SVG fails", async () => {
    mockRead.mockRejectedValue(
      Object.assign(new Error("File not found"), { name: "AppError", code: "NOT_FOUND" })
    );

    render(<FileViewerModal {...defaultProps} filePath="/project/icon.svg" />);

    await waitFor(() => {
      expect(screen.getByText("File no longer exists")).toBeTruthy();
    });

    expect(mockSanitizeSvg).not.toHaveBeenCalled();
  });

  it("clears a stale SVG sanitization error when navigating to another file", async () => {
    mockRead.mockResolvedValue({ content: "not an svg" });
    mockSanitizeSvg.mockReturnValueOnce({
      ok: false,
      error: "Content does not appear to be a valid SVG",
    });

    const { rerender, container } = render(
      <FileViewerModal {...defaultProps} filePath="/project/bad.svg" />
    );

    await waitFor(() => {
      expect(screen.getByText("Content does not appear to be a valid SVG")).toBeTruthy();
    });

    mockRead.mockResolvedValue({
      content: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>',
    });

    rerender(<FileViewerModal {...defaultProps} filePath="/project/good.svg" />);

    await waitFor(() => {
      expect(container.querySelector("svg")).toBeTruthy();
    });
    expect(screen.queryByText("Content does not appear to be a valid SVG")).toBeNull();
  });

  it("shows binary error with Open in Editor for non-image binaries", async () => {
    mockRead.mockRejectedValue(
      Object.assign(new Error("Binary file"), { name: "AppError", code: "BINARY_FILE" })
    );

    render(<FileViewerModal {...defaultProps} filePath="/project/app.wasm" />);

    await waitFor(() => {
      expect(screen.getByText("Binary file — cannot display")).toBeTruthy();
    });

    expect(screen.queryByLabelText("Open in image viewer")).toBeNull();
  });

  it("dispatches file.openImageViewer when image viewer button is clicked", async () => {
    render(<FileViewerModal {...defaultProps} filePath="/project/photo.jpg" />);

    await waitFor(() => {
      expect(screen.getByLabelText("Open in image viewer")).toBeTruthy();
    });

    screen.getByLabelText("Open in image viewer").click();

    expect(mockDispatch).toHaveBeenCalledWith(
      "file.openImageViewer",
      { path: "/project/photo.jpg" },
      { source: "user" }
    );
  });

  it("renders image for files outside the project root using parent dir as effective root", async () => {
    render(
      <FileViewerModal
        {...defaultProps}
        filePath="/Users/someone/Desktop/photo.png"
        rootPath="/project"
      />
    );

    await waitFor(() => {
      const img = screen.getByRole("img");
      expect(img).toBeTruthy();
      const src = img.getAttribute("src")!;
      expect(src).toContain("daintree-file://load");
      expect(src).toContain(encodeURIComponent("/Users/someone/Desktop/photo.png"));
      expect(src).toContain(encodeURIComponent("/Users/someone/Desktop"));
      expect(src).not.toContain(encodeURIComponent("/project"));
    });

    expect(mockRead).not.toHaveBeenCalled();
  });

  it("reads text files outside the project root using parent dir as effective root", async () => {
    render(<FileViewerModal {...defaultProps} filePath="/tmp/notes.txt" rootPath="/project" />);

    await waitFor(() => {
      expect(mockRead).toHaveBeenCalledWith({
        path: "/tmp/notes.txt",
        rootPath: "/tmp",
      });
    });
  });

  it("does not render when isOpen is false", () => {
    render(<FileViewerModal {...defaultProps} isOpen={false} />);

    expect(screen.queryByTestId("app-dialog")).toBeNull();
  });

  it("renders metadata bar with line count, size, and encoding when file is loaded", async () => {
    mockRead.mockResolvedValue({ content: "line1\nline2\nline3" });

    render(<FileViewerModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText(/3 lines/)).toBeTruthy();
      expect(screen.getByText(/UTF-8/)).toBeTruthy();
    });
  });

  it("does not render metadata bar for image files", async () => {
    render(<FileViewerModal {...defaultProps} filePath="/project/photo.png" />);

    await waitFor(() => {
      expect(screen.getByRole("img")).toBeTruthy();
    });

    expect(screen.queryByText(/lines/)).toBeNull();
    expect(screen.queryByText(/UTF-8/)).toBeNull();
  });

  it("does not render metadata bar when file fails to load", async () => {
    mockRead.mockRejectedValue(
      Object.assign(new Error("File not found"), { name: "AppError", code: "NOT_FOUND" })
    );

    render(<FileViewerModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("File no longer exists")).toBeTruthy();
    });

    expect(screen.queryByText(/lines/)).toBeNull();
    expect(screen.queryByText(/UTF-8/)).toBeNull();
  });

  it("allows toggling from diff to view mode without snapping back", async () => {
    render(
      <FileViewerModal
        {...defaultProps}
        diff={"diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new"}
        defaultMode="diff"
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("diff-viewer")).toBeTruthy();
    });

    // Wait for file content to load so the View button is enabled
    await waitFor(() => {
      const viewBtn = screen.getByRole("button", { name: "View" });
      expect(viewBtn.hasAttribute("disabled")).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: "View" }));

    await waitFor(() => {
      expect(screen.getByTestId("code-viewer")).toBeTruthy();
    });
    expect(screen.queryByTestId("diff-viewer")).toBeNull();
  });

  it("auto-switches to diff mode when diff arrives asynchronously", async () => {
    const { rerender } = render(
      <FileViewerModal {...defaultProps} diff={undefined} defaultMode="diff" />
    );

    // Initially shows loading diff skeleton (mode is "diff" but no diff content yet)
    await waitFor(() => {
      expect(screen.getByRole("status", { name: "Loading diff" })).toBeTruthy();
    });

    rerender(
      <FileViewerModal
        {...defaultProps}
        diff={"diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new"}
        defaultMode="diff"
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("diff-viewer")).toBeTruthy();
    });
  });

  describe("diff view type persistence", () => {
    const diff = "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new";

    it("calls setDiffViewType('unified') when Unified is clicked", async () => {
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Unified" })).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: "Unified" }));
      expect(setDiffViewTypeMock).toHaveBeenCalledWith("unified");
    });

    it("calls setDiffViewType('split') when Split is clicked", async () => {
      // Start with persisted 'unified' so clicking Split is a real transition.
      usePreferencesStoreMock.mockImplementation(
        (selector?: (s: Record<string, unknown>) => unknown) => {
          const state = { diffViewType: "unified" as const, setDiffViewType: setDiffViewTypeMock };
          return selector ? selector(state) : state;
        }
      );

      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Split" })).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: "Split" }));
      expect(setDiffViewTypeMock).toHaveBeenCalledWith("split");
    });
  });

  describe("keyboard hunk navigation in diff mode", () => {
    const diff = "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new";

    // jsdom has no matchMedia; without it prefersReducedMotion() defaults to
    // true and hunk nav falls back to instant scrolling.
    beforeEach(() => {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      }));
    });

    it("scrolls to the first hunk on initial `n`", async () => {
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />);

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });

      const hunk0 = screen.getByTestId("hunk-0");
      scrollIntoViewCalls.length = 0;
      fireEvent.keyDown(window, { key: "n" });

      expect(scrollIntoViewCalls.at(-1)).toBe(hunk0);
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
        block: "start",
        behavior: "smooth",
      });
    });

    it("advances to the next hunk on subsequent `n`", async () => {
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />);

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });

      const hunk1 = screen.getByTestId("hunk-1");
      scrollIntoViewCalls.length = 0;
      fireEvent.keyDown(window, { key: "n" }); // hunk 0
      fireEvent.keyDown(window, { key: "n" }); // hunk 1

      expect(scrollIntoViewCalls.at(-1)).toBe(hunk1);
    });

    it("does not wrap past the last hunk when `n` is pressed at the end", async () => {
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />);

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });

      // Walk forward to the last hunk, then press past the end.
      fireEvent.keyDown(window, { key: "n" }); // hunk 0
      fireEvent.keyDown(window, { key: "n" }); // hunk 1 (last)
      scrollIntoViewCalls.length = 0;
      fireEvent.keyDown(window, { key: "n" });
      fireEvent.keyDown(window, { key: "n" });

      // Past the end with no next file in the changeset the step is a no-op:
      // no wrap to hunk 0 and no redundant re-scroll of the last hunk.
      expect(scrollIntoViewCalls.length).toBe(0);
    });

    it("scrolls to the previous hunk on `p`", async () => {
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />);

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });

      const hunk0 = screen.getByTestId("hunk-0");
      fireEvent.keyDown(window, { key: "n" });
      fireEvent.keyDown(window, { key: "n" }); // now on hunk 1
      scrollIntoViewCalls.length = 0;
      fireEvent.keyDown(window, { key: "p" });

      expect(scrollIntoViewCalls.at(-1)).toBe(hunk0);
    });

    it("ignores `n`/`p` while in view mode", async () => {
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="view" />);

      await waitFor(() => {
        expect(screen.getByTestId("code-viewer")).toBeTruthy();
      });

      scrollIntoViewCalls.length = 0;
      expect(() => fireEvent.keyDown(window, { key: "n" })).not.toThrow();
      expect(scrollIntoViewCalls).toHaveLength(0);
    });

    it("ignores `n`/`p` when a modifier key is held", async () => {
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />);

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });

      scrollIntoViewCalls.length = 0;
      fireEvent.keyDown(window, { key: "n", metaKey: true });
      fireEvent.keyDown(window, { key: "n", ctrlKey: true });
      fireEvent.keyDown(window, { key: "n", altKey: true });

      expect(scrollIntoViewCalls).toHaveLength(0);
    });

    it("resets the hunk index when the diff prop changes for the same file", async () => {
      const diffA = "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new";
      const diffB = "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-foo\n+bar";

      const { rerender } = render(
        <FileViewerModal {...defaultProps} diff={diffA} defaultMode="diff" />
      );

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });

      // Walk past the first hunk.
      fireEvent.keyDown(window, { key: "n" });
      fireEvent.keyDown(window, { key: "n" });

      // Swap diff content; the hunk index must reset so the next `n` lands on
      // the first hunk of the new diff again.
      rerender(<FileViewerModal {...defaultProps} diff={diffB} defaultMode="diff" />);

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });

      scrollIntoViewCalls.length = 0;
      const hunk0 = screen.getByTestId("hunk-0");
      fireEvent.keyDown(window, { key: "n" });

      expect(scrollIntoViewCalls.at(-1)).toBe(hunk0);
    });

    it("ignores `n`/`p` when focus is in an input", async () => {
      render(
        <>
          <input data-testid="other-input" />
          <FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />
        </>
      );

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });

      const input = screen.getByTestId("other-input") as HTMLInputElement;
      input.focus();
      scrollIntoViewCalls.length = 0;
      fireEvent.keyDown(input, { key: "n" });

      expect(scrollIntoViewCalls).toHaveLength(0);
    });
  });

  it("resets auto-switch when file changes while modal stays open", async () => {
    const diffA = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new";
    const diffB = "diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-foo\n+bar";

    const { rerender } = render(
      <FileViewerModal
        {...defaultProps}
        filePath="/project/src/a.ts"
        diff={diffA}
        defaultMode="diff"
      />
    );

    // File A starts in diff mode
    await waitFor(() => {
      expect(screen.getByTestId("diff-viewer")).toBeTruthy();
    });

    // Switch to file B without diff yet (async pattern)
    rerender(
      <FileViewerModal
        {...defaultProps}
        filePath="/project/src/b.ts"
        diff={undefined}
        defaultMode="diff"
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("status", { name: "Loading diff" })).toBeTruthy();
    });

    // Diff for file B arrives — should auto-switch to diff mode
    rerender(
      <FileViewerModal
        {...defaultProps}
        filePath="/project/src/b.ts"
        diff={diffB}
        defaultMode="diff"
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("diff-viewer")).toBeTruthy();
    });
  });

  it("does not show view/diff toggle when diff is ERROR sentinel", async () => {
    render(<FileViewerModal {...defaultProps} diff="ERROR" defaultMode="diff" />);

    // DiffViewer renders with the ERROR sentinel (diff is truthy and mode is "diff")
    await waitFor(() => {
      expect(screen.getByTestId("diff-viewer")).toBeTruthy();
    });

    // Toggle buttons should not appear when diff is ERROR
    expect(screen.queryByRole("button", { name: "View" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Diff" })).toBeNull();
  });

  it("forwards onRetryDiff to DiffViewer", async () => {
    const onRetry = vi.fn();

    render(
      <FileViewerModal
        {...defaultProps}
        diff={"diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new"}
        defaultMode="diff"
        onRetryDiff={onRetry}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("diff-viewer")).toBeTruthy();
    });

    expect(screen.getByTestId("diff-viewer").getAttribute("data-has-retry")).toBe("true");
  });

  it("does not forward retry to DiffViewer when onRetryDiff is omitted", async () => {
    render(
      <FileViewerModal
        {...defaultProps}
        diff={"diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new"}
        defaultMode="diff"
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("diff-viewer")).toBeTruthy();
    });

    expect(screen.getByTestId("diff-viewer").getAttribute("data-has-retry")).toBe("false");
  });

  describe("hunk position indicator", () => {
    const diff = "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new";

    function makeEntry(
      target: Element,
      intersectionRatio: number,
      isIntersecting = true
    ): IntersectionObserverEntry {
      return {
        target,
        intersectionRatio,
        isIntersecting,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        boundingClientRect: {} as DOMRectReadOnly,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        intersectionRect: {} as DOMRectReadOnly,
        rootBounds: null,
        time: 0,
      } as IntersectionObserverEntry;
    }

    function fireObserver(
      observer: MockIntersectionObserver,
      entries: IntersectionObserverEntry[]
    ) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      observer.callback(entries, observer as unknown as IntersectionObserver);
    }

    it("is hidden when diff is not loaded", async () => {
      render(<FileViewerModal {...defaultProps} defaultMode="view" />);

      await waitFor(() => {
        expect(screen.getByTestId("code-viewer")).toBeTruthy();
      });

      expect(screen.queryByTestId("hunk-position-indicator")).toBeNull();
    });

    it("is hidden in view mode even with diff content", async () => {
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="view" />);

      await waitFor(() => {
        expect(screen.getByTestId("code-viewer")).toBeTruthy();
      });

      expect(screen.queryByTestId("hunk-position-indicator")).toBeNull();
    });

    it("shows Hunk 1 of 2 when observer fires for the first hunk", async () => {
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />);

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });

      // The effect should create an IntersectionObserver instance
      expect(mockObserverInstances.length).toBe(1);
      const observer = mockObserverInstances[0]!;

      // Fire the callback with the first hunk visible
      const hunk0Row = screen.getByTestId("hunk-0").querySelector("tr");
      expect(hunk0Row).toBeTruthy();
      fireObserver(observer, [makeEntry(hunk0Row!, 0.8)]);

      await waitFor(() => {
        expect(screen.getByTestId("hunk-position-indicator")).toBeTruthy();
        expect(screen.getByTestId("hunk-position-indicator").textContent).toBe("Hunk 1 of 2");
      });
    });

    it("updates indicator when observer fires for the second hunk", async () => {
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />);

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });

      expect(mockObserverInstances.length).toBe(1);
      const observer = mockObserverInstances[0]!;

      const hunk1Row = screen.getByTestId("hunk-1").querySelector("tr");
      expect(hunk1Row).toBeTruthy();
      fireObserver(observer, [makeEntry(hunk1Row!, 1.0)]);

      await waitFor(() => {
        expect(screen.getByTestId("hunk-position-indicator").textContent).toBe("Hunk 2 of 2");
      });
    });

    it("picks the hunk with highest intersectionRatio when multiple fire", async () => {
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />);

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });

      expect(mockObserverInstances.length).toBe(1);
      const observer = mockObserverInstances[0]!;

      const hunk0Row = screen.getByTestId("hunk-0").querySelector("tr");
      const hunk1Row = screen.getByTestId("hunk-1").querySelector("tr");

      // Hunk 1 is more visible than hunk 0
      fireObserver(observer, [makeEntry(hunk0Row!, 0.3), makeEntry(hunk1Row!, 0.9)]);

      await waitFor(() => {
        expect(screen.getByTestId("hunk-position-indicator").textContent).toBe("Hunk 2 of 2");
      });
    });

    it("n key updates the indicator immediately", async () => {
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />);

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });

      fireEvent.keyDown(window, { key: "n" });

      await waitFor(() => {
        expect(screen.getByTestId("hunk-position-indicator").textContent).toBe("Hunk 1 of 2");
      });
    });

    it("p key updates the indicator after navigating forward", async () => {
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />);

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });

      fireEvent.keyDown(window, { key: "n" }); // hunk 0
      fireEvent.keyDown(window, { key: "n" }); // hunk 1

      await waitFor(() => {
        expect(screen.getByTestId("hunk-position-indicator").textContent).toBe("Hunk 2 of 2");
      });

      fireEvent.keyDown(window, { key: "p" }); // back to hunk 0

      await waitFor(() => {
        expect(screen.getByTestId("hunk-position-indicator").textContent).toBe("Hunk 1 of 2");
      });
    });

    it("disconnects observer on unmount", async () => {
      const { unmount } = render(
        <FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />
      );

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });

      expect(mockObserverInstances.length).toBe(1);
      const observer = mockObserverInstances[0]!;
      const disconnectSpy = vi.spyOn(observer, "disconnect");

      unmount();

      expect(disconnectSpy).toHaveBeenCalled();
    });

    it("handles bidirectional observer tracking", async () => {
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />);

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });

      expect(mockObserverInstances.length).toBe(1);
      const observer = mockObserverInstances[0]!;

      const hunk0Row = screen.getByTestId("hunk-0").querySelector("tr");
      const hunk1Row = screen.getByTestId("hunk-1").querySelector("tr");

      // Show hunk 1 as most visible
      fireObserver(observer, [makeEntry(hunk1Row!, 1.0)]);

      await waitFor(() => {
        expect(screen.getByTestId("hunk-position-indicator").textContent).toBe("Hunk 2 of 2");
      });

      // Scroll back — hunk 0 becomes most visible, hunk 1 fades
      fireObserver(observer, [makeEntry(hunk0Row!, 0.95), makeEntry(hunk1Row!, 0.3)]);

      await waitFor(() => {
        expect(screen.getByTestId("hunk-position-indicator").textContent).toBe("Hunk 1 of 2");
      });
    });

    it("survives zero-ratio entries without crashing", async () => {
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />);

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });

      expect(mockObserverInstances.length).toBe(1);
      const observer = mockObserverInstances[0]!;

      const hunk0Row = screen.getByTestId("hunk-0").querySelector("tr");

      // Fire callback with all hunks at ratio 0 (fully scrolled out)
      expect(() => {
        fireObserver(observer, [makeEntry(hunk0Row!, 0, false)]);
      }).not.toThrow();
    });

    it("ignores late observer callback after unmount", async () => {
      const { unmount } = render(
        <FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />
      );

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });

      expect(mockObserverInstances.length).toBe(1);
      const observer = mockObserverInstances[0]!;
      const hunk0Row = screen.getByTestId("hunk-0").querySelector("tr");

      unmount();

      // Fire callback after unmount — must not throw or trigger state update warning
      expect(() => {
        fireObserver(observer, [makeEntry(hunk0Row!, 1.0)]);
      }).not.toThrow();
    });

    // Regression for #10013: when a file is collapsed by default (generated
    // files, large diffs), its hunk rows are absent at first scan, so no
    // observer attaches. Expanding must re-scan and wire up the indicator.
    it("wires up the indicator after a collapsed-by-default file is expanded", async () => {
      mockDiffViewerControl.startCollapsed = true;
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />);

      await waitFor(() => {
        expect(screen.getByTestId("collapse-toggle")).toBeTruthy();
      });

      // Collapsed: no hunk rows, so no observer and no indicator yet.
      expect(screen.queryByTestId("hunk-0")).toBeNull();
      expect(mockObserverInstances.length).toBe(0);
      expect(screen.queryByTestId("hunk-position-indicator")).toBeNull();

      // Expand the file — onToggleCollapse bumps collapseRevision, re-running the scan.
      fireEvent.click(screen.getByTestId("collapse-toggle"));

      await waitFor(() => {
        expect(mockObserverInstances.length).toBe(1);
      });

      const observer = mockObserverInstances[0]!;
      const hunk0Row = screen.getByTestId("hunk-0").querySelector("tr");
      expect(hunk0Row).toBeTruthy();
      fireObserver(observer, [makeEntry(hunk0Row!, 0.8)]);

      await waitFor(() => {
        expect(screen.getByTestId("hunk-position-indicator").textContent).toBe("Hunk 1 of 2");
      });
    });

    // Regression for #10013: re-collapsing after expand must clear the indicator —
    // the hunk rows are gone, so "Hunk X of Y" should not linger over an empty body.
    it("clears the indicator when an expanded file is re-collapsed", async () => {
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />);

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });

      // Start expanded (default): observer fires, indicator shows.
      const observer = mockObserverInstances[0]!;
      const hunk0Row = screen.getByTestId("hunk-0").querySelector("tr");
      fireObserver(observer, [makeEntry(hunk0Row!, 0.8)]);

      await waitFor(() => {
        expect(screen.getByTestId("hunk-position-indicator").textContent).toBe("Hunk 1 of 2");
      });

      // Collapse — onToggleCollapse re-runs the scan, which finds 0 hunks.
      fireEvent.click(screen.getByTestId("collapse-toggle"));

      await waitFor(() => {
        expect(screen.queryByTestId("hunk-0")).toBeNull();
        expect(screen.queryByTestId("hunk-position-indicator")).toBeNull();
      });
    });
  });

  describe("in-diff search", () => {
    const diff = "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new";

    async function openSearch() {
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />);
      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });
      window.dispatchEvent(new Event("daintree:find-in-panel"));
      return await screen.findByPlaceholderText("Find in diff");
    }

    it("opens the find bar on find-in-panel, counts matches, and steps with Enter", async () => {
      const input = await openSearch();

      fireEvent.change(input, { target: { value: "ne" } });

      await waitFor(() => {
        expect(screen.getByTestId("diff-search-count").textContent).toBe("2 matches");
      });

      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(screen.getByTestId("diff-search-count").textContent).toBe("1 of 2");
      });
      expect(scrollIntoViewCalls.at(-1)).toBe(screen.getByTestId("match-0"));
      await waitFor(() => {
        expect(screen.getByTestId("match-0").classList.contains("diff-search-current")).toBe(true);
      });
      expect(screen.getByTestId("match-1").classList.contains("diff-search-current")).toBe(false);

      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(screen.getByTestId("diff-search-count").textContent).toBe("2 of 2");
      });
      expect(scrollIntoViewCalls.at(-1)).toBe(screen.getByTestId("match-1"));

      // Shift+Enter steps backwards.
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("diff-search-count").textContent).toBe("1 of 2");
      });
    });

    it("shows No matches when the query has no hits", async () => {
      const input = await openSearch();

      // The stub renders match spans for any query, so simulate the no-hit
      // case through the real scan path: a query while the diff is collapsed
      // (no spans in the DOM).
      fireEvent.click(screen.getByTestId("collapse-toggle"));
      fireEvent.change(input, { target: { value: "zzz" } });

      await waitFor(() => {
        expect(screen.getByTestId("diff-search-count").textContent).toBe("No matches");
      });
      expect(screen.getByLabelText("Next match").hasAttribute("disabled")).toBe(true);
    });

    it("Escape closes the find bar without closing the dialog", async () => {
      const onClose = vi.fn();
      render(
        <FileViewerModal {...defaultProps} onClose={onClose} diff={diff} defaultMode="diff" />
      );
      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });
      window.dispatchEvent(new Event("daintree:find-in-panel"));
      const input = await screen.findByPlaceholderText("Find in diff");

      fireEvent.keyDown(input, { key: "Escape" });

      await waitFor(() => {
        expect(screen.queryByPlaceholderText("Find in diff")).toBeNull();
      });
      expect(onClose).not.toHaveBeenCalled();
    });

    it("the footer toggle opens and closes the find bar", async () => {
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />);
      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: "Find in diff" }));
      expect(await screen.findByPlaceholderText("Find in diff")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Find in diff" }));
      await waitFor(() => {
        expect(screen.queryByPlaceholderText("Find in diff")).toBeNull();
      });
    });

    it("routes find-in-panel to CodeViewer search in view mode, not the find bar", async () => {
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="view" />);
      await waitFor(() => {
        expect(screen.getByTestId("code-viewer")).toBeTruthy();
      });

      window.dispatchEvent(new Event("daintree:find-in-panel"));

      expect(screen.queryByPlaceholderText("Find in diff")).toBeNull();
    });
  });

  describe("file stepping (#9217)", () => {
    const stepProps = {
      totalFileCount: 3,
      onNavigateFile: vi.fn(),
    };

    it("does not render the position indicator or nav buttons for a single file", async () => {
      render(<FileViewerModal {...defaultProps} totalFileCount={1} onNavigateFile={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByTestId("code-viewer")).toBeTruthy();
      });

      expect(screen.queryByTestId("file-position-indicator")).toBeNull();
      expect(screen.queryByLabelText("Previous file")).toBeNull();
    });

    it("does not render nav controls when onNavigateFile is omitted", async () => {
      render(<FileViewerModal {...defaultProps} totalFileCount={3} />);

      await waitFor(() => {
        expect(screen.getByTestId("code-viewer")).toBeTruthy();
      });

      expect(screen.queryByTestId("file-position-indicator")).toBeNull();
    });

    it("renders the position indicator and nav buttons across a multi-file set", async () => {
      render(<FileViewerModal {...defaultProps} {...stepProps} currentFileIndex={1} />);

      await waitFor(() => {
        expect(screen.getByTestId("file-position-indicator")).toBeTruthy();
      });

      expect(screen.getByTestId("file-position-indicator").textContent).toBe("2 of 3");
      expect(screen.getByLabelText("Previous file").hasAttribute("disabled")).toBe(false);
      expect(screen.getByLabelText("Next file").hasAttribute("disabled")).toBe(false);
    });

    it("disables Previous at the first file", async () => {
      render(<FileViewerModal {...defaultProps} {...stepProps} currentFileIndex={0} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Previous file")).toBeTruthy();
      });

      expect(screen.getByLabelText("Previous file").hasAttribute("disabled")).toBe(true);
      expect(screen.getByLabelText("Next file").hasAttribute("disabled")).toBe(false);
    });

    it("disables Next at the last file", async () => {
      render(<FileViewerModal {...defaultProps} {...stepProps} currentFileIndex={2} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Next file")).toBeTruthy();
      });

      expect(screen.getByLabelText("Next file").hasAttribute("disabled")).toBe(true);
      expect(screen.getByLabelText("Previous file").hasAttribute("disabled")).toBe(false);
    });

    it("calls onNavigateFile(1) on `]` and (-1) on `[`", async () => {
      const onNavigateFile = vi.fn();
      render(
        <FileViewerModal
          {...defaultProps}
          totalFileCount={3}
          currentFileIndex={1}
          onNavigateFile={onNavigateFile}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId("file-position-indicator")).toBeTruthy();
      });

      fireEvent.keyDown(window, { key: "]" });
      expect(onNavigateFile).toHaveBeenCalledWith(1);

      fireEvent.keyDown(window, { key: "[" });
      expect(onNavigateFile).toHaveBeenCalledWith(-1);
    });

    it("does not step past the boundaries via keyboard", async () => {
      const onNavigateFile = vi.fn();
      const { rerender } = render(
        <FileViewerModal
          {...defaultProps}
          totalFileCount={3}
          currentFileIndex={0}
          onNavigateFile={onNavigateFile}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId("file-position-indicator")).toBeTruthy();
      });

      // `[` at the first file is a no-op
      fireEvent.keyDown(window, { key: "[" });
      expect(onNavigateFile).not.toHaveBeenCalled();

      rerender(
        <FileViewerModal
          {...defaultProps}
          totalFileCount={3}
          currentFileIndex={2}
          onNavigateFile={onNavigateFile}
        />
      );

      // `]` at the last file is a no-op
      fireEvent.keyDown(window, { key: "]" });
      expect(onNavigateFile).not.toHaveBeenCalled();
    });

    it("clicking the nav buttons calls onNavigateFile with the right delta", async () => {
      const onNavigateFile = vi.fn();
      render(
        <FileViewerModal
          {...defaultProps}
          totalFileCount={3}
          currentFileIndex={1}
          onNavigateFile={onNavigateFile}
        />
      );

      await waitFor(() => {
        expect(screen.getByLabelText("Next file")).toBeTruthy();
      });

      fireEvent.click(screen.getByLabelText("Next file"));
      expect(onNavigateFile).toHaveBeenCalledWith(1);

      fireEvent.click(screen.getByLabelText("Previous file"));
      expect(onNavigateFile).toHaveBeenCalledWith(-1);
    });

    it("ignores `[`/`]` when focus is in an input", async () => {
      const onNavigateFile = vi.fn();
      render(
        <>
          <input data-testid="other-input" />
          <FileViewerModal
            {...defaultProps}
            totalFileCount={3}
            currentFileIndex={1}
            onNavigateFile={onNavigateFile}
          />
        </>
      );

      await waitFor(() => {
        expect(screen.getByTestId("file-position-indicator")).toBeTruthy();
      });

      const input = screen.getByTestId("other-input") as HTMLInputElement;
      input.focus();
      fireEvent.keyDown(input, { key: "]" });

      expect(onNavigateFile).not.toHaveBeenCalled();
    });

    it("forwards restoreFocusTo to AppDialog", async () => {
      const ref = { current: document.createElement("div") };
      render(<FileViewerModal {...defaultProps} restoreFocusTo={ref} />);

      await waitFor(() => {
        expect(screen.getByTestId("code-viewer")).toBeTruthy();
      });

      expect(capturedDialogProps.restoreFocusTo).toBe(ref);
    });
  });

  describe("review workspace (changeSet)", () => {
    const diff = "diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const changeSet = [
      {
        path: "src/a.ts",
        status: "modified" as const,
        insertions: 3,
        deletions: 1,
        viewedKey: "modified:src/a.ts",
      },
      {
        path: "src/b.ts",
        status: "added" as const,
        insertions: 10,
        deletions: 0,
        viewedKey: "added:src/b.ts",
      },
      {
        path: "docs/c.md",
        status: "deleted" as const,
        insertions: 0,
        deletions: 5,
        viewedKey: "deleted:docs/c.md",
      },
    ];

    beforeEach(() => {
      useDiffViewedStore.setState({ viewedByWorktree: {} });
    });

    function renderWorkspace(overrides: Record<string, unknown> = {}) {
      const onSelectFile = vi.fn();
      const onNavigateFile = vi.fn();
      render(
        <FileViewerModal
          {...defaultProps}
          filePath="/project/src/a.ts"
          diff={diff}
          defaultMode="diff"
          changeSet={changeSet}
          onSelectFile={onSelectFile}
          onNavigateFile={onNavigateFile}
          currentFileIndex={0}
          totalFileCount={changeSet.length}
          {...overrides}
        />
      );
      return { onSelectFile, onNavigateFile };
    }

    it("renders the changed-files sidebar with all changeset entries", async () => {
      renderWorkspace();

      await waitFor(() => {
        expect(screen.getByTestId("diff-file-sidebar")).toBeTruthy();
      });
      expect(screen.getAllByTestId("diff-sidebar-file")).toHaveLength(3);
      expect(screen.getByTestId("diff-sidebar-progress").textContent).toContain("0 of 3 viewed");
    });

    it("does not render the sidebar for single-file openers", async () => {
      render(<FileViewerModal {...defaultProps} diff={diff} defaultMode="diff" />);

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });
      expect(screen.queryByTestId("diff-file-sidebar")).toBeNull();
    });

    it("jumps to a file when its sidebar row is clicked", async () => {
      const { onSelectFile } = renderWorkspace();

      await waitFor(() => {
        expect(screen.getByTestId("diff-file-sidebar")).toBeTruthy();
      });
      // Rows are directory-grouped, so target by label rather than position;
      // the callback still receives the file's index in the flat changeset.
      fireEvent.click(screen.getByLabelText("Open docs/c.md"));
      expect(onSelectFile).toHaveBeenCalledWith(2);
    });

    it("`v` marks the open file viewed and advances to the next unviewed file", async () => {
      const { onSelectFile } = renderWorkspace();

      await waitFor(() => {
        expect(screen.getByTestId("diff-file-sidebar")).toBeTruthy();
      });
      fireEvent.keyDown(window, { key: "v" });

      expect(
        useDiffViewedStore.getState().viewedByWorktree["/project"]?.has("modified:src/a.ts")
      ).toBe(true);
      expect(onSelectFile).toHaveBeenCalledWith(1);
    });

    it("`v` skips already-viewed files when advancing", async () => {
      useDiffViewedStore.getState().setViewed("/project", "added:src/b.ts", true);
      const { onSelectFile } = renderWorkspace();

      await waitFor(() => {
        expect(screen.getByTestId("diff-file-sidebar")).toBeTruthy();
      });
      fireEvent.keyDown(window, { key: "v" });

      expect(onSelectFile).toHaveBeenCalledWith(2);
    });

    it("the footer Viewed button toggles without advancing", async () => {
      const { onSelectFile } = renderWorkspace();

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewed-button")).toBeTruthy();
      });
      fireEvent.click(screen.getByTestId("diff-viewed-button"));

      expect(
        useDiffViewedStore.getState().viewedByWorktree["/project"]?.has("modified:src/a.ts")
      ).toBe(true);
      expect(onSelectFile).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId("diff-viewed-button"));
      expect(
        useDiffViewedStore.getState().viewedByWorktree["/project"]?.has("modified:src/a.ts")
      ).toBe(false);
    });

    it("`n` past the last hunk steps to the next file", async () => {
      const { onNavigateFile } = renderWorkspace();

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });
      fireEvent.keyDown(window, { key: "n" }); // hunk 0
      fireEvent.keyDown(window, { key: "n" }); // hunk 1 (last)
      fireEvent.keyDown(window, { key: "n" }); // crosses into the next file

      expect(onNavigateFile).toHaveBeenCalledWith(1);
    });

    it("`p` before the first hunk steps to the previous file", async () => {
      const { onNavigateFile } = renderWorkspace({ currentFileIndex: 1 });

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });
      fireEvent.keyDown(window, { key: "n" }); // hunk 0
      fireEvent.keyDown(window, { key: "p" }); // crosses into the previous file

      expect(onNavigateFile).toHaveBeenCalledWith(-1);
    });

    it("`n` at the end of the last file stays put", async () => {
      const { onNavigateFile } = renderWorkspace({ currentFileIndex: 2 });

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });
      fireEvent.keyDown(window, { key: "n" }); // hunk 0
      fireEvent.keyDown(window, { key: "n" }); // hunk 1 (last)
      fireEvent.keyDown(window, { key: "n" });

      expect(onNavigateFile).not.toHaveBeenCalled();
    });

    it("sidebar filter narrows the list without touching the open file", async () => {
      renderWorkspace();

      await waitFor(() => {
        expect(screen.getByTestId("diff-file-sidebar")).toBeTruthy();
      });
      fireEvent.change(screen.getByTestId("diff-sidebar-filter"), { target: { value: "docs" } });

      expect(screen.getAllByTestId("diff-sidebar-file")).toHaveLength(1);
    });

    it("Escape in the filter clears it instead of closing the workspace", async () => {
      const onClose = vi.fn();
      renderWorkspace({ onClose });

      await waitFor(() => {
        expect(screen.getByTestId("diff-file-sidebar")).toBeTruthy();
      });
      const filter = screen.getByTestId("diff-sidebar-filter");
      fireEvent.change(filter, { target: { value: "docs" } });
      expect(screen.getAllByTestId("diff-sidebar-file")).toHaveLength(1);

      fireEvent.keyDown(filter, { key: "Escape" });

      expect((filter as HTMLInputElement).value).toBe("");
      expect(screen.getAllByTestId("diff-sidebar-file")).toHaveLength(3);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("`n` on a hunkless file continues to the next file instead of dead-ending", async () => {
      // Collapsed mock = no tbody.diff-hunk rows, standing in for a binary
      // or image file mid-changeset.
      mockDiffViewerControl.startCollapsed = true;
      const { onNavigateFile } = renderWorkspace({ currentFileIndex: 1 });

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });
      fireEvent.keyDown(window, { key: "n" });

      expect(onNavigateFile).toHaveBeenCalledWith(1);
    });

    it("hides viewed controls when the changeset entry does not match the open file", async () => {
      // Index/list drift: currentFileIndex points at src/b.ts while the open
      // file is src/a.ts — the guard must refuse to mark the wrong viewedKey.
      renderWorkspace({ currentFileIndex: 1 });

      await waitFor(() => {
        expect(screen.getByTestId("diff-viewer")).toBeTruthy();
      });
      expect(screen.queryByTestId("diff-viewed-button")).toBeNull();
    });
  });
});
