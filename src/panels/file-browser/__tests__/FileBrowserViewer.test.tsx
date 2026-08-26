// @vitest-environment jsdom
import { createContext, forwardRef, useContext, type ReactNode } from "react";
import { fireEvent, render, act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Type-only: erased before the vi.mock factory runs, so it cannot pull the real
// module in ahead of its own mock.
import type { MarkdownViewerProps } from "@/components/Markdown/MarkdownViewer";

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

// A real MarkdownViewer lazy-loads its renderer, hiding the props under test.
// The mock surfaces viewMode as a data attribute so the toggle wiring is
// observable — without it the mode plumbing could be deleted and stay green.
// cacheBust rides along for the same reason (#11587).
vi.mock("@/components/Markdown/MarkdownViewer", () => ({
  MarkdownViewer: (props: Pick<MarkdownViewerProps, "viewMode" | "cacheBust">) => (
    <div
      data-testid="markdown-viewer-mock"
      data-view-mode={props.viewMode}
      data-cache-bust={props.cacheBust ?? ""}
    />
  ),
}));
vi.mock("@/components/FileViewer/CodeViewer", () => ({
  CodeViewer: () => <div data-testid="code-viewer-mock" />,
}));
vi.mock("@/components/Html/HtmlViewer", () => ({
  HtmlViewer: () => <div data-testid="html-viewer-mock" />,
}));

// Surfaces the `active` prop instead of letting the real component apply its
// spin class. What this suite owns is the wiring — `isRefreshing` reaching the
// icon — while how a spin is rendered belongs to SpinningIcon's own suite; an
// assertion on its class name here would break on a harmless refactor there.
vi.mock("@/components/ui/SpinningIcon", () => ({
  SpinningIcon: ({ active }: { active: boolean }) => (
    <svg data-testid="spinning-icon-mock" data-active={String(active)} />
  ),
}));

// Radix's dropdown opens on a pointer sequence and portals its content, neither
// of which jsdom drives faithfully. Render the menu inline and let the radio
// items fire their own onValueChange — what this suite owns is the sort
// contract (which keys, and how re-picking flips direction), not Radix's
// open/close choreography. Mirrors the ReviewHub sort-menu suite.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children, asChild }: { children: ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <button type="button">{children}</button>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuRadioGroup: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode;
    value: string;
    onValueChange: (v: string) => void;
  }) => (
    <RadioGroupContext.Provider value={onValueChange}>
      <div data-value={value}>{children}</div>
    </RadioGroupContext.Provider>
  ),
  DropdownMenuRadioItem: ({ children, value }: { children: ReactNode; value: string }) => {
    const onValueChange = useContext(RadioGroupContext);
    return (
      <div role="menuitemradio" onClick={() => onValueChange?.(value)}>
        {children}
      </div>
    );
  },
}));

// Context, not a module-level stash: there are two radio groups now (key and
// direction), and a single shared handler would route every click to whichever
// group rendered last — passing the tests for the wrong reason.
const RadioGroupContext = createContext<((value: string) => void) | null>(null);

// The folder listing (#11620) virtualizes its rows, and a real Virtuoso renders
// none of them in jsdom, where every element measures zero. Render them all —
// what this suite owns is which body the viewer picks, not how it windows.
vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function VirtuosoStub<Row>(
    props: {
      data: Row[];
      context: unknown;
      itemContent: (index: number, row: Row, context: unknown) => ReactNode;
    },
    _ref: unknown
  ) {
    return (
      <div>
        {props.data.map((row, index) => (
          <div key={index}>{props.itemContent(index, row, props.context)}</div>
        ))}
      </div>
    );
  }),
}));

import { FileBrowserViewer } from "../FileBrowserViewer";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { GitStatus } from "@shared/types/git";
import type { WorkingTreeFileChange } from "@/lib/workingTreeDiff";
import type { FileBrowserSortOrder, FileEntryLike, FolderListingRow } from "../fileBrowserTree";
import type { FolderListingStatus } from "../useFileBrowserTree";

