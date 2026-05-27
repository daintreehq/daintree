// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { forwardRef, type ReactNode } from "react";

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

vi.mock("@/components/ui/AppDialog", () => {
  interface MockProps {
    isOpen: boolean;
    children: ReactNode;
    onClose: () => void;
  }
  interface SectionProps {
    children: ReactNode;
    className?: string;
  }

  const AppDialog = ({ isOpen, children }: MockProps) =>
    isOpen ? <div data-testid="app-dialog">{children}</div> : null;

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

vi.mock("@/components/Worktree/DiffViewer", () => ({
  DiffViewer: forwardRef<HTMLDivElement, { onRetry?: () => void }>(({ onRetry }, ref) => (
    <div ref={ref} data-testid="diff-viewer" data-has-retry={onRetry ? "true" : "false"}>
      {/* Two stub hunk rows so hunk-nav tests have predictable targets.
          Each tbody must contain a tr:first-child for the IntersectionObserver
          to observe (tbody alone collapses to 0 height in Chromium). */}
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
    </div>
  )),
}));

const setDiffViewTypeMock = vi.fn();
const usePreferencesStoreMock = vi.fn((selector?: (s: Record<string, unknown>) => unknown) => {
  const state = {
    diffViewType: "split" as const,
    setDiffViewType: setDiffViewTypeMock,
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

vi.mock("@shared/utils/svgSanitizer", () => ({
  sanitizeSvg: (content: string) => ({
    ok: true,
    svg: content,
    modified: false,
  }),
}));

const scrollIntoViewCalls: HTMLElement[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mockObserverInstances = [];
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  mockRead.mockResolvedValue({ content: "file content" });
  setDiffViewTypeMock.mockReset();
  usePreferencesStoreMock.mockImplementation(
    (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = {
        diffViewType: "split" as const,
        setDiffViewType: setDiffViewTypeMock,
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

    expect(screen.getByText("Open in Editor")).toBeTruthy();
    expect(screen.queryByText("Open in Image Viewer")).toBeNull();
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
    expect(screen.getByText("Open in Image Viewer")).toBeTruthy();
    expect(screen.queryByText("Open in Editor")).toBeNull();
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
    expect(screen.getByText("Open in Image Viewer")).toBeTruthy();
    expect(screen.queryByText("Open in Editor")).toBeNull();
  });

  it("shows binary error with Open in Editor for non-image binaries", async () => {
    mockRead.mockRejectedValue(
      Object.assign(new Error("Binary file"), { name: "AppError", code: "BINARY_FILE" })
    );

    render(<FileViewerModal {...defaultProps} filePath="/project/app.wasm" />);

    await waitFor(() => {
      expect(screen.getByText("Binary file — cannot display")).toBeTruthy();
    });

    expect(screen.queryByText("Open in Image Viewer")).toBeNull();
  });

  it("dispatches file.openImageViewer when image viewer button is clicked", async () => {
    render(<FileViewerModal {...defaultProps} filePath="/project/photo.jpg" />);

    await waitFor(() => {
      expect(screen.getByText("Open in Image Viewer")).toBeTruthy();
    });

    screen.getByText("Open in Image Viewer").click();

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

      const hunk1 = screen.getByTestId("hunk-1");

      // Walk forward to the last hunk, then press past the end.
      fireEvent.keyDown(window, { key: "n" }); // hunk 0
      fireEvent.keyDown(window, { key: "n" }); // hunk 1 (last)
      scrollIntoViewCalls.length = 0;
      fireEvent.keyDown(window, { key: "n" });
      fireEvent.keyDown(window, { key: "n" });

      // Clamping past the end must keep landing on hunk 1, never wrap to hunk 0.
      expect(scrollIntoViewCalls.length).toBeGreaterThan(0);
      for (const target of scrollIntoViewCalls) {
        expect(target).toBe(hunk1);
      }
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
  });
});
