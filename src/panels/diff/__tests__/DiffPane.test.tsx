// @vitest-environment jsdom
import type { ReactNode } from "react";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitStatus } from "@shared/types/git";
import type { DiffChangeSetEntry } from "@shared/types/git";

// Cross-file stepping, the workspace sidebar and the viewed markers moved off
// the opening surfaces (FileChangeList, the Review Hub) and onto the panel
// itself. These tests target that logic only, so the diff renderer, the
// sidebar and the content fetch are all stubbed out.

// A fragment, so the toolbar stays a sibling of the keydown host rather than
// wrapping it — the stepping shortcuts bubble through the same subtree as before.
vi.mock("@/components/Panel/ContentPanel", () => ({
  ContentPanel: (props: { toolbar?: ReactNode; children?: ReactNode }) => (
    <>
      {props.toolbar}
      {props.children}
    </>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/Worktree/DiffViewer", () => ({
  // Surfaces `wrapLines` so the auto/override resolution is observable from the
  // prop the viewer actually receives, not just from the toolbar's pressed state.
  DiffViewer: (props: { wrapLines?: boolean }) => (
    <div data-testid="diff-viewer-mock" data-wrap-lines={String(props.wrapLines)} />
  ),
  FULL_FILE_MAX_LINES: 5000,
}));

// Controllable so a test can put the pane in image mode; `beforeEach` returns it
// to text mode, which is what every other test in this file assumes.
const { isImageDiffCandidateMock } = vi.hoisted(() => ({
  isImageDiffCandidateMock:
    vi.fn<typeof import("@/components/FileViewer/ImageDiffViewer").isImageDiffCandidate>(),
}));
vi.mock("@/components/FileViewer/ImageDiffViewer", () => ({
  ImageDiffViewer: () => <div data-testid="image-diff-mock" />,
  isImageDiffCandidate: isImageDiffCandidateMock,
}));
vi.mock("@/components/ui/EmptyState", () => ({
  EmptyState: (props: { title: string; description?: string }) => (
    <div
      data-testid="empty-state-mock"
      data-title={props.title}
      data-description={props.description}
    />
  ),
}));

// Exposes the resolved index so the identity resolution is observable from the
// sidebar as well as from the footer position indicator.
const sidebarSelect = vi.fn<(index: number) => void>();
vi.mock("@/components/FileViewer/DiffFileSidebar", () => ({
  DiffFileSidebar: (props: { files: DiffChangeSetEntry[]; currentIndex: number }) => (
    <div
      data-testid="diff-sidebar-mock"
      data-current-index={props.currentIndex}
      data-file-count={props.files.length}
    />
  ),
}));

const { setDiffPanelFileMock, toggleViewedMock, useDiffContentMock } = vi.hoisted(() => ({
  setDiffPanelFileMock:
    vi.fn<(id: string, path: string, status: GitStatus, viewedKey?: string) => void>(),
  toggleViewedMock: vi.fn(),
  useDiffContentMock: vi.fn(),
}));

// Mutable so a test can repoint the panel (or shrink its change set) between
// renders without re-declaring the mock.
const panelsById: Record<string, unknown> = {};

vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (state: unknown) => unknown) =>
    selector({ panelsById, setDiffPanelFile: setDiffPanelFileMock }),
}));

const worktrees = new Map<string, { path: string; branch: string }>();
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (state: unknown) => unknown) => selector({ worktrees }),
}));

const preferences = {
  diffViewType: "unified" as const,
  setDiffViewType: vi.fn(),
  // `null` is auto — prose wraps, everything else doesn't (#12170).
  diffWrapLines: null as boolean | null,
  // Writes through, so a test can follow a full toggle cycle instead of only
  // the argument the click dispatched.
  setDiffWrapLines: vi.fn((value: boolean) => {
    preferences.diffWrapLines = value;
  }),
  diffShowFileList: true,
  setDiffShowFileList: vi.fn(),
  diffFullFile: false,
  setDiffFullFile: vi.fn(),
};
vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: (selector: (state: unknown) => unknown) => selector(preferences),
}));

const viewedKeys = new Set<string>();
vi.mock("@/store/diffViewedStore", () => ({
  useDiffViewedStore: (selector: (state: unknown) => unknown) =>
    selector({ toggleViewed: toggleViewedMock }),
  selectViewedSet: () => viewedKeys,
}));

vi.mock("../useDiffContent", () => ({
  useDiffContent: useDiffContentMock,
}));

// The full-file read is a real IPC call; these tests never exercise the scope,
// so it stays inert rather than reaching for `window.electron`.
vi.mock("../useDiffFileSource", () => ({
  useDiffFileSource: () => ({
    source: undefined,
    errorCode: null,
  }),
}));