interface ViewerOpts {
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  revision?: string;
  surfaceRefreshNonce?: number;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  /**
   * Defaults to `null` — "no git status available" — because that is what a
   * workspace-rooted browser passes, and it keeps every pre-existing case in
   * this suite on the generic placeholder it was written against.
   */
  changedFiles?: readonly WorkingTreeFileChange[] | null;
  onSelectChangedFile?: (relativePath: string) => void;
  // Folder-selected state (#11620). Defaulted to "no folder" so every existing
  // file-preview case keeps exercising the file branch untouched.
  folderPath?: string | null;
  folderRows?: FolderListingRow[] | null;
  folderStatus?: FolderListingStatus;
  folderHasHiddenDotfiles?: boolean;
  onShowDotfiles?: () => void;
  onSelectEntry?: (path: string) => void;
  rowContextMenu?: (row: FileEntryLike) => React.ReactNode;
  sort?: FileBrowserSortOrder;
  onSortChange?: (sort: FileBrowserSortOrder) => void;
}

function change(relativePath: string, status: GitStatus = "modified"): WorkingTreeFileChange {
  return {
    path: `/repo/${relativePath}`,
    relativePath,
    status,
    insertions: null,
    deletions: null,
  };
}

// Defaults live here, never on the component: the props are required there so a
// pane that forgets to wire one fails typecheck rather than silently losing
// media refresh (#11586).
function viewerJsx(filePath: string | null, opts: ViewerOpts = {}) {
  const fileName = filePath ? (filePath.split("/").pop() ?? filePath) : "";
  return (
    <TooltipProvider>
      <FileBrowserViewer
        filePath={filePath}
        rootPath="/repo"
        fileName={fileName}
        relativePath={filePath ? fileName : null}
        revision={opts.revision ?? "r1"}
        surfaceRefreshNonce={opts.surfaceRefreshNonce ?? 0}
        onRefresh={opts.onRefresh ?? vi.fn()}
        isRefreshing={opts.isRefreshing ?? false}
        sidebarCollapsed={opts.sidebarCollapsed ?? false}
        onToggleSidebar={opts.onToggleSidebar ?? vi.fn()}
        treeSidebarId="file-tree-column"
        changedFiles={opts.changedFiles ?? null}
        onSelectChangedFile={opts.onSelectChangedFile ?? vi.fn()}
        folderPath={opts.folderPath ?? null}
        folderRows={opts.folderRows ?? null}
        folderStatus={opts.folderStatus ?? "ready"}
        folderHasHiddenDotfiles={opts.folderHasHiddenDotfiles ?? false}
        onShowDotfiles={opts.onShowDotfiles ?? vi.fn()}
        onSelectEntry={opts.onSelectEntry ?? vi.fn()}
        {...(opts.rowContextMenu ? { rowContextMenu: opts.rowContextMenu } : {})}
        basePath="/repo"
        sort={opts.sort ?? { key: "name", direction: "asc" }}
        onSortChange={opts.onSortChange ?? vi.fn()}
      />
    </TooltipProvider>
  );
}

function renderViewer(filePath: string | null, opts: ViewerOpts = {}) {
  return render(viewerJsx(filePath, opts));
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

function currentCacheBust(): string | null {
  return screen.getByTestId("markdown-viewer-mock").getAttribute("data-cache-bust");
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
    rerender(viewerJsx("/repo/docs/b.md"));
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

    rerender(viewerJsx("/repo/src/notes.txt"));
    await screen.findByTestId("code-viewer-mock");
    expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rendered" })).toBeNull();
    expect(screen.queryByTestId("markdown-viewer-mock")).toBeNull();
  });
});

