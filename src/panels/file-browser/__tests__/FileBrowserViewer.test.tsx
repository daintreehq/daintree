// @vitest-environment jsdom
import { render, act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FileBrowserViewer is the read-only preview beside the tree. #11319 adds a
// Source/Rendered toggle for markdown, mirroring FilePane. Mock the heavy leaf
// viewers so only FileBrowserViewer's own toolbar + mode wiring renders, and
// capture the viewMode handed to MarkdownViewer — the seam the toggle drives.
const { readMock } = vi.hoisted(() => ({ readMock: vi.fn() }));
vi.mock("@/clients/filesClient", () => ({
  filesClient: { read: readMock },
}));

// dispatch() resolves an ActionDispatchResult union and never rejects; the
// toolbar's external-action handlers branch on `.ok`, so honour that shape.
const { dispatchMock } = vi.hoisted(() => ({ dispatchMock: vi.fn() }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

// A real MarkdownViewer lazy-loads its renderer, hiding the prop under test.
// The mock surfaces viewMode as a data attribute so the toggle wiring is
// observable — without it the mode plumbing could be deleted and stay green.
vi.mock("@/components/Markdown/MarkdownViewer", () => ({
  MarkdownViewer: (props: { viewMode: string }) => (
    <div data-testid="markdown-viewer-mock" data-view-mode={props.viewMode} />
  ),
}));
vi.mock("@/components/FileViewer/CodeViewer", () => ({
  CodeViewer: () => <div data-testid="code-viewer-mock" />,
}));
vi.mock("@/components/Html/HtmlViewer", () => ({
  HtmlViewer: () => <div data-testid="html-viewer-mock" />,
}));

import { FileBrowserViewer } from "../FileBrowserViewer";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderViewer(
  filePath: string | null,
  opts: { sidebarCollapsed?: boolean; onToggleSidebar?: () => void; revision?: string } = {}
) {
  const fileName = filePath ? (filePath.split("/").pop() ?? filePath) : "";
  return render(
    <TooltipProvider>
      <FileBrowserViewer
        filePath={filePath}
        rootPath="/repo"
        fileName={fileName}
        relativePath={filePath ? fileName : null}
        revision={opts.revision ?? "r1"}
        sidebarCollapsed={opts.sidebarCollapsed ?? false}
        onToggleSidebar={opts.onToggleSidebar ?? vi.fn()}
        treeSidebarId="file-tree-column"
      />
    </TooltipProvider>
  );
}

// SegmentedToggle renders literal-text buttons; its accessible name is the
// visible label, so click by role + name.
async function clickMode(label: "Source" | "Rendered") {
  const button = await screen.findByRole("button", { name: label });
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function currentViewMode(): string | null {
  return screen.getByTestId("markdown-viewer-mock").getAttribute("data-view-mode");
}

beforeEach(() => {
  readMock.mockReset();
  readMock.mockResolvedValue({ content: "# hello" });
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({ ok: true, result: undefined });
  // SegmentedToggle's motion hook (and InlineStatusBanner) read matchMedia at
  // render time; jsdom does not implement it, so provide a no-op stub.
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

describe("FileBrowserViewer markdown Source/Rendered toggle (#11319)", () => {
  it("shows the toggle and defaults to the rendered view for a markdown file", async () => {
    renderViewer("/repo/docs/spec.md");
    // Default preserves the pane's long-standing rendered-first behaviour.
    await waitFor(() => expect(currentViewMode()).toBe("rendered"));
    expect(screen.getByRole("button", { name: "Source" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rendered" })).toBeTruthy();
  });

  it("switches the markdown viewer between source and rendered", async () => {
    renderViewer("/repo/docs/spec.md");
    await waitFor(() => expect(currentViewMode()).toBe("rendered"));
    await clickMode("Source");
    await waitFor(() => expect(currentViewMode()).toBe("source"));
    // Round-trip so the "rendered" segment's mapping is exercised too, not just
    // the "source" one.
    await clickMode("Rendered");
    await waitFor(() => expect(currentViewMode()).toBe("rendered"));
  });

  it("keeps the chosen mode sticky across a different markdown file", async () => {
    const { rerender } = renderViewer("/repo/docs/a.md");
    await waitFor(() => expect(currentViewMode()).toBe("rendered"));
    await clickMode("Source");
    await waitFor(() => expect(currentViewMode()).toBe("source"));

    // Selecting another markdown file in the tree must not silently revert the
    // reader's choice back to rendered — the mode is sticky, mirroring FilePane.
    rerender(
      <TooltipProvider>
        <FileBrowserViewer
          filePath="/repo/docs/b.md"
          rootPath="/repo"
          fileName="b.md"
          relativePath="b.md"
          revision="r1"
          sidebarCollapsed={false}
          onToggleSidebar={vi.fn()}
          treeSidebarId="file-tree-column"
        />
      </TooltipProvider>
    );
    await waitFor(() => expect(currentViewMode()).toBe("source"));
  });

  it("drops the toggle and its stale source choice when switching to a non-markdown file", async () => {
    // Start on markdown in Source, then navigate to a .txt in the same viewer —
    // the tree's real usage. Proves the markdown-only toggle disappears and the
    // sticky "source" choice can't leak into the CodeViewer (non-markdown) branch.
    const { rerender } = renderViewer("/repo/docs/a.md");
    await waitFor(() => expect(currentViewMode()).toBe("rendered"));
    await clickMode("Source");
    await waitFor(() => expect(currentViewMode()).toBe("source"));

    rerender(
      <TooltipProvider>
        <FileBrowserViewer
          filePath="/repo/src/notes.txt"
          rootPath="/repo"
          fileName="notes.txt"
          relativePath="notes.txt"
          revision="r1"
          sidebarCollapsed={false}
          onToggleSidebar={vi.fn()}
          treeSidebarId="file-tree-column"
        />
      </TooltipProvider>
    );
    await screen.findByTestId("code-viewer-mock");
    expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rendered" })).toBeNull();
    expect(screen.queryByTestId("markdown-viewer-mock")).toBeNull();
  });
});

describe("FileBrowserViewer tree-sidebar toggle (#11328)", () => {
  it("renders the toggle even with nothing selected, so the collapsed sidebar has a home", () => {
    renderViewer(null);
    // The empty state has no toolbar of its own; the persistent Root is what
    // keeps a re-open control on screen once the tree is collapsed.
    expect(screen.getByTestId("file-browser-sidebar-toggle")).toBeTruthy();
    expect(screen.getByText("Nothing selected")).toBeTruthy();
  });

  it("is the first control in the toolbar in both the empty and file-selected states", async () => {
    const { rerender } = renderViewer(null);
    // `?.` keeps the assertion honest under noUncheckedIndexedAccess: an empty
    // button list yields undefined, which still fails the toBe below.
    const firstEmpty = screen.getAllByRole("button")[0];
    expect(firstEmpty?.getAttribute("data-testid")).toBe("file-browser-sidebar-toggle");

    rerender(
      <TooltipProvider>
        <FileBrowserViewer
          filePath="/repo/src/notes.txt"
          rootPath="/repo"
          fileName="notes.txt"
          relativePath="notes.txt"
          revision="r1"
          sidebarCollapsed={false}
          onToggleSidebar={vi.fn()}
          treeSidebarId="file-tree-column"
        />
      </TooltipProvider>
    );
    await screen.findByTestId("code-viewer-mock");
    // Still first, ahead of the reveal/open-in-editor actions — the toggle
    // stays flush at the far left of the header per the issue.
    const firstWithFile = screen.getAllByRole("button")[0];
    expect(firstWithFile?.getAttribute("data-testid")).toBe("file-browser-sidebar-toggle");
  });

  it("exposes an inverse aria-expanded and names the tree region only while expanded", () => {
    const { rerender } = renderViewer(null, { sidebarCollapsed: false });
    const expanded = screen.getByTestId("file-browser-sidebar-toggle");
    // Disclosure semantics (aria-expanded), not a pressed toggle.
    expect(expanded.getAttribute("aria-expanded")).toBe("true");
    expect(expanded.getAttribute("aria-pressed")).toBeNull();
    expect(expanded.getAttribute("aria-controls")).toBe("file-tree-column");

    rerender(
      <TooltipProvider>
        <FileBrowserViewer
          filePath={null}
          rootPath="/repo"
          fileName=""
          relativePath={null}
          revision="r1"
          sidebarCollapsed={true}
          onToggleSidebar={vi.fn()}
          treeSidebarId="file-tree-column"
        />
      </TooltipProvider>
    );
    const collapsed = screen.getByTestId("file-browser-sidebar-toggle");
    expect(collapsed.getAttribute("aria-expanded")).toBe("false");
    // The tree column is unmounted while collapsed, so aria-controls must not
    // dangle at a missing id.
    expect(collapsed.getAttribute("aria-controls")).toBeNull();
  });

  it("invokes onToggleSidebar when clicked", async () => {
    const onToggleSidebar = vi.fn();
    renderViewer(null, { onToggleSidebar });
    const toggle = screen.getByTestId("file-browser-sidebar-toggle");
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });
});

describe("FileBrowserViewer video preview (#11382)", () => {
  // FileVideoPreview fetch()es the bytes and plays a blob object URL —
  // Chromium's custom-scheme media loader can't do follow-up range requests
  // (electron#51442) — so the suite stubs the fetch/object-URL boundary.
  const videoFetchMock = vi.fn();
  beforeEach(() => {
    videoFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: () => Promise.resolve(new Blob(["x"])),
    });
    vi.stubGlobal("fetch", videoFetchMock);
    URL.createObjectURL = vi.fn(() => "blob:app://daintree/video-preview");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    videoFetchMock.mockReset();
  });

  it("renders a <video> for a playable container without reading the file as text", async () => {
    const { container } = renderViewer("/repo/media/demo.webm");

    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    // The bytes come from the protocol handler via fetch; the text-read IPC
    // path (whose 500 KB cap produced the misleading error) must never run.
    expect(String(videoFetchMock.mock.calls[0]?.[0])).toContain("daintree-file://");
    expect(container.querySelector("video")?.getAttribute("src")).toMatch(/^blob:/);
    expect(readMock).not.toHaveBeenCalled();
  });

  it("shows a format message for a container Chromium can't demux, not the size cap", async () => {
    const { container } = renderViewer("/repo/media/demo.mkv");
    await act(async () => {});

    expect(container.querySelector("video")).toBeNull();
    expect(readMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Can't play this video format/)).toBeTruthy();
  });
});

describe("FileBrowserViewer audio preview (#11425)", () => {
  // Same fetch/object-URL boundary as the video suite above.
  const audioFetchMock = vi.fn();
  beforeEach(() => {
    audioFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: () => Promise.resolve(new Blob(["x"])),
    });
    vi.stubGlobal("fetch", audioFetchMock);
    URL.createObjectURL = vi.fn(() => "blob:app://daintree/audio-preview");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    audioFetchMock.mockReset();
  });

  it("renders an <audio> for a playable format without reading the file as text", async () => {
    const { container } = renderViewer("/repo/media/track.flac");

    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
    expect(String(audioFetchMock.mock.calls[0]?.[0])).toContain("daintree-file://");
    expect(container.querySelector("audio")?.getAttribute("src")).toMatch(/^blob:/);
    expect(readMock).not.toHaveBeenCalled();
  });

  it("shows a format message for audio Chromium can't decode, not the binary error", async () => {
    const { container } = renderViewer("/repo/media/track.mid");
    await act(async () => {});

    expect(container.querySelector("audio")).toBeNull();
    expect(readMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Can't play this audio format/)).toBeTruthy();
  });

  it("keeps the same player across a revision tick rather than refetching", async () => {
    // `revision` bumps on every worktree write; keying the player on it would
    // restart the track whenever an agent touches an unrelated file. Object
    // URLs are unique here so a remount can't masquerade as continuity.
    let objectUrlSequence = 0;
    URL.createObjectURL = vi.fn(() => `blob:app://daintree/audio-${objectUrlSequence++}`);

    const { container, rerender } = renderViewer("/repo/media/track.mp3", { revision: "r1" });
    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
    const firstNode = container.querySelector("audio");
    const firstSrc = firstNode?.getAttribute("src");
    expect(audioFetchMock).toHaveBeenCalledTimes(1);

    rerender(
      <TooltipProvider>
        <FileBrowserViewer
          filePath="/repo/media/track.mp3"
          rootPath="/repo"
          fileName="track.mp3"
          relativePath="track.mp3"
          revision="r2"
          sidebarCollapsed={false}
          onToggleSidebar={vi.fn()}
          treeSidebarId="file-tree-column"
        />
      </TooltipProvider>
    );
    await act(async () => {});

    // The very same element, still on its original blob — not a fresh one that
    // happens to look alike.
    expect(container.querySelector("audio")).toBe(firstNode);
    expect(container.querySelector("audio")?.getAttribute("src")).toBe(firstSrc);
    expect(audioFetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("FileBrowserViewer PDF preview (#11427)", () => {
  it("frames the PDF scheme without reading the file as text", async () => {
    const { container } = renderViewer("/repo/docs/spec.pdf");
    await act(async () => {});

    const src = new URL(container.querySelector("iframe")?.getAttribute("src") ?? "");
    expect(src.protocol).toBe("daintree-pdf:");
    expect(src.searchParams.get("path")).toBe("/repo/docs/spec.pdf");
    expect(src.searchParams.get("root")).toBe("/repo");
    // The text-read IPC path is what produced "Binary file — cannot display".
    expect(readMock).not.toHaveBeenCalled();
  });

  it("mounts the frame credentialless and unsandboxed", async () => {
    const { container } = renderViewer("/repo/docs/spec.pdf");
    await act(async () => {});

    const frame = container.querySelector("iframe");
    // Without credentialless the COEP shell blocks the document; with a sandbox
    // attribute PDFium refuses to install its viewer frame.
    expect(frame?.hasAttribute("credentialless")).toBe(true);
    expect(frame?.hasAttribute("sandbox")).toBe(false);
  });
});