import { DiffPane } from "../DiffPane";

const PANEL_ID = "diff-1";
const WORKTREE_ID = "wt-1";
const WORKTREE_PATH = "/repo";

function entry(path: string, status: GitStatus = "modified"): DiffChangeSetEntry {
  return { path, status, viewedKey: `${status}:${path}` };
}

function seedPanel(overrides: Record<string, unknown>): void {
  panelsById[PANEL_ID] = { id: PANEL_ID, kind: "diff", diffSource: "working-tree", ...overrides };
}

function paneElement(isFocused = true) {
  return (
    <DiffPane
      id={PANEL_ID}
      title="pane"
      isFocused={isFocused}
      location="dialog"
      worktreeId={WORKTREE_ID}
      onFocus={() => {}}
      onClose={() => {}}
    />
  );
}

function renderPane(isFocused = true) {
  return render(paneElement(isFocused));
}

/** The stepping shortcuts ride bubbling from inside the pane, not the document. */
function pressInPane(key: string): void {
  fireEvent.keyDown(screen.getByTestId("diff-pane-body"), { key });
}

function positionText(): string {
  return screen.getByTestId("diff-file-position-indicator").textContent ?? "";
}

beforeEach(() => {
  setDiffPanelFileMock.mockReset();
  toggleViewedMock.mockReset();
  useDiffContentMock.mockReset();
  useDiffContentMock.mockReturnValue({
    content: "diff --git a/a.ts b/a.ts",
    stale: false,
    retry: vi.fn(),
  });
  viewedKeys.clear();
  isImageDiffCandidateMock.mockReset();
  isImageDiffCandidateMock.mockReturnValue(false);
  preferences.diffShowFileList = true;
  preferences.diffWrapLines = null;
  preferences.setDiffWrapLines.mockClear();
  worktrees.clear();
  worktrees.set(WORKTREE_ID, { path: WORKTREE_PATH, branch: "feature/x" });
});

afterEach(() => {
  for (const key of Object.keys(panelsById)) delete panelsById[key];
  sidebarSelect.mockReset();
});

describe("DiffPane — current-file resolution", () => {
  it("matches on path AND status so a duplicated path resolves to the right entry", () => {
    const changeSet = [entry("a.ts", "modified"), entry("a.ts", "added"), entry("b.ts")];
    seedPanel({ filePath: "a.ts", fileStatus: "added", changeSet });
    renderPane();

    // Path alone would resolve index 0; the status disambiguates to index 1.
    expect(positionText()).toBe(`2 of ${changeSet.length}`);
    expect(screen.getByTestId("diff-sidebar-mock").getAttribute("data-current-index")).toBe("1");
  });

  it("falls back to a path-only match when the status changed underneath it", () => {
    // The file was opened as modified; a later poll re-reported it as deleted,
    // so the exact (path + status) lookup misses — it is still the same file.
    const changeSet = [entry("a.ts"), entry("b.ts", "deleted")];
    seedPanel({ filePath: "b.ts", fileStatus: "modified", changeSet });
    renderPane();

    expect(positionText()).toBe(`2 of ${changeSet.length}`);
  });

  it("separates the staged and unstaged twins of a partially staged file by viewedKey", () => {
    // Partial staging: the same path, the same status, in both sections. Only
    // the key tells them apart, so a path+status match resolves the staged copy.
    const changeSet: DiffChangeSetEntry[] = [
      { path: "a.ts", status: "modified", viewedKey: "staged:a.ts" },
      { path: "b.ts", status: "modified", viewedKey: "unstaged:b.ts" },
      { path: "a.ts", status: "modified", viewedKey: "unstaged:a.ts" },
    ];
    seedPanel({
      filePath: "a.ts",
      fileStatus: "modified",
      viewedKey: "unstaged:a.ts",
      changeSet,
    });
    renderPane();

    const expectedIndex = changeSet.findIndex((e) => e.viewedKey === "unstaged:a.ts");
    expect(positionText()).toBe(`${expectedIndex + 1} of ${changeSet.length}`);
    expect(screen.getByTestId("diff-sidebar-mock").getAttribute("data-current-index")).toBe(
      String(expectedIndex)
    );

    // The viewed marker follows the resolved entry, not the first path match.
    fireEvent.click(screen.getByLabelText("Viewed"));
    expect(toggleViewedMock).toHaveBeenCalledWith(WORKTREE_PATH, "unstaged:a.ts");
  });

  it("falls back to path+status when the cursor names an entry the set no longer has", () => {
    // A restored panel has no cursor at all, and a live one can outlive its
    // entry (the file was staged, so its unstaged key is gone).
    const changeSet = [entry("a.ts"), entry("b.ts", "added")];
    seedPanel({
      filePath: "b.ts",
      fileStatus: "added",
      viewedKey: "unstaged:b.ts",
      changeSet,
    });
    renderPane();

    expect(positionText()).toBe(`2 of ${changeSet.length}`);
  });

  it("reports no position when the open file has left the change set entirely", () => {
    seedPanel({
      filePath: "gone.ts",
      fileStatus: "modified",
      changeSet: [entry("a.ts"), entry("b.ts")],
    });
    renderPane();

    // currentIndex -1 renders as "0 of n" — and no viewed toggle, since there
    // is no entry to key the marker on.
    expect(positionText()).toBe("0 of 2");
    expect(screen.queryByLabelText("Viewed")).toBeNull();
  });
});