describe("FileBrowserViewer rendered-markdown image freshness (#11587)", () => {
  it("hands the refresh revision to the rendered document as its cache token", async () => {
    // Embedded images resolve to daintree-file:// URLs built from path + root, so
    // a rewritten image is invisible unless something in the URL moves. This is
    // the same freshness choice the image branch already makes with ZoomableImage.
    const { rerender } = renderViewer("/repo/docs/spec.md", { revision: "r1" });
    await waitFor(() => expect(currentViewMode()).toBe("rendered"));
    expect(currentCacheBust()).toBe("r1");

    rerender(viewerJsx("/repo/docs/spec.md", { revision: "r2" }));
    await waitFor(() => expect(currentCacheBust()).toBe("r2"));
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

    rerender(viewerJsx("/repo/src/notes.txt"));
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

    rerender(viewerJsx(null, { sidebarCollapsed: true }));
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

  it("refetches on an explicit refresh but rides out an ambient revision tick (#11586)", async () => {
    // Both directions in one test: the ambient half must not disturb playback,
    // and the explicit half must not be swallowed along with it. Unique object
    // URLs so a silent remount can't pass as continuity.
    let objectUrlSequence = 0;
    URL.createObjectURL = vi.fn(() => `blob:app://daintree/video-${objectUrlSequence++}`);

    const { container, rerender } = renderViewer("/repo/media/demo.webm", {
      revision: "r1",
      surfaceRefreshNonce: 0,
    });
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    const firstNode = container.querySelector("video");
    const firstSrc = firstNode?.getAttribute("src");
    expect(videoFetchMock).toHaveBeenCalledTimes(1);

    // A worktree write elsewhere: the player must be left completely alone.
    rerender(viewerJsx("/repo/media/demo.webm", { revision: "r2", surfaceRefreshNonce: 0 }));
    await act(async () => {});
    expect(container.querySelector("video")).toBe(firstNode);
    expect(container.querySelector("video")?.getAttribute("src")).toBe(firstSrc);
    expect(videoFetchMock).toHaveBeenCalledTimes(1);

    // Refresh pressed: exactly one more request, aimed at a different URL —
    // proof the nonce reached it, without pinning the leaf's `v=` spelling.
    rerender(viewerJsx("/repo/media/demo.webm", { revision: "r2", surfaceRefreshNonce: 1 }));
    await waitFor(() => expect(videoFetchMock).toHaveBeenCalledTimes(2));
    expect(String(videoFetchMock.mock.calls[1]?.[0])).not.toBe(
      String(videoFetchMock.mock.calls[0]?.[0])
    );
    // Both halves in ONE waitFor: the hook nulls its object URL while refetching,
    // so a bare `.not.toBe(firstSrc)` would go green on the empty gap and never
    // prove the replacement player arrived.
    await waitFor(() => {
      const refreshed = container.querySelector("video");
      expect(refreshed).not.toBeNull();
      expect(refreshed?.getAttribute("src")).not.toBe(firstSrc);
    });
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

    rerender(viewerJsx("/repo/media/track.mp3", { revision: "r2" }));
    await act(async () => {});

    // The very same element, still on its original blob — not a fresh one that
    // happens to look alike.
    expect(container.querySelector("audio")).toBe(firstNode);
    expect(container.querySelector("audio")?.getAttribute("src")).toBe(firstSrc);
    expect(audioFetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches the track when an explicit refresh moves the nonce (#11586)", async () => {
    // The other half of the test above: the ambient tick is ignored, but
    // pressing Refresh is the one gesture that must pull rewritten bytes.
    let objectUrlSequence = 0;
    URL.createObjectURL = vi.fn(() => `blob:app://daintree/audio-${objectUrlSequence++}`);

    const { container, rerender } = renderViewer("/repo/media/track.mp3", {
      surfaceRefreshNonce: 0,
    });
    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
    const firstNode = container.querySelector("audio");
    const firstSrc = firstNode?.getAttribute("src");
    expect(audioFetchMock).toHaveBeenCalledTimes(1);

    rerender(viewerJsx("/repo/media/track.mp3", { surfaceRefreshNonce: 1 }));
    await waitFor(() => expect(audioFetchMock).toHaveBeenCalledTimes(2));

    // A different URL, so the nonce genuinely reached the request rather than
    // the blob being re-rendered from cache.
    expect(String(audioFetchMock.mock.calls[1]?.[0])).not.toBe(
      String(audioFetchMock.mock.calls[0]?.[0])
    );
    // One waitFor for the whole claim: the hook nulls its object URL while
    // refetching, so asserting the src alone would pass on the empty gap
    // between the two players.
    await waitFor(() => {
      const refreshed = container.querySelector("audio");
      expect(refreshed).not.toBeNull();
      expect(refreshed?.getAttribute("src")).not.toBe(firstSrc);
      // Keyed by object URL, so fresh bytes mean a fresh element.
      expect(refreshed).not.toBe(firstNode);
    });
  });

  it("recovers a failed track on refresh, which takes both halves of the signal", async () => {
    // A failed fetch unmounts the preview entirely (`status: "error"`), so
    // `reloadKey` alone can't bring it back — nothing is mounted to receive it.
    // Recovery rides `revision`, whose re-run reclassifies the file and
    // remounts the player. That is why the nonce must stay folded into
    // `revision` as well as being passed separately.
    let objectUrlSequence = 0;
    URL.createObjectURL = vi.fn(() => `blob:app://daintree/audio-retry-${objectUrlSequence++}`);
    audioFetchMock.mockRejectedValueOnce(new Error("protocol unavailable"));

    const { container, rerender } = renderViewer("/repo/media/track.mp3", {
      revision: "0:0",
      surfaceRefreshNonce: 0,
    });
    await screen.findByText("This audio file couldn't be played");
    expect(container.querySelector("audio")).toBeNull();

    // Exactly what the pane emits for one Refresh press: both values move.
    rerender(viewerJsx("/repo/media/track.mp3", { revision: "0:1", surfaceRefreshNonce: 1 }));

    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
    expect(screen.queryByText("This audio file couldn't be played")).toBeNull();
    expect(audioFetchMock).toHaveBeenCalledTimes(2);
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

  it("re-navigates only on an explicit refresh, never on a revision tick (#11586)", async () => {
    const { container, rerender } = renderViewer("/repo/docs/spec.pdf", {
      revision: "r1",
      surfaceRefreshNonce: 0,
    });
    await act(async () => {});
    const firstFrame = container.querySelector("iframe");
    const firstSrc = firstFrame?.getAttribute("src");

    // An ambient write must not throw away the reader's page and zoom. Both a
    // changed src AND a remounted frame would do that, so pin the node too —
    // a remount carrying an identical src resets the reader just the same.
    rerender(viewerJsx("/repo/docs/spec.pdf", { revision: "r2", surfaceRefreshNonce: 0 }));
    await act(async () => {});
    expect(container.querySelector("iframe")).toBe(firstFrame);
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(firstSrc);

    rerender(viewerJsx("/repo/docs/spec.pdf", { revision: "r2", surfaceRefreshNonce: 1 }));
    await act(async () => {});
    const refreshed = container.querySelector("iframe");
    // Re-navigated in place rather than remounted: the same element takes a new
    // src, which is what makes the reload deliberate instead of incidental.
    expect(refreshed).toBe(firstFrame);
    expect(refreshed?.getAttribute("src")).not.toBe(firstSrc);
    // The reload rides the same frame, so the COEP contract must survive it.
    expect(refreshed?.hasAttribute("credentialless")).toBe(true);
    expect(refreshed?.hasAttribute("sandbox")).toBe(false);
  });
});

describe("FileBrowserViewer Refresh control (#11586, #11938)", () => {
  it("leaves Refresh to the tree header while the tree column is mounted and nothing is open", () => {
    renderViewer(null, { sidebarCollapsed: false });
    // Two identical Refresh buttons in one panel would read as two different
    // actions; with no file on screen the tree header owns the only one.
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  });

  it("leaves Refresh to the tree header while the tree column is mounted and a file is open", async () => {
    // Opening a file used to move Refresh into this toolbar. It doesn't any
    // more, and this is the only place that can be checked from the viewer's
    // own side: the case above would still pass if the `filePath` half of the
    // old gate came back, since it renders nothing at all.
    renderViewer("/repo/src/notes.txt", { sidebarCollapsed: false });
    await screen.findByTestId("code-viewer-mock");

    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    // The group doesn't go empty in exchange — the file keeps its own actions.
    expect(screen.getByRole("button", { name: "Open in editor" })).toBeTruthy();
  });

  it("offers Refresh once the tree column is collapsed away, even with nothing selected", async () => {
    const onRefresh = vi.fn();
    renderViewer(null, { sidebarCollapsed: true, onRefresh });

    // Nothing selected still needs it: Refresh re-reads the tree too, and a
    // workspace root has only the polled reconcile to fall back on (#11590).
    expect(screen.getByText("Nothing selected")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Refresh" });
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("offers Refresh over a folder listing once the tree is collapsed away", async () => {
    // The third selection state. Refresh re-reads the browser whatever the
    // viewer happens to be showing, so a listing must not be the one surface
    // that loses it — the sort menu beside it orders rows, it can't re-read.
    const onRefresh = vi.fn();
    renderViewer(null, {
      sidebarCollapsed: true,
      folderPath: "src",
      folderRows: [],
      folderStatus: "ready",
      onRefresh,
    });

    const button = screen.getByRole("button", { name: "Refresh" });
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("hands the in-flight refresh state to the icon", () => {
    const { rerender } = renderViewer(null, { sidebarCollapsed: true, isRefreshing: false });
    expect(screen.getByTestId("spinning-icon-mock").getAttribute("data-active")).toBe("false");

    rerender(viewerJsx(null, { sidebarCollapsed: true, isRefreshing: true }));
    expect(screen.getByTestId("spinning-icon-mock").getAttribute("data-active")).toBe("true");
  });

  it("keeps re-reading text on an ambient revision tick", async () => {
    // The half that already worked: `revision` must keep its job, or fixing the
    // media path would quietly cost text its live updates.
    const { rerender } = renderViewer("/repo/src/notes.txt", { revision: "r1" });
    await screen.findByTestId("code-viewer-mock");
    expect(readMock).toHaveBeenCalledTimes(1);

    rerender(viewerJsx("/repo/src/notes.txt", { revision: "r2" }));
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(2));
  });

  it("re-reads text on an explicit refresh too, not just an ambient tick", async () => {
    // Guards the other direction of the pane's dual handoff: the nonce is fed
    // to the media previews directly AND folded into `revision`. Drop the
    // second and text, html and svg go stale on Refresh with nothing to catch
    // it — the media tests above would all still pass.
    const { rerender } = renderViewer("/repo/src/notes.txt", {
      revision: "0:0",
      surfaceRefreshNonce: 0,
    });
    await screen.findByTestId("code-viewer-mock");
    expect(readMock).toHaveBeenCalledTimes(1);

    // What the pane produces for a Refresh press on a worktree with no tick.
    rerender(viewerJsx("/repo/src/notes.txt", { revision: "0:1", surfaceRefreshNonce: 1 }));
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(2));
  });
});

// With nothing selected the pane answers "what did the agent just change in
// here" (#11614). The three states are distinct on purpose: no git status at
// all, a snapshot saying clean, and a snapshot with changes.
describe("FileBrowserViewer idle body", () => {
  it("summarises the changed files instead of a placeholder", () => {
    renderViewer(null, {
      changedFiles: [change("src/app.ts"), change("docs/notes.md", "added")],
    });

    expect(screen.getByRole("button", { name: /Read src\/app\.ts/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Read docs\/notes\.md/ })).toBeTruthy();
    expect(screen.queryByText("Nothing selected")).toBeNull();
  });

  it("opens a summarised file through the pane's selection callback", () => {
    const onSelectChangedFile = vi.fn();
    renderViewer(null, { changedFiles: [change("src/app.ts")], onSelectChangedFile });

    screen.getByRole("button", { name: /Read src\/app\.ts/ }).click();

    expect(onSelectChangedFile).toHaveBeenCalledWith("src/app.ts");
  });

  it("says the worktree is clean when the snapshot reports no changes", () => {
    renderViewer(null, { changedFiles: [] });

    expect(screen.getByText("Worktree is clean")).toBeTruthy();
    expect(screen.queryByText("Nothing selected")).toBeNull();
  });

  it("keeps the generic placeholder when no git status is available", () => {
    // A workspace-rooted browser has no worktree behind it, and a worktree whose
    // snapshot hasn't arrived is equally unknown. Neither may claim "clean".
    renderViewer(null, { changedFiles: null });

    expect(screen.getByText("Nothing selected")).toBeTruthy();
    expect(screen.queryByText("Worktree is clean")).toBeNull();
  });

  it("shows the selected file rather than the summary once one is picked", async () => {
    readMock.mockResolvedValue({ content: "hello" });
    renderViewer("/repo/src/app.ts", { changedFiles: [change("src/app.ts")] });

    await screen.findByTestId("code-viewer-mock");

    expect(screen.queryByRole("button", { name: /Read src\/app\.ts/ })).toBeNull();
  });
});

describe("folder-selected state (#11620)", () => {
  const FOLDER_ROWS: FolderListingRow[] = [
    { path: "src/pkg", name: "pkg", isDirectory: true, itemCount: 2 },
    { path: "src/a.ts", name: "a.ts", isDirectory: false, size: 100, mtimeMs: 1_700_000_000_000 },
  ];

  it("lists a selected folder's contents instead of the nothing-selected state", () => {
    renderViewer(null, { folderPath: "src", folderRows: FOLDER_ROWS });
    expect(screen.queryByText("Nothing selected")).toBeNull();
    expect(screen.getByLabelText("pkg")).toBeTruthy();
    expect(screen.getByLabelText("a.ts")).toBeTruthy();
  });

  it("still shows the nothing-selected state when neither a file nor a folder is selected", () => {
    renderViewer(null);
    expect(screen.getByText("Nothing selected")).toBeTruthy();
  });

  it("prefers the file preview when a file is selected", () => {
    // The two are mutually exclusive by construction; if both ever arrived, the
    // file must win rather than the viewer rendering two bodies.
    renderViewer("/repo/a.ts", { folderPath: "src", folderRows: FOLDER_ROWS });
    expect(screen.queryByLabelText("pkg")).toBeNull();
  });

  it("does not render the empty state while the listing is still pending", () => {
    // The #10083 trap: branching on a Doherty-gated flag would paint "This
    // folder is empty" for the first 400ms of every folder load.
    renderViewer(null, { folderPath: "src", folderRows: null, folderStatus: "pending" });
    expect(screen.queryByText("Nothing in this folder yet")).toBeNull();
    expect(screen.queryByText("Nothing selected")).toBeNull();
  });

  it("shows the empty state for a folder that really holds nothing", () => {
    renderViewer(null, { folderPath: "src", folderRows: [], folderStatus: "ready" });
    expect(screen.getByText("Nothing in this folder yet")).toBeTruthy();
  });

  it("offers Show dotfiles only when unhiding them would reveal something", () => {
    renderViewer(null, {
      folderPath: "src",
      folderRows: [],
      folderStatus: "ready",
      folderHasHiddenDotfiles: true,
    });
    expect(screen.getByText("Dotfiles are hidden here")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show dotfiles" })).toBeTruthy();
  });

  it("does not offer Show dotfiles when the folder is genuinely empty", () => {
    renderViewer(null, {
      folderPath: "src",
      folderRows: [],
      folderStatus: "ready",
      folderHasHiddenDotfiles: false,
    });
    expect(screen.queryByRole("button", { name: "Show dotfiles" })).toBeNull();
  });

  it("runs the dotfile recovery from the filtered-empty state", async () => {
    const onShowDotfiles = vi.fn();
    renderViewer(null, {
      folderPath: "src",
      folderRows: [],
      folderStatus: "ready",
      folderHasHiddenDotfiles: true,
      onShowDotfiles,
    });
    fireEvent.click(screen.getByRole("button", { name: "Show dotfiles" }));
    expect(onShowDotfiles).toHaveBeenCalled();
  });

  it("surfaces a readable error with a retry when the folder can't be read", () => {
    renderViewer(null, { folderPath: "src", folderRows: null, folderStatus: "error" });
    expect(screen.getByText("Can't show this folder")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("retries through the pane's refresh", async () => {
    const onRefresh = vi.fn();
    renderViewer(null, {
      folderPath: "src",
      folderRows: null,
      folderStatus: "error",
      onRefresh,
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRefresh).toHaveBeenCalled();
  });
});

describe("sort menu (#11620)", () => {
  it("stays available with no selection, since it also orders the tree", () => {
    renderViewer(null);
    expect(screen.getByTestId("file-browser-sort-menu")).toBeTruthy();
  });

  it("stays available for a selected folder, whose listing it orders", () => {
    renderViewer(null, { folderPath: "src", folderRows: [], folderStatus: "ready" });
    expect(screen.getByRole("button", { name: /^Sort files \(/ })).toBeTruthy();
    // No Refresh crowding it: the mounted tree header still owns that one.
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  });

  it("gives its slot up once a file is open, having nothing left to order", async () => {
    // A single document has no order, so the control that describes one would
    // be describing the tree it can no longer be reached from. Reveal and Open
    // in editor take the room; Refresh stays in the mounted tree header.
    renderViewer("/repo/src/notes.txt");
    await screen.findByTestId("code-viewer-mock");
    expect(screen.queryByRole("button", { name: /^Sort files \(/ })).toBeNull();
  });

  it("names the current key and direction so the arrow icon isn't the only cue", () => {
    // The arrow is aria-hidden, so the accessible name is the only place a
    // screen reader can learn which way the list runs.
    renderViewer(null, { sort: { key: "size", direction: "desc" } });
    expect(screen.getByRole("button", { name: "Sort files (Size, descending)" })).toBeTruthy();
  });

  it("changes the key without disturbing the direction", () => {
    const onSortChange = vi.fn();
    renderViewer(null, { sort: { key: "name", direction: "desc" }, onSortChange });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Size" }));
    expect(onSortChange).toHaveBeenCalledWith({ key: "size", direction: "desc" });
  });

  it("changes the direction without disturbing the key", () => {
    const onSortChange = vi.fn();
    renderViewer(null, { sort: { key: "modified", direction: "asc" }, onSortChange });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Descending" }));
    expect(onSortChange).toHaveBeenCalledWith({ key: "modified", direction: "desc" });
  });

  it("can set a direction outright rather than only reversing the current one", () => {
    // The reason this is a radio group and not a re-pick-to-flip gesture:
    // choosing the direction already in effect is a no-op the user can rely on,
    // not a silent reversal.
    const onSortChange = vi.fn();
    renderViewer(null, { sort: { key: "name", direction: "asc" }, onSortChange });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Ascending" }));
    expect(onSortChange).toHaveBeenCalledWith({ key: "name", direction: "asc" });
  });

  it("offers the four documented keys and both directions", () => {
    renderViewer(null);
    const names = screen.getAllByRole("menuitemradio").map((i) => i.textContent?.trim());
    expect(names).toEqual(["Name", "Modified", "Size", "Type", "Ascending", "Descending"]);
  });
});
