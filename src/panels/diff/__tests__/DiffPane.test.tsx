// @vitest-environment jsdom
import type { ReactNode } from "react";
import { render, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitStatus } from "@shared/types/git";
import type { DiffChangeSetEntry } from "@shared/types/git";

// Cross-file stepping, the workspace sidebar and the viewed markers moved off
// the opening surfaces (FileChangeList, the Review Hub) and onto the panel
// itself. These tests target that logic only, so the diff renderer, the
// sidebar and the content fetch are all stubbed out.

// The stub deliberately drops `toolbar` — nothing here asserts on it, and
// leaving it unrendered keeps the toolbar's Radix/observer tree out of jsdom.
vi.mock("@/components/Panel/ContentPanel", () => ({
  ContentPanel: (props: { children?: ReactNode }) => <>{props.children}</>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/Worktree/DiffViewer", () => ({
  DiffViewer: () => <div data-testid="diff-viewer-mock" />,
}));
vi.mock("@/components/FileViewer/ImageDiffViewer", () => ({
  ImageDiffViewer: () => <div data-testid="image-diff-mock" />,
  isImageDiffCandidate: () => false,
}));
vi.mock("@/components/ui/EmptyState", () => ({
  EmptyState: (props: { title: string }) => (
    <div data-testid="empty-state-mock" data-title={props.title} />
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
  setDiffPanelFileMock: vi.fn<(id: string, path: string, status: GitStatus) => void>(),
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
  diffWrapLines: false,
  setDiffWrapLines: vi.fn(),
  diffShowFileList: true,
  setDiffShowFileList: vi.fn(),
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

function renderPane(isFocused = true) {
  return render(
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
  preferences.diffShowFileList = true;
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

    expect(setDiffPanelFileMock).toHaveBeenCalledWith(PANEL_ID, "b.ts", "added");
  });

  it("steps backward to the neighbouring entry", () => {
    seedPanel({ filePath: "c.ts", fileStatus: "modified", changeSet });
    renderPane();

    fireEvent.click(screen.getByLabelText("Previous file"));

    expect(setDiffPanelFileMock).toHaveBeenCalledWith(PANEL_ID, "b.ts", "added");
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
    expect(setDiffPanelFileMock).toHaveBeenCalledWith(PANEL_ID, "a.ts", "modified");
    unmount();

    setDiffPanelFileMock.mockReset();
    seedPanel({ filePath: "c.ts", fileStatus: "modified", changeSet });
    renderPane();

    pressInPane("]");
    expect(setDiffPanelFileMock).toHaveBeenCalledWith(PANEL_ID, "c.ts", "modified");
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
    expect(setDiffPanelFileMock).toHaveBeenCalledWith(PANEL_ID, "b.ts", "modified");

    // Backward is what proves the stale index is clamped *before* the step and
    // not just after it: decrementing the remembered 3 would land on b.ts again.
    setDiffPanelFileMock.mockReset();
    pressInPane("[");
    expect(setDiffPanelFileMock).toHaveBeenCalledWith(PANEL_ID, "a.ts", "modified");
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
