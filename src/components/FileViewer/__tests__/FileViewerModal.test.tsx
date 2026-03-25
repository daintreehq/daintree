// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { forwardRef, type ReactNode } from "react";
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
  DiffViewer: () => <div data-testid="diff-viewer" />,
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

beforeEach(() => {
  vi.clearAllMocks();
  mockRead.mockResolvedValue({ ok: true, content: "file content" });
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
      expect(img.getAttribute("src")).toContain("canopy-file://load");
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

  it("renders sanitized SVG inline", async () => {
    mockRead.mockResolvedValue({
      ok: true,
      content: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>',
    });

    render(<FileViewerModal {...defaultProps} filePath="/project/icon.svg" />);

    await waitFor(() => {
      expect(mockRead).toHaveBeenCalledWith({
        path: "/project/icon.svg",
        rootPath: "/project",
      });
    });

    expect(screen.getByText("Open in Image Viewer")).toBeTruthy();
    expect(screen.queryByText("Open in Editor")).toBeNull();
  });

  it("shows binary error with Open in Editor for non-image binaries", async () => {
    mockRead.mockResolvedValue({ ok: false, code: "BINARY_FILE" });

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
      expect(src).toContain("canopy-file://load");
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
    mockRead.mockResolvedValue({ ok: true, content: "line1\nline2\nline3" });

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
    mockRead.mockResolvedValue({ ok: false, code: "NOT_FOUND" });

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

    // Initially shows loading diff spinner (mode is "diff" but no diff content yet)
    await waitFor(() => {
      expect(screen.getByText("Loading diff...")).toBeTruthy();
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
      expect(screen.getByText("Loading diff...")).toBeTruthy();
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
});