describe("DiffPane — file stepping", () => {
  const changeSet = [entry("a.ts"), entry("b.ts", "added"), entry("c.ts")];

  it("steps forward to the neighbouring entry", () => {
    seedPanel({ filePath: "a.ts", fileStatus: "modified", changeSet });
    renderPane();

    fireEvent.click(screen.getByLabelText("Next file"));

    // The entry's own cursor rides along, so the next resolution can't slide
    // onto a different entry that happens to share its path and status.
    expect(setDiffPanelFileMock).toHaveBeenCalledWith(
      PANEL_ID,
      "b.ts",
      "added",
      changeSet[1]!.viewedKey
    );
  });

  it("steps backward to the neighbouring entry", () => {
    seedPanel({ filePath: "c.ts", fileStatus: "modified", changeSet });
    renderPane();

    fireEvent.click(screen.getByLabelText("Previous file"));

    expect(setDiffPanelFileMock).toHaveBeenCalledWith(
      PANEL_ID,
      "b.ts",
      "added",
      changeSet[1]!.viewedKey
    );
  });

  it("disables the boundary buttons at each end", () => {
    seedPanel({ filePath: "a.ts", fileStatus: "modified", changeSet });
    const { unmount } = renderPane();
    expect(screen.getByLabelText("Previous file").hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("Next file").hasAttribute("disabled")).toBe(false);
    unmount();

    seedPanel({ filePath: "c.ts", fileStatus: "modified", changeSet });
    renderPane();
    expect(screen.getByLabelText("Previous file").hasAttribute("disabled")).toBe(false);
    expect(screen.getByLabelText("Next file").hasAttribute("disabled")).toBe(true);
  });

  it("clamps the keyboard shortcuts at both boundaries instead of stepping off the set", () => {
    seedPanel({ filePath: "a.ts", fileStatus: "modified", changeSet });
    const { unmount } = renderPane();

    // `[` is not gated by the button's disabled state, so it is the path that
    // has to clamp — a bare index-1 decrement would select undefined.
    pressInPane("[");
    expect(setDiffPanelFileMock).toHaveBeenCalledWith(
      PANEL_ID,
      "a.ts",
      "modified",
      changeSet[0]!.viewedKey
    );
    unmount();

    setDiffPanelFileMock.mockReset();
    seedPanel({ filePath: "c.ts", fileStatus: "modified", changeSet });
    renderPane();

    pressInPane("]");
    expect(setDiffPanelFileMock).toHaveBeenCalledWith(
      PANEL_ID,
      "c.ts",
      "modified",
      changeSet[2]!.viewedKey
    );
  });

  it("keeps the shortcuts inert while the panel is unfocused", () => {
    seedPanel({ filePath: "a.ts", fileStatus: "modified", changeSet });
    renderPane(false);

    pressInPane("]");

    expect(setDiffPanelFileMock).not.toHaveBeenCalled();
  });

  it("ignores the shortcuts while a text field inside the pane has focus", () => {
    seedPanel({ filePath: "a.ts", fileStatus: "modified", changeSet });
    renderPane();

    // The sidebar's filter box lives inside the keydown host; typing `]` there
    // must reach the input, not step files.
    const input = document.createElement("input");
    screen.getByTestId("diff-pane-body").appendChild(input);
    fireEvent.keyDown(input, { key: "]" });

    expect(setDiffPanelFileMock).not.toHaveBeenCalled();
  });

  it("clamps against a change set that shrank while the panel was open", () => {
    // Opened on the 4th file, then a worktree refresh drops the set to 2. The
    // resolved index is now -1 and the remembered one (3) is out of range.
    const wide = [entry("a.ts"), entry("b.ts"), entry("c.ts"), entry("d.ts")];
    seedPanel({ filePath: "d.ts", fileStatus: "modified", changeSet: wide });
    const { rerender } = renderPane();
    expect(positionText()).toBe(`4 of ${wide.length}`);

    const narrow = [entry("a.ts"), entry("b.ts")];
    seedPanel({ filePath: "d.ts", fileStatus: "modified", changeSet: narrow });
    rerender(
      <DiffPane
        id={PANEL_ID}
        title="pane"
        isFocused={true}
        location="dialog"
        worktreeId={WORKTREE_ID}
        onFocus={() => {}}
        onClose={() => {}}
      />
    );

    pressInPane("]");
    // Clamped to the shrunk set's last entry — never index 3 (undefined) or 4.
    expect(setDiffPanelFileMock).toHaveBeenCalledWith(
      PANEL_ID,
      "b.ts",
      "modified",
      narrow[1]!.viewedKey
    );

    // Backward is what proves the stale index is clamped *before* the step and
    // not just after it: decrementing the remembered 3 would land on b.ts again.
    setDiffPanelFileMock.mockReset();
    pressInPane("[");
    expect(setDiffPanelFileMock).toHaveBeenCalledWith(
      PANEL_ID,
      "a.ts",
      "modified",
      narrow[0]!.viewedKey
    );
  });
});

