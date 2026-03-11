// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
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
  CodeViewer: () => <div data-testid="code-viewer" />,
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
});