describe("DiffPane — workspace chrome", () => {
  it("renders the sidebar only once the change set holds more than one file", () => {
    seedPanel({ filePath: "a.ts", fileStatus: "modified", changeSet: [entry("a.ts")] });
    const { unmount } = renderPane();
    expect(screen.queryByTestId("diff-sidebar-mock")).toBeNull();
    // A single-file panel is not a workspace, so it gets no stepping chrome.
    expect(screen.queryByLabelText("Next file")).toBeNull();
    unmount();

    seedPanel({
      filePath: "a.ts",
      fileStatus: "modified",
      changeSet: [entry("a.ts"), entry("b.ts")],
    });
    renderPane();
    expect(screen.getByTestId("diff-sidebar-mock").getAttribute("data-file-count")).toBe("2");
    expect(screen.getByLabelText("Next file")).toBeTruthy();
  });

  it("keeps the sidebar hidden when the file-list preference is off", () => {
    preferences.diffShowFileList = false;
    seedPanel({
      filePath: "a.ts",
      fileStatus: "modified",
      changeSet: [entry("a.ts"), entry("b.ts")],
    });
    renderPane();

    expect(screen.queryByTestId("diff-sidebar-mock")).toBeNull();
    // The stepping controls are independent of the sidebar toggle.
    expect(screen.getByLabelText("Next file")).toBeTruthy();
  });

  it("marks the current file viewed against its own viewedKey", () => {
    const changeSet = [entry("a.ts"), entry("b.ts", "added")];
    seedPanel({ filePath: "b.ts", fileStatus: "added", changeSet });
    renderPane();

    fireEvent.click(screen.getByLabelText("Viewed"));

    expect(toggleViewedMock).toHaveBeenCalledWith(WORKTREE_PATH, changeSet[1]!.viewedKey);
  });
});

describe("DiffPane — content-aware toolbar", () => {
  it("drops the text-diff controls for an image, keeping the ones that still act", () => {
    isImageDiffCandidateMock.mockReturnValue(true);
    seedPanel({ filePath: "assets/logo.png", fileStatus: "modified" });
    renderPane();

    // The image branch is the one under test, not just any non-text render —
    // and it is this file's path that classified it, not a blanket true.
    expect(screen.getByTestId("image-diff-mock")).toBeTruthy();
    expect(isImageDiffCandidateMock).toHaveBeenCalledWith("assets/logo.png");

    // Nothing to lay out side by side, and no lines to wrap.
    expect(screen.queryByText("Unified")).toBeNull();
    expect(screen.queryByText("Split")).toBeNull();
    expect(screen.queryByLabelText("Wrap long lines")).toBeNull();

    // Refresh and the path pill act on any file kind, so they stay.
    expect(screen.getByLabelText("Copy file path")).toBeTruthy();
    expect(screen.getByLabelText("Refresh")).toBeTruthy();
  });

  it("keeps the text-diff controls for a text file", () => {
    seedPanel({ filePath: "src/a.ts", fileStatus: "modified" });
    renderPane();

    expect(screen.getByTestId("diff-viewer-mock")).toBeTruthy();
    expect(screen.getByText("Unified")).toBeTruthy();
    expect(screen.getByText("Split")).toBeTruthy();
    expect(screen.getByLabelText("Wrap long lines")).toBeTruthy();
  });

  it("keeps them for a base-branch image, which the text viewer still handles", () => {
    // ImageDiffViewer compares the working tree against HEAD, so it has nothing
    // to show for a base-branch comparison — those stay on DiffViewer whatever
    // the extension. Gating the toolbar on candidacy alone would strip the
    // controls off a body that is still the text viewer.
    isImageDiffCandidateMock.mockReturnValue(true);
    seedPanel({
      filePath: "assets/logo.png",
      fileStatus: "modified",
      diffSource: "base-branch",
      baseBranch: "main",
    });
    renderPane();

    expect(screen.queryByTestId("image-diff-mock")).toBeNull();
    expect(screen.getByTestId("diff-viewer-mock")).toBeTruthy();
    expect(screen.getByText("Unified")).toBeTruthy();
    expect(screen.getByLabelText("Wrap long lines")).toBeTruthy();
  });
});

describe("DiffPane — empty state", () => {
  it("renders the empty state and no diff when the panel has no file", () => {
    seedPanel({ changeSet: [entry("a.ts"), entry("b.ts")] });
    renderPane();

    expect(screen.getByTestId("empty-state-mock")).toBeTruthy();
    expect(screen.queryByTestId("diff-viewer-mock")).toBeNull();
  });

  it("renders the diff once a file is set", () => {
    seedPanel({ filePath: "a.ts", fileStatus: "modified" });
    renderPane();

    expect(screen.getByTestId("diff-viewer-mock")).toBeTruthy();
    expect(screen.queryByTestId("empty-state-mock")).toBeNull();
  });
});

describe("DiffPane — unresolvable subject", () => {
  beforeEach(() => {
    // Nothing has landed yet: the branch under test is exactly the one that
    // would otherwise sit on the loading skeleton forever.
    useDiffContentMock.mockReturnValue({ content: undefined, stale: false, retry: vi.fn() });
  });

  it("explains itself instead of spinning when the worktree cannot be resolved", () => {
    // The panel outlived its worktree (removed, or never registered), so there
    // is no root to diff against and no request will ever be made.
    worktrees.clear();
    seedPanel({ filePath: "a.ts", fileStatus: "modified" });
    const { unmount } = renderPane();

    expect(screen.queryByLabelText("Loading diff")).toBeNull();
    expect(screen.queryByTestId("diff-viewer-mock")).toBeNull();
    const unavailableTitle = screen.getByTestId("empty-state-mock").getAttribute("data-title");
    unmount();

    // Distinct from the no-file state: "pick a changed file" invites a click,
    // and there is nothing here for the user to click.
    seedPanel({});
    renderPane();
    expect(screen.getByTestId("empty-state-mock").getAttribute("data-title")).not.toBe(
      unavailableTitle
    );
  });

  it("explains itself when a base-branch panel has no base ref", () => {
    seedPanel({ filePath: "a.ts", fileStatus: "modified", diffSource: "base-branch" });
    renderPane();

    expect(screen.queryByLabelText("Loading diff")).toBeNull();
    expect(screen.getByTestId("empty-state-mock")).toBeTruthy();
  });

  it("keeps the skeleton for a resolvable subject whose request is still in flight", () => {
    // The discriminator is the subject, not the file path: same panel shape,
    // both refs present, so this one is genuinely loading.
    seedPanel({
      filePath: "a.ts",
      fileStatus: "modified",
      diffSource: "base-branch",
      baseBranch: "main",
    });
    renderPane();

    expect(screen.getByLabelText("Loading diff")).toBeTruthy();
    expect(screen.queryByTestId("empty-state-mock")).toBeNull();
  });
});

describe("DiffPane — video current-version mode (#11382)", () => {
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
    let objectUrlSequence = 0;
    URL.createObjectURL = vi.fn(() => `blob:app://daintree/video-${objectUrlSequence++}`);
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    videoFetchMock.mockReset();
  });

  it("plays the working-tree version instead of rendering a diff", async () => {
    const changeSet = [entry("media/demo.mp4")];
    seedPanel({ filePath: "media/demo.mp4", fileStatus: "modified", changeSet });
    const { container } = renderPane();

    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    // The absolute working-tree path rides the protocol URL — no diff content,
    // no base64 diffMedia IPC (8 MB cap, unsuited to video).
    expect(String(videoFetchMock.mock.calls[0]?.[0])).toContain(
      encodeURIComponent("/repo/media/demo.mp4")
    );
    expect(screen.queryByTestId("diff-viewer-mock")).toBeNull();
  });

  it("hides the text-diff layout controls in video mode", () => {
    seedPanel({
      filePath: "media/demo.mp4",
      fileStatus: "modified",
      changeSet: [entry("media/demo.mp4")],
    });
    renderPane();

    expect(screen.queryByRole("button", { name: "Unified" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Wrap long lines" })).toBeNull();
  });

  it("reloads the video from the toolbar Refresh (nonce-busted refetch) and still retries the diff", async () => {
    const retry = vi.fn();
    useDiffContentMock.mockReturnValue({ content: "diff --git a/x b/x", stale: false, retry });
    seedPanel({
      filePath: "media/demo.mp4",
      fileStatus: "modified",
      changeSet: [entry("media/demo.mp4")],
    });
    const { container } = renderPane();
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    const before = container.querySelector("video")?.getAttribute("src");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    // A bumped nonce must produce a fresh protocol fetch (new &v= param) and a
    // new blob URL — the old element would otherwise keep playing stale bytes.
    await waitFor(() => expect(videoFetchMock).toHaveBeenCalledTimes(2));
    expect(String(videoFetchMock.mock.calls[1]?.[0])).not.toBe(
      String(videoFetchMock.mock.calls[0]?.[0])
    );
    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).not.toBe(before)
    );
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("shows a playback-failure state instead of a dead control on media error", async () => {
    seedPanel({
      filePath: "media/demo.mp4",
      fileStatus: "modified",
      changeSet: [entry("media/demo.mp4")],
    });
    const { container } = renderPane();
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());

    fireEvent.error(container.querySelector("video")!);

    expect(container.querySelector("video")).toBeNull();
    const titles = Array.from(container.querySelectorAll('[data-testid="empty-state-mock"]')).map(
      (el) => el.getAttribute("data-title")
    );
    expect(titles).toContain("This video couldn't be played");
  });

  it("headlines the preview's own reason rather than repeating it under a generic title", async () => {
    videoFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(2 * 1024 * 1024 * 1024) }),
      blob: () => Promise.resolve(new Blob(["x"])),
    });
    seedPanel({
      filePath: "media/demo.mp4",
      fileStatus: "modified",
      changeSet: [entry("media/demo.mp4")],
    });
    const { container } = renderPane();

    await waitFor(() =>
      expect(container.querySelector('[data-testid="empty-state-mock"]')).not.toBeNull()
    );
    const state = container.querySelector('[data-testid="empty-state-mock"]')!;
    const title = state.getAttribute("data-title") ?? "";
    const description = state.getAttribute("data-description") ?? "";
    // The refusal is its own headline — the generic playback-failure title would
    // be wrong (nothing failed to play) and would restate the description.
    expect(title).not.toBe("This video couldn't be played");
    expect(description).toBeTruthy();
    expect(description).not.toContain(title);
  });

  it("shows a quiet empty state for a deleted video (no working-tree bytes to play)", () => {
    seedPanel({
      filePath: "media/demo.mp4",
      fileStatus: "deleted",
      changeSet: [entry("media/demo.mp4", "deleted")],
    });
    const { container } = renderPane();

    expect(container.querySelector("video")).toBeNull();
    const titles = Array.from(container.querySelectorAll('[data-testid="empty-state-mock"]')).map(
      (el) => el.getAttribute("data-title")
    );
    expect(titles).toContain("No working-tree version to play");
  });
});

describe("DiffPane — audio current-version mode (#11425)", () => {
  // Same fetch/object-URL boundary as the video suite: audio shares the
  // protocol path because electron#51442 covers <audio> too.
  const audioFetchMock = vi.fn();
  beforeEach(() => {
    audioFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: () => Promise.resolve(new Blob(["x"])),
    });
    vi.stubGlobal("fetch", audioFetchMock);
    let objectUrlSequence = 0;
    URL.createObjectURL = vi.fn(() => `blob:app://daintree/audio-${objectUrlSequence++}`);
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    audioFetchMock.mockReset();
  });

  it("plays the working-tree version instead of rendering a diff", async () => {
    seedPanel({
      filePath: "media/track.mp3",
      fileStatus: "modified",
      changeSet: [entry("media/track.mp3")],
    });
    const { container } = renderPane();

    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
    expect(String(audioFetchMock.mock.calls[0]?.[0])).toContain(
      encodeURIComponent("/repo/media/track.mp3")
    );
    expect(screen.queryByTestId("diff-viewer-mock")).toBeNull();
  });

  it("hides the text-diff layout controls in audio mode", () => {
    seedPanel({
      filePath: "media/track.mp3",
      fileStatus: "modified",
      changeSet: [entry("media/track.mp3")],
    });
    renderPane();

    expect(screen.queryByRole("button", { name: "Unified" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Wrap long lines" })).toBeNull();
  });

  it("reloads the track from the toolbar Refresh (nonce-busted refetch)", async () => {
    const retry = vi.fn();
    useDiffContentMock.mockReturnValue({ content: "diff --git a/x b/x", stale: false, retry });
    seedPanel({
      filePath: "media/track.mp3",
      fileStatus: "modified",
      changeSet: [entry("media/track.mp3")],
    });
    const { container } = renderPane();
    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
    const before = container.querySelector("audio")?.getAttribute("src");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(audioFetchMock).toHaveBeenCalledTimes(2));
    expect(String(audioFetchMock.mock.calls[1]?.[0])).not.toBe(
      String(audioFetchMock.mock.calls[0]?.[0])
    );
    await waitFor(() =>
      expect(container.querySelector("audio")?.getAttribute("src")).not.toBe(before)
    );
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("uses audio-specific copy on a playback failure, not the video wording", async () => {
    seedPanel({
      filePath: "media/track.mp3",
      fileStatus: "modified",
      changeSet: [entry("media/track.mp3")],
    });
    const { container } = renderPane();
    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());

    fireEvent.error(container.querySelector("audio")!);

    expect(container.querySelector("audio")).toBeNull();
    const titles = Array.from(container.querySelectorAll('[data-testid="empty-state-mock"]')).map(
      (el) => el.getAttribute("data-title")
    );
    expect(titles).toContain("This audio file couldn't be played");
    expect(titles).not.toContain("This video couldn't be played");
  });

  it("headlines the preview's own refusal rather than the generic playback title", async () => {
    audioFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(2 * 1024 * 1024 * 1024) }),
      blob: () => Promise.resolve(new Blob(["x"])),
    });
    seedPanel({
      filePath: "media/track.wav",
      fileStatus: "modified",
      changeSet: [entry("media/track.wav")],
    });
    const { container } = renderPane();

    await waitFor(() =>
      expect(container.querySelector('[data-testid="empty-state-mock"]')).not.toBeNull()
    );
    const state = container.querySelector('[data-testid="empty-state-mock"]')!;
    const title = state.getAttribute("data-title") ?? "";
    const description = state.getAttribute("data-description") ?? "";
    // Nothing failed to play, so the generic title would be wrong — and the
    // description carries the way forward instead of restating the headline.
    expect(title).not.toBe("This audio file couldn't be played");
    expect(description).toBeTruthy();
    expect(description).not.toContain(title);
  });

  it("keeps Full file visible but disabled, explaining audio already shows it all", () => {
    seedPanel({
      filePath: "media/track.mp3",
      fileStatus: "modified",
      changeSet: [entry("media/track.mp3")],
    });
    renderPane();

    expect(screen.getByText(/already shows the whole audio file/i)).toBeTruthy();
  });

  it("shows a quiet empty state for a deleted audio file", () => {
    seedPanel({
      filePath: "media/track.mp3",
      fileStatus: "deleted",
      changeSet: [entry("media/track.mp3", "deleted")],
    });
    const { container } = renderPane();

    expect(container.querySelector("audio")).toBeNull();
    const descriptions = Array.from(
      container.querySelectorAll('[data-testid="empty-state-mock"]')
    ).map((el) => el.getAttribute("data-description"));
    // The shared title is kind-agnostic; the description must name audio so it
    // doesn't tell someone their track was a video.
    expect(descriptions.some((d) => d?.includes("audio file was deleted"))).toBe(true);
  });
});

describe("DiffPane — PDF current-version mode (#11427)", () => {
  function pdfFrame(container: HTMLElement): HTMLIFrameElement | null {
    return container.querySelector("iframe");
  }

  it("shows the working-tree PDF instead of rendering a diff", () => {
    seedPanel({
      filePath: "docs/spec.pdf",
      fileStatus: "modified",
      changeSet: [entry("docs/spec.pdf")],
    });
    const { container } = renderPane();

    const src = new URL(pdfFrame(container)?.getAttribute("src") ?? "");
    expect(src.protocol).toBe("daintree-pdf:");
    // The absolute working-tree path rides the protocol URL, and no text diff
    // is attempted for a binary document.
    expect(src.searchParams.get("path")).toBe("/repo/docs/spec.pdf");
    expect(screen.queryByTestId("diff-viewer-mock")).toBeNull();
  });

  it("hides the text-diff layout controls in PDF mode", () => {
    seedPanel({
      filePath: "docs/spec.pdf",
      fileStatus: "modified",
      changeSet: [entry("docs/spec.pdf")],
    });
    renderPane();

    expect(screen.queryByRole("button", { name: "Unified" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Wrap long lines" })).toBeNull();
  });

  it("re-navigates the frame from the toolbar Refresh and still retries the diff", async () => {
    const retry = vi.fn();
    useDiffContentMock.mockReturnValue({ content: "diff --git a/x b/x", stale: false, retry });
    seedPanel({
      filePath: "docs/spec.pdf",
      fileStatus: "modified",
      changeSet: [entry("docs/spec.pdf")],
    });
    const { container } = renderPane();
    const before = pdfFrame(container)?.getAttribute("src");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(pdfFrame(container)?.getAttribute("src")).not.toBe(before));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("explains there is nothing to preview when the PDF was deleted", () => {
    seedPanel({
      filePath: "docs/spec.pdf",
      fileStatus: "deleted",
      changeSet: [entry("docs/spec.pdf", "deleted")],
    });
    const { container } = renderPane();

    expect(pdfFrame(container)).toBeNull();
    expect(screen.getByTestId("empty-state-mock")).toBeTruthy();
  });
});

describe("DiffPane wrap toggle (#12170)", () => {
  function wrapButton(): HTMLElement {
    return screen.getByRole("button", { name: "Wrap long lines" });
  }

  function viewerWrap(): string | null {
    return screen.getByTestId("diff-viewer-mock").getAttribute("data-wrap-lines");
  }

  it("wraps a prose diff on first render with nothing stored", () => {
    seedPanel({
      filePath: "docs/spec.md",
      fileStatus: "modified",
      changeSet: [entry("docs/spec.md")],
    });
    renderPane();

    expect(viewerWrap()).toBe("true");
    expect(wrapButton().getAttribute("aria-pressed")).toBe("true");
  });

  it("leaves a code diff unwrapped under the same auto default", () => {
    seedPanel({ filePath: "src/a.ts", fileStatus: "modified", changeSet: [entry("src/a.ts")] });
    renderPane();

    expect(viewerWrap()).toBe("false");
    expect(wrapButton().getAttribute("aria-pressed")).toBe("false");
  });

  it("stores an explicit off when toggled from an auto-wrapped prose diff", () => {
    // The bug this guards: toggling against the raw stored value would write
    // `true` here (`!null` is `true`), leaving the button visibly pressed and
    // the diff wrapped after a click that asked for the opposite.
    seedPanel({
      filePath: "docs/spec.md",
      fileStatus: "modified",
      changeSet: [entry("docs/spec.md")],
    });
    renderPane();

    fireEvent.click(wrapButton());

    expect(preferences.setDiffWrapLines).toHaveBeenCalledWith(false);
  });

  it("stores an explicit on when toggled from an auto-unwrapped code diff", () => {
    seedPanel({ filePath: "src/a.ts", fileStatus: "modified", changeSet: [entry("src/a.ts")] });
    renderPane();

    fireEvent.click(wrapButton());

    expect(preferences.setDiffWrapLines).toHaveBeenCalledWith(true);
  });

  it("cycles auto-on to explicit-off to explicit-on, updating button and viewer", () => {
    // Dispatching the right argument is not enough: a regression that wrote the
    // preference but left the control and the viewer showing the old value
    // would pass every assertion that stops at the setter.
    seedPanel({
      filePath: "docs/spec.md",
      fileStatus: "modified",
      changeSet: [entry("docs/spec.md")],
    });
    const { rerender } = renderPane();
    expect(viewerWrap()).toBe("true");

    fireEvent.click(wrapButton());
    rerender(paneElement());
    expect(preferences.diffWrapLines).toBe(false);
    expect(viewerWrap()).toBe("false");
    expect(wrapButton().getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(wrapButton());
    rerender(paneElement());
    expect(preferences.diffWrapLines).toBe(true);
    expect(viewerWrap()).toBe("true");
    expect(wrapButton().getAttribute("aria-pressed")).toBe("true");
  });

  it("lets an explicit override beat the file type in both directions", () => {
    preferences.diffWrapLines = false;
    seedPanel({
      filePath: "docs/spec.md",
      fileStatus: "modified",
      changeSet: [entry("docs/spec.md")],
    });
    const { unmount } = renderPane();
    expect(viewerWrap()).toBe("false");
    unmount();

    preferences.diffWrapLines = true;
    seedPanel({ filePath: "src/a.ts", fileStatus: "modified", changeSet: [entry("src/a.ts")] });
    renderPane();
    expect(viewerWrap()).toBe("true");
  });
});
