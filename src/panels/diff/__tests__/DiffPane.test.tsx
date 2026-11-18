// @vitest-environment jsdom
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { act, cleanup, render, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitDiffSide, GitStatus } from "@shared/types/git";
import type { DiffChangeSetEntry } from "@shared/types/git";

// Cross-file stepping, the workspace sidebar and the viewed markers moved off
// the opening surfaces (FileChangeList, the Review Hub) and onto the panel
// itself. These tests target that logic only, so the diff renderer, the
// sidebar and the content fetch are all stubbed out.

// A focusable root wrapping the toolbar and the body, as the real ContentPanel's
// is: the pane root is where focus lands when the pane is focused, and the
// toolbar and footer are siblings of the body inside it.
// It reads its tab group's edge and reorder the way the real ContentPanel does.
vi.mock("@/components/Panel/ContentPanel", async () => {
  const { forwardRef } = await import("react");
  const { useGridGroupAttention } = await import("@/components/Panel/gridGroupAttention");
  const { useGridGroupTabReorder } = await import("@/components/Panel/gridGroupTabReorder");
  return {
    ContentPanel: forwardRef<
      HTMLDivElement,
      {
        id: string;
        location?: "grid" | "dock" | "dialog";
        tabs?: Array<{ id: string }>;
        toolbar?: ReactNode;
        children?: ReactNode;
        onKeyDown?: (event: ReactKeyboardEvent) => void;
      }
    >(function ContentPanelMock(props, ref) {
      const attention = useGridGroupAttention(props.id, props.location ?? "grid");
      const reorder = useGridGroupTabReorder(props.id, props.location ?? "grid");
      return (
        <div ref={ref} data-testid="panel-root" tabIndex={-1} onKeyDown={props.onKeyDown}>
          <span
            data-testid="group-edge"
            data-group-ambient={attention?.ambientAgentState}
            data-group-failed={attention?.hiddenTabFailed || undefined}
          />
          <span
            data-testid="group-reorder"
            data-group-id={reorder?.groupId}
            onClick={() =>
              reorder?.onTabReorder([...(props.tabs ?? [])].reverse().map((t) => t.id))
            }
          />
          {props.toolbar}
          <div data-pane-body="">{props.children}</div>
        </div>
      );
    }),
  };
});

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// Set by a test that needs an overlay the pane opened: a React child of the
// pane portalled out of its DOM, the way a menu or popover is.
const { viewerOverlay, viewerDraftSessions } = vi.hoisted(() => ({
  viewerOverlay: { open: false },
  // Every note-draft session a mounted viewer was handed.
  viewerDraftSessions: new Set<unknown>(),
}));
vi.mock("@/components/Worktree/DiffViewer", async () => {
  const { createPortal } = await import("react-dom");
  const { use, useEffect } = await import("react");
  const { DiffNoteDraftContext } = await import("@/components/Worktree/diffNoteDrafts");
  const { parseFilePatch } = await import("@shared/utils/patchHunks");
  return {
    // Surfaces `wrapLines` so the auto/override resolution is observable from the
    // prop the viewer actually receives, not just from the toolbar's pressed state.
    // `diff` rides along so a test can prove the viewer received the patch it
    // names, not merely that something mounted.
    DiffViewer: (props: {
      wrapLines?: boolean;
      diff?: string;
      onShowWhitespaceChanges?: () => void;
      renderHunkActions?: (hunk: never, index: number, file: never) => ReactNode;
      onHunkCount?: (count: number, forDiff: string) => void;
      revealHunk?: { index: number; seq: number } | null;
    }) => {
      viewerDraftSessions.add(use(DiffNoteDraftContext));
      // Reports its hunks as the real viewer does once it has parsed the patch:
      // a test's count when it sets one, else git's own hunks in the patch.
      const { diff, onHunkCount } = props;
      useEffect(() => {
        const count = viewerHunkCount.current ?? parseFilePatch(diff ?? "")?.hunks.length ?? 0;
        onHunkCount?.(count, diff ?? "");
      }, [diff, onHunkCount]);
      // Each rendered hunk through the host's slot, as the real viewer draws
      // them in its hunk headers: git's own hunks, unless a test merges them
      // the way expanded context or the full-file view does.
      const hunks = props.renderHunkActions
        ? (viewerRenderedHunks.current ?? parseFilePatch(props.diff ?? "")?.hunks ?? [])
        : [];
      return (
        <div
          data-testid="diff-viewer-mock"
          data-wrap-lines={String(props.wrapLines)}
          data-diff={props.diff}
          data-reveal-index={props.revealHunk?.index}
          data-reveal-seq={props.revealHunk?.seq}
        >
          <div tabIndex={0} data-testid="diff-viewer-region" />
          {viewerHunkCount.current !== null && (
            // Hunks before `viewerDrawnFrom` belong to a file drawn collapsed.
            <div data-hunk-offset={viewerDrawnFrom.current}>
              <table>
                <tbody>
                  {Array.from(
                    { length: viewerHunkCount.current - viewerDrawnFrom.current },
                    (_, index) => (
                      <tr key={index} className="diff-hunk-anchor" />
                    )
                  )}
                </tbody>
              </table>
            </div>
          )}
          {hunks.map((hunk, index) => (
            <div key={index} data-testid="hunk-actions">
              {props.renderHunkActions!(hunk as never, index, {} as never)}
            </div>
          ))}
          {props.onShowWhitespaceChanges && (
            <button type="button" onClick={props.onShowWhitespaceChanges}>
              Show whitespace changes
            </button>
          )}
          {viewerOverlay.open &&
            createPortal(
              <div role="menu" aria-label="Viewer overlay">
                <button type="button" role="menuitem">
                  Overlay item
                </button>
              </div>,
              document.body
            )}
        </div>
      );
    },
    FULL_FILE_MAX_LINES: 5000,
  };
});

// The rendered layout pulls react-markdown behind a lazy boundary; these tests
// exercise the toolbar's plumbing, not the renderer, so it stays a stub.
interface RenderedMockProps {
  newSource?: string;
  status: string;
  attemptKey: string;
  requestKey: string;
  onChangeCount?: (count: number | null, forAttempt: string) => void;
}
// The latest props the stub was rendered with, so a test can report up through
// the same callbacks the real view uses.
const { renderedProps } = vi.hoisted(() => ({
  renderedProps: { current: null as RenderedMockProps | null },
}));
vi.mock("@/components/Worktree/RenderedMarkdownDiff", () => ({
  RenderedMarkdownDiff: (props: RenderedMockProps) => {
    renderedProps.current = props;
    return (
      <div
        data-testid="rendered-markdown-mock"
        data-has-source={String(props.newSource !== undefined)}
        data-status={props.status}
        data-attempt-key={props.attemptKey}
        data-request-key={props.requestKey}
      />
    );
  },
}));

// Controllable so a test can put the pane in image mode; `beforeEach` returns it
// to text mode, which is what every other test in this file assumes.
const { isImageDiffCandidateMock } = vi.hoisted(() => ({
  isImageDiffCandidateMock:
    vi.fn<typeof import("@/components/FileViewer/ImageDiffViewer").isImageDiffCandidate>(),
}));
vi.mock("@/components/FileViewer/ImageDiffViewer", () => ({
  ImageDiffViewer: (props: { side?: string }) => (
    <div data-testid="image-diff-mock" data-side={props.side ?? "none"} />
  ),
  isImageDiffCandidate: isImageDiffCandidateMock,
}));
vi.mock("@/components/ui/EmptyState", () => ({
  EmptyState: (props: { title: string; description?: string; action?: ReactNode }) => (
    <div
      data-testid="empty-state-mock"
      data-title={props.title}
      data-description={props.description}
    >
      {props.action}
    </div>
  ),
}));

// Exposes the resolved index so the identity resolution is observable from the
// sidebar as well as from the footer position indicator.
// Its one row stands for the last file of the set, marked by `data-file-index`
// on the row around its button as the real shelf marks it.
const sidebarSelect = vi.fn<(index: number) => void>();
vi.mock("@/components/FileViewer/DiffFileSidebar", () => ({
  DiffFileSidebar: (props: {
    files: DiffChangeSetEntry[];
    currentIndex: number;
    filter: string;
    onFilterChange: (filter: string) => void;
  }) => (
    <div
      data-testid="diff-sidebar-mock"
      data-current-index={props.currentIndex}
      data-file-count={props.files.length}
    >
      <input
        data-testid="diff-sidebar-filter"
        value={props.filter}
        onChange={(event) => props.onFilterChange(event.target.value)}
      />
      <div data-file-index={props.files.length - 1}>
        <button type="button" data-testid="diff-sidebar-row" />
      </div>
    </div>
  ),
}));

// How many hunks the viewer stub reports (and draws an anchor row for), null
// for the count of git's own hunks in the patch.
const { viewerHunkCount, viewerDrawnFrom } = vi.hoisted(() => ({
  viewerHunkCount: { current: null as number | null },
  viewerDrawnFrom: { current: 0 },
}));

// Hunk ranges the viewer stub renders in place of git's own, null for git's.
const { viewerRenderedHunks } = vi.hoisted(() => ({
  viewerRenderedHunks: {
    current: null as Array<{
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
    }> | null,
  },
}));

const { setDiffPanelFileMock, toggleViewedMock, useDiffContentMock } = vi.hoisted(() => ({
  setDiffPanelFileMock:
    vi.fn<
      (
        id: string,
        path: string,
        status: GitStatus,
        viewedKey?: string,
        fileSide?: GitDiffSide
      ) => void
    >(),
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
  diffViewType: "unified" as "unified" | "split",
  setDiffViewType: vi.fn(),
  diffMarkdownRendered: false,
  setDiffMarkdownRendered: vi.fn(),
  markdownFontSize: "sm" as const,
  // `null` is auto — prose wraps, everything else doesn't (#12170).
  diffWrapLines: null as boolean | null,
  // Writes through, so a test can follow a full toggle cycle instead of only
  // the argument the click dispatched.
  setDiffWrapLines: vi.fn((value: boolean) => {
    preferences.diffWrapLines = value;
  }),
  diffIgnoreWhitespace: false,
  setDiffIgnoreWhitespace: vi.fn((value: boolean) => {
    preferences.diffIgnoreWhitespace = value;
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

// The full-file read is a real IPC call, so it is stubbed rather than reaching
// for `window.electron`. Its `enabled` argument is captured: whether the read is
// even requested is the contract the rendered layout depends on.
const { useDiffFileSourceMock } = vi.hoisted(() => ({
  useDiffFileSourceMock: vi.fn(),
}));
vi.mock("../useDiffFileSource", () => ({
  useDiffFileSource: useDiffFileSourceMock,
}));

function sourceEnabledCalls(): boolean[] {
  return useDiffFileSourceMock.mock.calls.map((call) => Boolean(call[1]));
}

import { DiffPane } from "../DiffPane";
import { useDiffNotesStore } from "@/store/diffNotesStore";
import {
  diffNoteFileKey,
  editDraftBodyKey,
  fileDraftBodyKey,
  type DiffNoteDraftSession,
} from "@/components/Worktree/diffNoteDrafts";
import { GridGroupAttentionContext } from "@/components/Panel/gridGroupAttention";
import { GridGroupTabReorderContext } from "@/components/Panel/gridGroupTabReorder";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { actionService } from "@/services/ActionService";
import { keybindingService } from "@/services/KeybindingService";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { sendDiffCommand, type DiffCommand } from "../diffCommands";
import { _resetDiffCacheForTests, peekCachedDiff, requestDiff } from "../diffContentCache";

const PANEL_ID = "diff-1";
const WORKTREE_ID = "wt-1";
const WORKTREE_PATH = "/repo";

function entry(path: string, status: GitStatus = "modified"): DiffChangeSetEntry {
  return { path, status, viewedKey: `working-tree:${path}` };
}

function seedPanel(overrides: Record<string, unknown>): void {
  panelsById[PANEL_ID] = { id: PANEL_ID, kind: "diff", diffSource: "working-tree", ...overrides };
}

function paneElement(isFocused = true, location: "grid" | "dialog" = "dialog") {
  return (
    <DiffPane
      id={PANEL_ID}
      title="pane"
      isFocused={isFocused}
      location={location}
      worktreeId={WORKTREE_ID}
      onFocus={() => {}}
      onClose={() => {}}
    />
  );
}

function renderPane(isFocused = true, location: "grid" | "dialog" = "dialog") {
  return render(paneElement(isFocused, location));
}

const DIFF_ACTION_COMMANDS: Record<string, DiffCommand> = {
  "diff.nextChange": "nextChange",
  "diff.previousChange": "previousChange",
  "diff.nextFile": "nextFile",
  "diff.previousFile": "previousFile",
  "diff.toggleViewed": "toggleViewed",
};

/**
 * A key pressed with focus on `target`, carried the way the app's global key
 * layer carries it: resolved by the real keybinding service in whatever scope
 * is current, and a diff action's command sent to this panel as its action
 * sends it. Returns whether the key reached the pane at all. (Text fields and
 * terminals are kept out by that layer itself, and tested there.)
 */
function pressKey(
  key: string,
  target: HTMLElement = screen.getByTestId("panel-root"),
  init: KeyboardEventInit = {}
): boolean {
  act(() => target.focus());
  const { match } = keybindingService.resolveKeybinding(
    new KeyboardEvent("keydown", { key, ...init })
  );
  const command = match ? DIFF_ACTION_COMMANDS[match.actionId] : undefined;
  if (!command) return false;
  sendCommand(command, PANEL_ID, true);
  return true;
}

/** A command as an action sends it; whether some diff viewer claimed it. */
function sendCommand(command: DiffCommand, id = PANEL_ID, fromKeyboard = false): boolean {
  let delivered = false;
  act(() => {
    delivered = sendDiffCommand({ id, command, fromKeyboard });
  });
  return delivered;
}

/** The stepping shortcuts, pressed with focus on the pane root. */
function pressInPane(key: string): void {
  pressKey(key);
}

function positionText(): string {
  return screen.getByTestId("diff-file-position-indicator").textContent ?? "";
}

beforeEach(() => {
  setDiffPanelFileMock.mockReset();
  toggleViewedMock.mockReset();
  useDiffFileSourceMock.mockReset();
  useDiffFileSourceMock.mockReturnValue({ source: undefined, errorCode: null });
  useDiffContentMock.mockReset();
  useDiffContentMock.mockReturnValue({
    content: "diff --git a/a.ts b/a.ts",
    stale: false,
    retry: vi.fn(),
  });
  viewedKeys.clear();
  viewerOverlay.open = false;
  viewerHunkCount.current = null;
  viewerDrawnFrom.current = 0;
  viewerDraftSessions.clear();
  isImageDiffCandidateMock.mockReset();
  isImageDiffCandidateMock.mockReturnValue(false);
  preferences.diffShowFileList = true;
  preferences.diffViewType = "unified";
  preferences.diffWrapLines = null;
  preferences.setDiffWrapLines.mockClear();
  preferences.diffIgnoreWhitespace = false;
  preferences.setDiffIgnoreWhitespace.mockClear();
  preferences.diffMarkdownRendered = false;
  preferences.diffFullFile = false;
  (preferences.setDiffFullFile as ReturnType<typeof vi.fn>).mockReset();
  (preferences.setDiffMarkdownRendered as ReturnType<typeof vi.fn>).mockReset();
  (preferences.setDiffViewType as ReturnType<typeof vi.fn>).mockReset();
  worktrees.clear();
  worktrees.set(WORKTREE_ID, { path: WORKTREE_PATH, branch: "feature/x" });
});

afterEach(() => {
  for (const key of Object.keys(panelsById)) delete panelsById[key];
  sidebarSelect.mockReset();
});

describe("DiffPane — unsaved note drafts (#16899)", () => {
  function viewerSession(): DiffNoteDraftSession {
    expect(viewerDraftSessions.size).toBe(1);
    return [...viewerDraftSessions][0] as DiffNoteDraftSession;
  }

  afterEach(() => {
    useDiffNotesStore.setState({ notes: {}, editingIds: {} });
  });

  it("keeps the drafts it holds through a refresh that unmounts the viewer", () => {
    seedPanel({ filePath: "a.ts", fileStatus: "modified" });
    const { rerender } = renderPane();
    const session = viewerSession();
    const fileKey = diffNoteFileKey(WORKTREE_PATH, "a.ts");
    act(() => {
      session.openFile(fileKey);
      session.writeBody(fileDraftBodyKey(fileKey), "Half a thought");
      session.openEdit("note-1");
    });
    expect(useDiffNotesStore.getState().editingIds["note-1"]).toBe(1);

    // A refresh drops the diff while it refetches: the skeleton takes the viewer's place.
    useDiffContentMock.mockReturnValue({ content: undefined, stale: false, retry: vi.fn() });
    rerender(paneElement());
    expect(screen.queryByTestId("diff-viewer-mock")).toBeNull();
    expect(useDiffNotesStore.getState().editingIds["note-1"]).toBe(1);

    useDiffContentMock.mockReturnValue({
      content: "diff --git a/a.ts b/a.ts",
      stale: false,
      retry: vi.fn(),
    });
    rerender(paneElement());
    expect(screen.getByTestId("diff-viewer-mock")).toBeTruthy();

    expect(viewerSession()).toBe(session);
    expect(session.getState().files[fileKey]).toBe(true);
    expect(session.readBody(fileDraftBodyKey(fileKey))).toBe("Half a thought");
    expect(session.getState().edits["note-1"]).toBe(true);
  });

  it("lists open drafts in the rendered layout, and carries what's typed there back", async () => {
    useDiffFileSourceMock.mockReturnValue({ source: "# Guide\n", errorCode: null });
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    const note = useDiffNotesStore.getState().addNote({
      worktreePath: WORKTREE_PATH,
      filePath: "docs/guide.md",
      anchor: { kind: "file" },
      body: "Saved words",
    })!;
    const { rerender } = renderPane();
    const session = viewerSession();
    const fileKey = diffNoteFileKey(WORKTREE_PATH, "docs/guide.md");
    act(() => {
      session.openFile(fileKey);
      session.writeBody(fileDraftBodyKey(fileKey), "Half a thought");
      session.openEdit(note.id);
      session.writeBody(editDraftBodyKey(note.id), "Rewritten");
    });

    preferences.diffMarkdownRendered = true;
    rerender(paneElement());
    expect(await screen.findByTestId("rendered-markdown-mock")).toBeTruthy();

    const list = screen.getByTestId("diff-pending-file-notes");
    const draft = within(list).getByLabelText("New file note");
    const edit = within(list).getByLabelText("Edit file note");
    expect(draft instanceof HTMLTextAreaElement && draft.value).toBe("Half a thought");
    expect(edit instanceof HTMLTextAreaElement && edit.value).toBe("Rewritten");
    expect(useDiffNotesStore.getState().editingIds[note.id]).toBe(1);
    fireEvent.change(draft, { target: { value: "Finished in the rendered view" } });

    preferences.diffMarkdownRendered = false;
    rerender(paneElement());
    expect(screen.getByTestId("diff-viewer-mock")).toBeTruthy();
    expect(screen.queryByTestId("diff-pending-file-notes")).toBeNull();
    expect(viewerSession()).toBe(session);
    expect(session.readBody(fileDraftBodyKey(fileKey))).toBe("Finished in the rendered view");
    expect(useDiffNotesStore.getState().editingIds[note.id]).toBe(1);
  });
});

describe("DiffPane — pending notes with no diff table (#17198)", () => {
  function addNote(filePath: string): void {
    useDiffNotesStore.setState({ notes: {}, editingIds: {} });
    useDiffNotesStore.getState().addNote({
      worktreePath: WORKTREE_PATH,
      filePath,
      anchor: { kind: "file" },
      body: "Still pending",
    });
  }

  it("lists the file's notes when a base-branch panel has no base ref", () => {
    addNote("a.ts");
    useDiffContentMock.mockReturnValue({ content: undefined, stale: false, retry: vi.fn() });
    seedPanel({ filePath: "a.ts", fileStatus: "modified", diffSource: "base-branch" });
    renderPane();

    expect(screen.queryByTestId("diff-viewer-mock")).toBeNull();
    expect(screen.getByTestId("diff-pending-file-notes")).toBeTruthy();
  });

  it("lists the file's notes when the since-review notice replaces the body", () => {
    // The cache normally turns these outcomes into a sentinel patch; this pins the
    // predicate itself so a replaced body never hides notes if a patch survives.
    addNote("a.ts");
    useDiffContentMock.mockReturnValue({
      content: "diff --git a/a.ts b/a.ts",
      sinceReview: { status: "none" },
      stale: false,
      retry: vi.fn(),
    });
    seedPanel({ filePath: "a.ts", fileStatus: "modified", diffSource: "since-review" });
    renderPane();

    expect(screen.queryByTestId("diff-viewer-mock")).toBeNull();
    expect(screen.getByTestId("diff-pending-file-notes")).toBeTruthy();
  });
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

  it("separates the staged and unstaged twins of a partially staged file by side", () => {
    // Partial staging: the same path, status and Viewed key in both sections.
    // Only the side tells them apart, so a key match alone resolves the staged copy.
    const changeSet: DiffChangeSetEntry[] = [
      { path: "a.ts", status: "modified", viewedKey: "working-tree:a.ts", side: "staged" },
      { path: "b.ts", status: "modified", viewedKey: "working-tree:b.ts", side: "unstaged" },
      { path: "a.ts", status: "modified", viewedKey: "working-tree:a.ts", side: "unstaged" },
    ];
    seedPanel({
      filePath: "a.ts",
      fileStatus: "modified",
      viewedKey: "working-tree:a.ts",
      fileSide: "unstaged",
      changeSet,
    });
    renderPane();

    expect(positionText()).toBe(`3 of ${changeSet.length}`);
    expect(screen.getByTestId("diff-sidebar-mock").getAttribute("data-current-index")).toBe("2");
    expect(useDiffContentMock.mock.calls.at(-1)![0]?.source).toBe("unstaged");

    // Both twins carry the file's one mark.
    fireEvent.click(screen.getByRole("checkbox", { name: "Viewed" }));
    expect(toggleViewedMock).toHaveBeenCalledWith(WORKTREE_PATH, "working-tree:a.ts");
  });

  it("fetches each twin of a partially staged file from its own side of the index", () => {
    const changeSet: DiffChangeSetEntry[] = [
      { path: "a.ts", status: "modified", viewedKey: "working-tree:a.ts", side: "staged" },
      { path: "a.ts", status: "modified", viewedKey: "working-tree:a.ts", side: "unstaged" },
    ];
    const sourcesFor = (fileSide: "staged" | "unstaged") => {
      useDiffContentMock.mockClear();
      seedPanel({
        filePath: "a.ts",
        fileStatus: "modified",
        viewedKey: "working-tree:a.ts",
        fileSide,
        changeSet,
      });
      renderPane();
      const [subject, nextSubject] = useDiffContentMock.mock.calls.at(-1)!;
      return [subject?.source, nextSubject?.source];
    };

    expect(sourcesFor("staged")).toEqual(["staged", "unstaged"]);
    cleanup();
    expect(sourcesFor("unstaged")[0]).toBe("unstaged");
  });

  it("moves between a partially staged file's twins in a mounted pane as only the side changes", () => {
    const changeSet: DiffChangeSetEntry[] = [
      { path: "a.ts", status: "modified", viewedKey: "working-tree:a.ts", side: "staged" },
      { path: "a.ts", status: "modified", viewedKey: "working-tree:a.ts", side: "unstaged" },
    ];
    const seedSide = (fileSide: "staged" | "unstaged") =>
      seedPanel({
        filePath: "a.ts",
        fileStatus: "modified",
        viewedKey: "working-tree:a.ts",
        fileSide,
        changeSet,
      });
    const currentSide = () => ({
      index: screen.getByTestId("diff-sidebar-mock").getAttribute("data-current-index"),
      source: useDiffContentMock.mock.calls.at(-1)![0]?.source,
    });

    seedSide("staged");
    const { rerender } = renderPane();
    expect(currentSide()).toEqual({ index: "0", source: "staged" });

    seedSide("unstaged");
    rerender(paneElement());
    expect(currentSide()).toEqual({ index: "1", source: "unstaged" });

    seedSide("staged");
    rerender(paneElement());
    expect(currentSide()).toEqual({ index: "0", source: "staged" });
  });

  it("steps between a partially staged file's twins, carrying each one's side", () => {
    const changeSet: DiffChangeSetEntry[] = [
      { path: "a.ts", status: "modified", viewedKey: "working-tree:a.ts", side: "staged" },
      { path: "a.ts", status: "modified", viewedKey: "working-tree:a.ts", side: "unstaged" },
    ];
    seedPanel({
      filePath: "a.ts",
      fileStatus: "modified",
      viewedKey: "working-tree:a.ts",
      fileSide: "staged",
      changeSet,
    });
    renderPane();

    fireEvent.click(screen.getByLabelText("Next file"));
    expect(setDiffPanelFileMock).toHaveBeenCalledWith(
      PANEL_ID,
      "a.ts",
      "modified",
      "working-tree:a.ts",
      "unstaged"
    );
  });

  it("follows the file to its remaining twin once the selected side is gone", () => {
    // The unstaged hunks were staged too, so only the staged entry is left.
    const changeSet: DiffChangeSetEntry[] = [
      entry("b.ts"),
      { path: "a.ts", status: "modified", viewedKey: "working-tree:a.ts", side: "staged" },
    ];
    seedPanel({
      filePath: "a.ts",
      fileStatus: "modified",
      viewedKey: "working-tree:a.ts",
      fileSide: "unstaged",
      changeSet,
    });
    renderPane();

    expect(positionText()).toBe(`2 of ${changeSet.length}`);
    expect(useDiffContentMock.mock.calls.at(-1)![0]?.source).toBe("staged");
  });

  it("leaves entries that name no side on the panel's own source", () => {
    seedPanel({ filePath: "a.ts", fileStatus: "modified", changeSet: [entry("a.ts")] });
    renderPane();

    expect(useDiffContentMock.mock.calls.at(-1)![0]?.source).toBe("working-tree");
  });

  it("falls back to path+status when the cursor names an entry the set no longer has", () => {
    // A restored panel has no cursor at all, and a live one can outlive its
    // entry (the opener rebuilt its set under another key).
    const changeSet = [entry("a.ts"), entry("b.ts", "added")];
    seedPanel({
      filePath: "b.ts",
      fileStatus: "added",
      viewedKey: "since-review:b.ts",
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

    // No place to report, so the count stands alone — and no viewed toggle,
    // since there is no entry to key the marker on.
    expect(positionText()).toBe("2 files");
    expect(screen.queryByLabelText("Viewed")).toBeNull();
    // Opened on a file that was never seen in the set: no gap to step from, so
    // stepping starts at the top.
    pressInPane("]");
    expect(setDiffPanelFileMock).toHaveBeenCalledWith(
      PANEL_ID,
      "a.ts",
      "modified",
      "working-tree:a.ts",
      undefined
    );
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
      changeSet[1]!.viewedKey,
      changeSet[1]!.side
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
      changeSet[1]!.viewedKey,
      changeSet[1]!.side
    );
  });

  // Unavailable, not natively disabled: a focused Next that reaches the last
  // file must keep focus, and a native `disabled` drops it to <body>.
  it("marks the boundary buttons unavailable at each end without making them unfocusable", () => {
    const unavailable = (label: string) => {
      const button = screen.getByLabelText(label);
      expect(button.hasAttribute("disabled")).toBe(false);
      return button.getAttribute("aria-disabled") === "true";
    };
    seedPanel({ filePath: "a.ts", fileStatus: "modified", changeSet });
    const { unmount } = renderPane();
    expect(unavailable("Previous file")).toBe(true);
    expect(unavailable("Next file")).toBe(false);
    unmount();

    seedPanel({ filePath: "c.ts", fileStatus: "modified", changeSet });
    renderPane();
    expect(unavailable("Previous file")).toBe(false);
    expect(unavailable("Next file")).toBe(true);
  });

  it("leaves the keyboard shortcuts inert at both boundaries instead of stepping off the set", () => {
    seedPanel({ filePath: "a.ts", fileStatus: "modified", changeSet });
    const { unmount } = renderPane();

    // `[` is not gated by the button's disabled state, so it is the path that
    // has to stop — a bare index-1 decrement would select undefined.
    pressInPane("[");
    expect(setDiffPanelFileMock).not.toHaveBeenCalled();
    pressInPane("]");
    expect(setDiffPanelFileMock).toHaveBeenCalledWith(
      PANEL_ID,
      "b.ts",
      "added",
      changeSet[1]!.viewedKey,
      changeSet[1]!.side
    );
    unmount();

    setDiffPanelFileMock.mockReset();
    seedPanel({ filePath: "c.ts", fileStatus: "modified", changeSet });
    renderPane();

    pressInPane("]");
    expect(setDiffPanelFileMock).not.toHaveBeenCalled();
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

  it("keeps the gap a shrunk change set leaves at its end", () => {
    // Opened on the 4th file, then a worktree refresh drops the set to 2. The
    // resolved index is now -1 and the remembered place (3) is out of range.
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

    // d.ts sat after both survivors, so nothing lies ahead of it — never index
    // 3 (undefined) or a clamp back onto b.ts.
    pressInPane("]");
    expect(setDiffPanelFileMock).not.toHaveBeenCalled();
    expect(positionText()).toBe("2 files");

    // Behind it is the last survivor, b.ts. Decrementing the remembered 3 after
    // clamping it would land on a.ts and skip b.ts.
    pressInPane("[");
    expect(setDiffPanelFileMock).toHaveBeenCalledWith(
      PANEL_ID,
      "b.ts",
      "modified",
      narrow[1]!.viewedKey,
      narrow[1]!.side
    );
  });
});

describe("DiffPane — stepping in the sidebar's order (#16898)", () => {
  function expectSelected(target: DiffChangeSetEntry): void {
    expect(setDiffPanelFileMock).toHaveBeenCalledTimes(1);
    expect(setDiffPanelFileMock).toHaveBeenCalledWith(
      PANEL_ID,
      target.path,
      target.status,
      target.viewedKey,
      target.side
    );
    setDiffPanelFileMock.mockClear();
  }

  function unavailable(label: string): boolean {
    return screen.getByLabelText(label).getAttribute("aria-disabled") === "true";
  }

  // The sidebar puts root files first, then folders alphabetically; the raw
  // set here is in neither order.
  const zed = entry("src/zed.ts");
  const root = entry("root.ts");
  const lib = entry("lib/lib.ts");
  const unordered = [zed, root, lib];

  it("counts and steps in the sidebar's folder order, not the change set's", () => {
    seedPanel({ filePath: "root.ts", fileStatus: "modified", changeSet: unordered });
    const { rerender } = renderPane();
    expect(positionText()).toBe("1 of 3");
    expect(unavailable("Previous file")).toBe(true);

    fireEvent.click(screen.getByLabelText("Next file"));
    expectSelected(lib);
    // Announced by its place on the shelf; it is last in the raw set.
    expect(useAnnouncerStore.getState().polite?.msg).toBe("lib.ts, file 2 of 3");

    seedPanel({ filePath: "src/zed.ts", fileStatus: "modified", changeSet: unordered });
    rerender(paneElement());
    expect(positionText()).toBe("3 of 3");
    expect(unavailable("Next file")).toBe(true);

    pressInPane("[");
    expectSelected(lib);
  });

  it("steps onto the file that shifted into the open one's place once it leaves the set", () => {
    const a = entry("a.ts");
    const b = entry("b.ts");
    const c = entry("c.ts");
    seedPanel({ filePath: "b.ts", fileStatus: "modified", changeSet: [a, b, c] });
    const { rerender } = renderPane();
    expect(positionText()).toBe("2 of 3");

    // Staged or reverted: b.ts is gone, c.ts now sits where it was.
    seedPanel({ filePath: "b.ts", fileStatus: "modified", changeSet: [a, c] });
    rerender(paneElement());

    expect(positionText()).toBe("2 files");
    expect(unavailable("Previous file")).toBe(false);
    expect(unavailable("Next file")).toBe(false);

    expect(useDiffContentMock.mock.calls.at(-1)![1]?.filePath).toBe("c.ts");
    pressInPane("]");
    expectSelected(c);
    fireEvent.click(screen.getByLabelText("Next file"));
    expectSelected(c);
    pressInPane("[");
    expectSelected(a);
    fireEvent.click(screen.getByLabelText("Previous file"));
    expectSelected(a);
  });

  it("warms the file the stepper would open next, in the sidebar's order", () => {
    // lib/lib.ts is last in the raw set, so raw order has nothing after it.
    seedPanel({ filePath: "lib/lib.ts", fileStatus: "modified", changeSet: unordered });
    renderPane();

    expect(useDiffContentMock.mock.calls.at(-1)![1]?.filePath).toBe("src/zed.ts");
  });

  describe("with the sidebar's filter", () => {
    const one = entry("src/one.ts");
    const two = entry("src/two.ts");
    const other = entry("lib/other.ts");
    const three = entry("src/three.ts");
    // Display order: lib/other.ts, src/one.ts, src/two.ts, src/three.ts.
    const files = [one, two, other, three];

    function filterTo(query: string): void {
      fireEvent.change(screen.getByTestId("diff-sidebar-filter"), { target: { value: query } });
    }

    it("counts and steps only through the files the filter shows", () => {
      seedPanel({ filePath: "src/one.ts", fileStatus: "modified", changeSet: files });
      const { rerender } = renderPane();
      filterTo("o");
      // other.ts, one.ts and two.ts match; three.ts does not.
      expect(positionText()).toBe("2 of 3");

      fireEvent.click(screen.getByLabelText("Next file"));
      expectSelected(two);

      seedPanel({ filePath: "src/two.ts", fileStatus: "modified", changeSet: files });
      rerender(paneElement());
      expect(positionText()).toBe("3 of 3");
      expect(unavailable("Next file")).toBe(true);
      pressInPane("]");
      expect(setDiffPanelFileMock).not.toHaveBeenCalled();
    });

    it("steps from where a file the filter hides sits to the nearest shown ones", () => {
      seedPanel({ filePath: "src/two.ts", fileStatus: "modified", changeSet: files });
      renderPane();
      filterTo("h");
      // other.ts and three.ts match, on either side of two.ts.
      expect(positionText()).toBe("2 files");

      pressInPane("[");
      expectSelected(other);
      pressInPane("]");
      expectSelected(three);
    });

    it("leaves both directions inert when the filter matches nothing", () => {
      seedPanel({ filePath: "src/two.ts", fileStatus: "modified", changeSet: files });
      renderPane();
      filterTo("zzz");

      expect(positionText()).toBe("0 files");
      expect(unavailable("Previous file")).toBe(true);
      expect(unavailable("Next file")).toBe(true);
      pressInPane("]");
      pressInPane("[");
      expect(setDiffPanelFileMock).not.toHaveBeenCalled();
    });

    it("stands the filter down while the sidebar is hidden and restores it when shown", () => {
      seedPanel({ filePath: "src/one.ts", fileStatus: "modified", changeSet: files });
      const { rerender } = renderPane();
      filterTo("src/");
      expect(positionText()).toBe("1 of 3");

      // Hidden from another pane: the preference is shared.
      preferences.diffShowFileList = false;
      rerender(paneElement());
      expect(positionText()).toBe("2 of 4");

      preferences.diffShowFileList = true;
      rerender(paneElement());
      expect((screen.getByTestId("diff-sidebar-filter") as HTMLInputElement).value).toBe("src/");
      expect(positionText()).toBe("1 of 3");
    });
  });

  it("keeps a stepper to reach the one file left after the open one leaves", () => {
    const a = entry("a.ts");
    const b = entry("b.ts");
    seedPanel({ filePath: "b.ts", fileStatus: "modified", changeSet: [a, b] });
    const { rerender } = renderPane();
    // A filter that hides the survivor: once the shelf goes with the
    // workspace, its filter must go with it.
    fireEvent.change(screen.getByTestId("diff-sidebar-filter"), { target: { value: "b" } });
    expect(positionText()).toBe("1 of 1");

    seedPanel({ filePath: "b.ts", fileStatus: "modified", changeSet: [a] });
    rerender(paneElement());

    expect(positionText()).toBe("1 file");
    expect(unavailable("Next file")).toBe(true);
    fireEvent.click(screen.getByLabelText("Previous file"));
    expectSelected(a);
  });

  it("keeps the gap when an opener re-aims the pane at the missing file under another cursor", () => {
    const a = entry("a.ts");
    const b: DiffChangeSetEntry = { ...entry("b.ts"), side: "staged" };
    const c = entry("c.ts");
    seedPanel({
      filePath: "b.ts",
      fileStatus: "modified",
      viewedKey: b.viewedKey,
      fileSide: "staged",
      changeSet: [a, b, c],
    });
    const { rerender } = renderPane();

    // Committed: the Review Hub falls back to the selection it first opened,
    // re-aiming the pane at b.ts with that one's status and side.
    seedPanel({
      filePath: "b.ts",
      fileStatus: "added",
      viewedKey: b.viewedKey,
      fileSide: "unstaged",
      changeSet: [a, c],
    });
    rerender(paneElement());

    pressInPane("]");
    expectSelected(c);
  });

  it("gives a pane sent to another missing file none of the last file's history", () => {
    const a = entry("a.ts");
    const b = entry("b.ts");
    const c = entry("c.ts");
    seedPanel({ filePath: "c.ts", fileStatus: "modified", changeSet: [a, b, c] });
    const { rerender } = renderPane();

    // Retargeted by an opener to a file the set doesn't hold: there is no gap
    // of its own, so stepping starts from the top rather than from c.ts's.
    seedPanel({ filePath: "elsewhere.ts", fileStatus: "modified", changeSet: [a, b, c] });
    rerender(paneElement());

    expect(unavailable("Previous file")).toBe(true);
    pressInPane("]");
    expectSelected(a);
  });
});

describe("DiffPane — file keys across the whole pane (#16643)", () => {
  const changeSet = [entry("a.ts"), entry("b.ts", "added"), entry("c.ts")];

  /** Exactly one step since the last check, and to `changeSet[index]`. */
  function expectStepTo(index: number): void {
    const target = changeSet[index]!;
    expect(setDiffPanelFileMock).toHaveBeenCalledTimes(1);
    expect(setDiffPanelFileMock).toHaveBeenCalledWith(
      PANEL_ID,
      target.path,
      target.status,
      target.viewedKey,
      target.side
    );
    setDiffPanelFileMock.mockClear();
  }

  /** Where the store's setter would leave the panel after a step to `index`. */
  function seedAt(index: number): void {
    const target = changeSet[index]!;
    seedPanel({
      filePath: target.path,
      fileStatus: target.status,
      viewedKey: target.viewedKey,
      changeSet,
    });
  }

  it.each(["grid", "dialog"] as const)(
    "keeps stepping from the footer buttons the keys are advertised on (%s)",
    (location) => {
      seedAt(0);
      const { rerender } = renderPane(true, location);
      const next = screen.getByRole("button", { name: "Next file" });
      next.focus();
      fireEvent.click(next);
      expectStepTo(1);
      seedAt(1);
      rerender(paneElement(true, location));
      expect(document.activeElement).toBe(next);

      pressKey("]", next);
      expectStepTo(2);
      pressKey("[", screen.getByRole("button", { name: "Previous file" }));
      expectStepTo(0);
      pressKey("v", next);
      expect(toggleViewedMock).toHaveBeenCalledTimes(1);
      expect(toggleViewedMock).toHaveBeenCalledWith(WORKTREE_PATH, changeSet[1]!.viewedKey);
    }
  );

  it.each(["grid", "dialog"] as const)(
    "toggles Viewed and steps from the footer's Viewed checkbox (%s)",
    (location) => {
      seedAt(0);
      renderPane(true, location);
      const viewed = screen.getByRole("checkbox", { name: "Viewed" });
      fireEvent.click(viewed);
      expect(toggleViewedMock).toHaveBeenCalledTimes(1);

      pressKey("v", viewed);
      expect(toggleViewedMock).toHaveBeenCalledTimes(2);
      expect(toggleViewedMock).toHaveBeenLastCalledWith(WORKTREE_PATH, changeSet[0]!.viewedKey);
      pressKey("]", viewed);
      expectStepTo(1);
    }
  );

  it.each(["grid", "dialog"] as const)(
    "steps from the pane root, where focus lands when the pane is focused (%s)",
    (location) => {
      seedAt(1);
      renderPane(true, location);

      pressKey("]");
      expectStepTo(2);
      pressKey("[");
      expectStepTo(0);
    }
  );

  it("steps from the header toolbar's controls", () => {
    seedAt(1);
    renderPane();

    pressKey("]", screen.getByRole("button", { name: "Wrap long lines" }));
    expectStepTo(2);
    const split = within(screen.getByRole("radiogroup", { name: "Diff layout" })).getByRole(
      "radio",
      { name: "Split" }
    );
    pressKey("[", split);
    expectStepTo(0);
  });

  it("keeps the footer on the toolbar's 8px inset and divider", () => {
    seedAt(0);
    renderPane();

    const footer = screen.getByTestId("diff-pane-footer");
    expect(footer.classList.contains("px-2")).toBe(true);
    expect(footer.classList.contains("border-t")).toBe(true);
    expect(footer.classList.contains("border-divider")).toBe(true);
    expect(footer.classList.contains("border-border-strong")).toBe(false);
  });

  it("marks the focused shelf row's file viewed rather than the open one", () => {
    seedAt(0);
    renderPane();

    pressKey("v", screen.getByTestId("diff-sidebar-row"));

    // The row stands for c.ts; the pane's open file, a.ts, is left alone.
    expect(toggleViewedMock).toHaveBeenCalledTimes(1);
    expect(toggleViewedMock).toHaveBeenCalledWith(WORKTREE_PATH, changeSet[2]!.viewedKey);
  });

  it("holds the diff scope only while focus is inside the pane", () => {
    seedAt(1);
    renderPane();
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      act(() => screen.getByTestId("panel-root").focus());
      expect(keybindingService.getScope()).toBe("diff");
      act(() => outside.focus());
      expect(keybindingService.getScope()).toBe("global");
      expect(pressKey("]", outside)).toBe(false);
      expect(setDiffPanelFileMock).not.toHaveBeenCalled();
    } finally {
      outside.remove();
    }
  });

  it("leaves keys pressed in an overlay the pane opened alone", () => {
    viewerOverlay.open = true;
    seedAt(1);
    renderPane();
    const item = screen.getByRole("menuitem", { name: "Overlay item" });
    expect(screen.getByTestId("panel-root").contains(item)).toBe(false);
    act(() => screen.getByTestId("panel-root").focus());
    expect(keybindingService.getScope()).toBe("diff");

    // Portalled outside the pane, so focus moving there gives the scope back
    // and a menu's typeahead keeps its letters.
    act(() => item.focus());
    expect(keybindingService.getScope()).toBe("global");
    for (const key of ["[", "]", "v", "n", "p"]) expect(pressKey(key, item)).toBe(false);

    expect(setDiffPanelFileMock).not.toHaveBeenCalled();
    expect(toggleViewedMock).not.toHaveBeenCalled();
  });

  it("stays inert everywhere in a background pane", () => {
    seedAt(1);
    renderPane(false);

    expect(pressKey("]")).toBe(false);
    expect(pressKey("]", screen.getByRole("button", { name: "Next file" }))).toBe(false);
    expect(pressKey("v", screen.getByRole("checkbox", { name: "Viewed" }))).toBe(false);

    expect(setDiffPanelFileMock).not.toHaveBeenCalled();
    expect(toggleViewedMock).not.toHaveBeenCalled();
  });

  it("follows the pane's focus as it leaves and returns", () => {
    seedAt(1);
    const { rerender } = renderPane();
    const press = () => pressKey("]", screen.getByRole("button", { name: "Next file" }));

    rerender(paneElement(false));
    press();
    expect(setDiffPanelFileMock).not.toHaveBeenCalled();

    rerender(paneElement(true));
    press();
    expectStepTo(2);
  });

  it("leaves modified chords to the app", () => {
    seedAt(1);
    renderPane();

    // Ctrl and Alt are extra modifiers on every platform. (Meta counts only on
    // macOS: the keybinding service ignores the Windows key everywhere.)
    expect(pressKey("]", undefined, { ctrlKey: true })).toBe(false);
    expect(pressKey("[", undefined, { ctrlKey: true })).toBe(false);
    expect(pressKey("v", undefined, { altKey: true })).toBe(false);

    expect(setDiffPanelFileMock).not.toHaveBeenCalled();
    expect(toggleViewedMock).not.toHaveBeenCalled();
  });

  it("acts only on commands addressed to this panel, and claims the ones it takes", () => {
    seedAt(1);
    renderPane();

    expect(sendCommand("nextFile", "another-diff")).toBe(false);
    expect(sendCommand("toggleViewed", "another-diff")).toBe(false);
    expect(setDiffPanelFileMock).not.toHaveBeenCalled();
    expect(toggleViewedMock).not.toHaveBeenCalled();

    expect(sendCommand("nextFile")).toBe(true);
    expectStepTo(2);
  });

  it("marks the open file, not a focused shelf row, for a Viewed that wasn't a key", () => {
    seedAt(0);
    renderPane();
    act(() => screen.getByTestId("diff-sidebar-row").focus());

    // The palette or an agent: whatever happens to hold focus says nothing.
    sendCommand("toggleViewed");

    expect(toggleViewedMock).toHaveBeenCalledTimes(1);
    expect(toggleViewedMock).toHaveBeenCalledWith(WORKTREE_PATH, changeSet[0]!.viewedKey);
  });

  it("takes the diff scope back when another scope is pushed over it", () => {
    seedAt(1);
    renderPane();
    act(() => screen.getByTestId("panel-root").focus());
    expect(keybindingService.getScope()).toBe("diff");

    // An expanded worktree card mounting as the sidebar scrolls.
    act(() => keybindingService.setScope("worktreeGrid"));
    try {
      expect(keybindingService.getScope()).toBe("diff");
      expect(pressKey("]")).toBe(true);
      expectStepTo(2);
    } finally {
      act(() => keybindingService.restoreScope("worktreeGrid"));
    }
  });

  it("names the file a step lands on for a screen reader", () => {
    seedAt(0);
    renderPane();
    pressKey("]");
    expect(useAnnouncerStore.getState().polite?.msg).toBe("b.ts, file 2 of 3");
  });
});

describe("DiffPane — hunk stepping (#17326)", () => {
  const changeSet = [entry("a.ts"), entry("b.ts", "added"), entry("c.ts")];

  function seedAt(index: number): void {
    const target = changeSet[index]!;
    seedPanel({
      filePath: target.path,
      fileStatus: target.status,
      viewedKey: target.viewedKey,
      changeSet,
    });
  }

  function seedSingle(): void {
    seedPanel({ filePath: "a.ts", fileStatus: "modified" });
  }

  function withContent(content: string | undefined): void {
    useDiffContentMock.mockReturnValue({ content, stale: false, retry: vi.fn() });
  }

  function stepperText(): string | null {
    return screen.queryByRole("group", { name: "Hunks" })?.textContent || null;
  }

  function revealed(): number | null {
    const value = screen.getByTestId("diff-viewer-mock").getAttribute("data-reveal-index");
    return value === null ? null : Number(value);
  }

  function expectSelected(index: number): void {
    const target = changeSet[index]!;
    expect(setDiffPanelFileMock).toHaveBeenCalledTimes(1);
    expect(setDiffPanelFileMock).toHaveBeenCalledWith(
      PANEL_ID,
      target.path,
      target.status,
      target.viewedKey,
      target.side
    );
    setDiffPanelFileMock.mockClear();
  }

  it.each(["unified", "split"] as const)(
    "steps through a file's hunks with the keys and says where it is (%s)",
    (viewType) => {
      preferences.diffViewType = viewType;
      viewerHunkCount.current = 3;
      seedSingle();
      renderPane();
      expect(stepperText()).toBe("1 of 3");
      expect(revealed()).toBe(null);

      pressInPane("n");
      expect(revealed()).toBe(1);
      expect(stepperText()).toBe("2 of 3");
      pressInPane("n");
      expect(revealed()).toBe(2);
      expect(stepperText()).toBe("3 of 3");
      pressInPane("p");
      expect(revealed()).toBe(1);
      expect(stepperText()).toBe("2 of 3");
    }
  );

  it("takes the stepper's arrows down the same path as the keys", () => {
    viewerHunkCount.current = 3;
    seedSingle();
    renderPane();

    fireEvent.click(screen.getByRole("button", { name: "Next hunk" }));
    expect(revealed()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Next hunk" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous hunk" }));
    expect(revealed()).toBe(1);
    expect(stepperText()).toBe("2 of 3");
  });

  it("stops at both ends of a single-file diff, a list of one", () => {
    viewerHunkCount.current = 2;
    seedSingle();
    renderPane();
    const arrow = (name: string) =>
      screen.getByRole("button", { name }).getAttribute("aria-disabled") === "true";
    expect(arrow("Previous hunk")).toBe(true);

    pressInPane("p");
    expect(revealed()).toBe(null);
    pressInPane("n");
    pressInPane("n");
    expect(revealed()).toBe(1);
    expect(stepperText()).toBe("2 of 2");
    expect(arrow("Next hunk")).toBe(true);
    expect(setDiffPanelFileMock).not.toHaveBeenCalled();
  });

  it("runs on into the next file and lands on its first hunk", () => {
    viewerHunkCount.current = 2;
    seedAt(0);
    withContent("diff --git a/a.ts b/a.ts\n@@ a @@");
    const { rerender } = renderPane();

    pressInPane("n");
    pressInPane("n");
    expectSelected(1);
    expect(useAnnouncerStore.getState().polite?.msg).toBe("b.ts, file 2 of 3");

    // The store moves the pane; b.ts holds four hunks.
    viewerHunkCount.current = 4;
    seedAt(1);
    withContent("diff --git a/b.ts b/b.ts\n@@ b @@");
    rerender(paneElement());
    expect(revealed()).toBe(0);
    expect(stepperText()).toBe("1 of 4");
  });

  it("runs back into the previous file and lands on its last hunk, then forward again", () => {
    viewerHunkCount.current = 2;
    seedAt(1);
    withContent("diff --git a/b.ts b/b.ts\n@@ b @@");
    const { rerender } = renderPane();

    pressInPane("p");
    expectSelected(0);

    viewerHunkCount.current = 5;
    seedAt(0);
    withContent("diff --git a/a.ts b/a.ts\n@@ a @@");
    rerender(paneElement());
    expect(revealed()).toBe(4);
    expect(stepperText()).toBe("5 of 5");

    // Overshooting is one key back: `n` from a.ts's last hunk returns to b.ts.
    pressInPane("n");
    expectSelected(1);
  });

  it("waits for the destination's hunks, and a key meanwhile can't cross again", () => {
    viewerHunkCount.current = 1;
    seedAt(0);
    withContent("diff --git a/a.ts b/a.ts\n@@ a @@");
    const { rerender } = renderPane();

    pressInPane("n");
    expectSelected(1);

    // b.ts is still being read.
    seedAt(1);
    withContent(undefined);
    rerender(paneElement());
    pressInPane("n");
    expect(setDiffPanelFileMock).not.toHaveBeenCalled();

    viewerHunkCount.current = 3;
    withContent("diff --git a/b.ts b/b.ts\n@@ b @@");
    rerender(paneElement());
    expect(revealed()).toBe(0);
    expect(stepperText()).toBe("1 of 3");
  });

  it("drops the landing when the pane ends up on some other file first", () => {
    viewerHunkCount.current = 1;
    seedAt(1);
    withContent("diff --git a/b.ts b/b.ts\n@@ b @@");
    const { rerender } = renderPane();

    pressInPane("p");
    expectSelected(0);

    // An opener re-aims the pane at c.ts before a.ts ever lands.
    viewerHunkCount.current = 3;
    seedAt(2);
    withContent("diff --git a/c.ts b/c.ts\n@@ c @@");
    rerender(paneElement());
    expect(revealed()).toBe(null);
    expect(stepperText()).toBe("1 of 3");
  });

  it("treats a file with nothing to step through as one stop", () => {
    viewerHunkCount.current = 1;
    seedAt(0);
    withContent("diff --git a/a.ts b/a.ts\n@@ a @@");
    const { rerender } = renderPane();
    pressInPane("n");
    expectSelected(1);

    // b.ts has no changes to show: no count, but the arrows still cross.
    seedAt(1);
    withContent("NO_CHANGES");
    rerender(paneElement());
    expect(stepperText()).toBe(null);
    expect(screen.getByRole("button", { name: "Next hunk" })).toBeTruthy();

    pressInPane("n");
    expectSelected(2);
  });

  it("never replays a step onto content that refreshed under it", () => {
    viewerHunkCount.current = 3;
    seedSingle();
    withContent("diff --git a/a.ts b/a.ts\n@@ one @@");
    const { rerender } = renderPane();
    pressInPane("n");
    expect(revealed()).toBe(1);

    withContent("diff --git a/a.ts b/a.ts\n@@ two @@");
    rerender(paneElement());
    expect(revealed()).toBe(null);
    // The same file keeps its place in the count.
    expect(stepperText()).toBe("2 of 3");
  });

  describe("following the reader's own scrolling", () => {
    let restore: (() => void)[] = [];
    afterEach(() => {
      for (const undo of restore) undo();
      restore = [];
    });

    function layOut(tops: number[]): void {
      const root = document.querySelector<HTMLElement>(".diff-scroll-root")!;
      Object.defineProperty(root, "clientHeight", { configurable: true, value: 600 });
      root.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
      root.querySelectorAll<HTMLElement>("tr.diff-hunk-anchor").forEach((row, index) => {
        row.getBoundingClientRect = () => ({ top: tops[index]! }) as DOMRect;
      });
    }

    // Frames queue as a browser's do, and run when a scroll has been handled.
    let frames: FrameRequestCallback[] = [];
    function scroll(): void {
      const root = document.querySelector<HTMLElement>(".diff-scroll-root")!;
      act(() => {
        root.dispatchEvent(new Event("scroll"));
        const due = frames;
        frames = [];
        for (const frame of due) frame(0);
      });
    }

    beforeEach(() => {
      frames = [];
      const request = window.requestAnimationFrame;
      const cancel = window.cancelAnimationFrame;
      window.requestAnimationFrame = (callback) => frames.push(callback);
      window.cancelAnimationFrame = () => {};
      restore.push(() => {
        window.requestAnimationFrame = request;
        window.cancelAnimationFrame = cancel;
      });
    });

    it("counts the hunk whose first change has passed the top third", () => {
      viewerHunkCount.current = 3;
      seedSingle();
      renderPane();

      layOut([-500, 150, 700]);
      scroll();
      expect(stepperText()).toBe("2 of 3");
      layOut([-900, -250, 250]);
      scroll();
      expect(stepperText()).toBe("2 of 3");
      layOut([-900, -600, 100]);
      scroll();
      expect(stepperText()).toBe("3 of 3");
    });

    it("holds a step's landing until the reader scrolls by hand", () => {
      viewerHunkCount.current = 3;
      seedSingle();
      renderPane();

      // The last hunk can't reach the top: the browser stops the scroll short.
      pressInPane("n");
      pressInPane("n");
      layOut([-900, 50, 400]);
      scroll();
      expect(stepperText()).toBe("3 of 3");

      act(() => {
        document.querySelector(".diff-scroll-root")!.dispatchEvent(new Event("wheel"));
      });
      // Taking the scroll back withdraws the step, so nothing lands later.
      expect(revealed()).toBe(null);
      scroll();
      expect(stepperText()).toBe("2 of 3");
    });

    it("numbers anchors within their file, past a collapsed one before them", () => {
      // A type change's patch: the first file, holding hunk 0, is drawn collapsed.
      viewerHunkCount.current = 3;
      viewerDrawnFrom.current = 1;
      seedSingle();
      renderPane();

      layOut([-100, 400]);
      scroll();
      expect(stepperText()).toBe("2 of 3");
    });

    it("lets a refreshed patch end a step's hold", () => {
      viewerHunkCount.current = 3;
      seedSingle();
      withContent("diff --git a/a.ts b/a.ts\n@@ one @@");
      const { rerender } = renderPane();
      pressInPane("n");
      pressInPane("n");
      expect(stepperText()).toBe("3 of 3");

      // The refresh put the viewport back near the top.
      withContent("diff --git a/a.ts b/a.ts\n@@ two @@");
      rerender(paneElement());
      layOut([50, 400, 800]);
      scroll();
      expect(stepperText()).toBe("1 of 3");
    });
  });

  it("says where each deliberate step landed", () => {
    viewerHunkCount.current = 3;
    seedSingle();
    renderPane();

    pressInPane("n");
    expect(useAnnouncerStore.getState().polite?.msg).toBe("Hunk 2 of 3");
    // The count itself stays quiet, or hand scrolling would narrate it.
    expect(screen.getByRole("group", { name: "Hunks" }).querySelector("[aria-live]")).toBe(null);
  });

  it("keeps the arrows, unavailable, while the destination of a crossing loads", () => {
    viewerHunkCount.current = 1;
    seedAt(0);
    withContent("diff --git a/a.ts b/a.ts\n@@ a @@");
    const { rerender } = renderPane();
    const next = screen.getByRole("button", { name: "Next hunk" });
    fireEvent.click(next);
    expectSelected(1);

    seedAt(1);
    withContent(undefined);
    rerender(paneElement());
    const arrow = screen.getByRole("button", { name: "Next hunk" });
    expect(arrow).toBe(next);
    expect(arrow.getAttribute("aria-disabled")).toBe("true");
  });

  it("drops the landing once the pane returns to the file it left", () => {
    viewerHunkCount.current = 1;
    seedAt(1);
    withContent("diff --git a/b.ts b/b.ts\n@@ b @@");
    const { rerender } = renderPane();
    pressInPane("p");
    expectSelected(0);

    // a.ts starts loading, then an opener re-aims the pane at b.ts…
    seedAt(0);
    withContent(undefined);
    rerender(paneElement());
    seedAt(1);
    withContent("diff --git a/b.ts b/b.ts\n@@ b @@");
    rerender(paneElement());

    // …and a later, unrelated open of a.ts lands at its top, not its last hunk.
    viewerHunkCount.current = 4;
    seedAt(0);
    withContent("diff --git a/a.ts b/a.ts\n@@ a @@");
    rerender(paneElement());
    expect(revealed()).toBe(null);
    expect(stepperText()).toBe("1 of 4");
  });

  it("waits out a pending whole-file read before landing in Full file", () => {
    preferences.diffFullFile = true;
    viewerHunkCount.current = 1;
    seedAt(1);
    withContent("diff --git a/b.ts b/b.ts\n@@ b @@");
    const { rerender } = renderPane();
    pressInPane("p");
    expectSelected(0);

    // a.ts's patch is in, but the read that reflows it isn't.
    viewerHunkCount.current = 3;
    useDiffFileSourceMock.mockReturnValue({ source: undefined, errorCode: null });
    seedAt(0);
    withContent("diff --git a/a.ts b/a.ts\n@@ a @@");
    rerender(paneElement());
    expect(revealed()).toBe(null);

    useDiffFileSourceMock.mockReturnValue({ source: "a\n", errorCode: null });
    rerender(paneElement());
    expect(revealed()).toBe(2);
  });

  it("treats a comparison that can't be asked for as one stop", () => {
    viewerHunkCount.current = 1;
    seedAt(0);
    withContent("diff --git a/a.ts b/a.ts\n@@ a @@");
    const { rerender } = renderPane();
    pressInPane("n");
    expectSelected(1);

    // The worktree went away: no request will ever be made for b.ts.
    worktrees.clear();
    seedAt(1);
    withContent(undefined);
    rerender(paneElement());
    pressInPane("n");
    expectSelected(2);
  });

  it("keeps focus in the pane when a step swaps the body it sat in", () => {
    viewerHunkCount.current = 1;
    seedAt(0);
    withContent("diff --git a/a.ts b/a.ts\n@@ a @@");
    renderPane();

    pressKey("n", screen.getByTestId("diff-viewer-region"));
    expectSelected(1);
    expect(document.activeElement).toBe(screen.getByTestId("panel-root"));
    expect(keybindingService.getScope()).toBe("diff");
  });

  it("walks rendered changes without wrapping at the ends", async () => {
    preferences.diffMarkdownRendered = true;
    useDiffFileSourceMock.mockReturnValue({ source: "# Guide\n", errorCode: null });
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    withContent("diff --git a/docs/guide.md b/docs/guide.md\n@@ x @@");
    renderPane();
    const view = await screen.findByTestId("rendered-markdown-mock");
    act(() => renderedProps.current?.onChangeCount?.(2, view.getAttribute("data-attempt-key")!));
    const text = () => screen.getByRole("group", { name: "Changes" }).textContent;
    expect(text()).toBe("1 of 2");

    pressInPane("n");
    expect(text()).toBe("2 of 2");
    // The fourth Next used to wrap to the first; a single-file diff ends here.
    pressInPane("n");
    expect(text()).toBe("2 of 2");
    pressInPane("p");
    pressInPane("p");
    expect(text()).toBe("1 of 2");
  });
});

describe("DiffPane — tab group edges (#16151)", () => {
  function inGroup(panelId: string) {
    return (
      <GridGroupAttentionContext.Provider
        value={{ panelId, ambientAgentState: "waiting", hiddenTabFailed: true }}
      >
        <DiffPane
          id={PANEL_ID}
          title="pane"
          isFocused={false}
          location="grid"
          worktreeId={WORKTREE_ID}
          onFocus={() => {}}
          onClose={() => {}}
        />
      </GridGroupAttentionContext.Provider>
    );
  }

  it("draws its tab group's edge for a hidden tab's ask and failure", () => {
    seedPanel({ filePath: "a.ts", fileStatus: "modified", changeSet: [entry("a.ts")] });
    const { rerender } = render(inGroup(PANEL_ID));
    const edge = () => screen.getByTestId("group-edge");
    expect(edge().getAttribute("data-group-ambient")).toBe("waiting");
    expect(edge().getAttribute("data-group-failed")).toBe("true");

    rerender(inGroup("other"));
    expect(edge().hasAttribute("data-group-ambient")).toBe(false);
    expect(edge().hasAttribute("data-group-failed")).toBe(false);
  });
});

describe("DiffPane — tab reorder (#16160)", () => {
  const tabs = ["diff-1", "t-2"].map((id) => ({
    id,
    title: id,
    chrome: deriveTerminalChrome(),
    kind: id === PANEL_ID ? "diff" : "terminal",
    isActive: id === PANEL_ID,
  }));

  function inGroup(panelId: string, onTabReorder: (order: string[]) => void) {
    return (
      <GridGroupTabReorderContext.Provider value={{ panelId, groupId: "g-1", onTabReorder }}>
        <DiffPane
          id={PANEL_ID}
          title="pane"
          isFocused={false}
          location="grid"
          worktreeId={WORKTREE_ID}
          onFocus={() => {}}
          onClose={() => {}}
          tabs={tabs}
        />
      </GridGroupTabReorderContext.Provider>
    );
  }

  it("reorders its tab group's tabs from its own strip", () => {
    seedPanel({ filePath: "a.ts", fileStatus: "modified", changeSet: [entry("a.ts")] });
    const onTabReorder = vi.fn();
    render(inGroup(PANEL_ID, onTabReorder));
    const probe = screen.getByTestId("group-reorder");
    expect(probe.getAttribute("data-group-id")).toBe("g-1");

    fireEvent.click(probe);
    expect(onTabReorder).toHaveBeenCalledWith(["t-2", "diff-1"]);
  });

  it("takes no reorder meant for another tab", () => {
    seedPanel({ filePath: "a.ts", fileStatus: "modified", changeSet: [entry("a.ts")] });
    const onTabReorder = vi.fn();
    render(inGroup("other", onTabReorder));
    const probe = screen.getByTestId("group-reorder");
    expect(probe.hasAttribute("data-group-id")).toBe(false);

    fireEvent.click(probe);
    expect(onTabReorder).not.toHaveBeenCalled();
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
    expect(screen.getByLabelText(/^Copy file path/)).toBeTruthy();
    expect(screen.getByLabelText("Refresh")).toBeTruthy();
  });

  it("hands each twin of a partially staged image its own side of the index", () => {
    isImageDiffCandidateMock.mockReturnValue(true);
    const changeSet: DiffChangeSetEntry[] = [
      { path: "logo.png", status: "modified", viewedKey: "working-tree:logo.png", side: "staged" },
      {
        path: "logo.png",
        status: "modified",
        viewedKey: "working-tree:logo.png",
        side: "unstaged",
      },
    ];
    const sideFor = (fileSide: "staged" | "unstaged") => {
      cleanup();
      seedPanel({
        filePath: "logo.png",
        fileStatus: "modified",
        viewedKey: "working-tree:logo.png",
        fileSide,
        changeSet,
      });
      renderPane();
      return screen.getByTestId("image-diff-mock").getAttribute("data-side");
    };

    expect(sideFor("staged")).toBe("staged");
    expect(sideFor("unstaged")).toBe("unstaged");
  });

  it("names no side for a plain working-tree image, even beside sided entries", () => {
    isImageDiffCandidateMock.mockReturnValue(true);
    seedPanel({ filePath: "logo.png", fileStatus: "modified", changeSet: [entry("logo.png")] });
    renderPane();
    expect(screen.getByTestId("image-diff-mock").getAttribute("data-side")).toBe("none");

    // The open file isn't in the set, so no entry's side is its own.
    cleanup();
    seedPanel({
      filePath: "logo.png",
      fileStatus: "modified",
      changeSet: [{ ...entry("other.png"), side: "staged" }],
    });
    renderPane();
    expect(screen.getByTestId("image-diff-mock").getAttribute("data-side")).toBe("none");
  });

  it.each(["staged", "unstaged"] as const)(
    "keeps a %s panel's own side over its entry's",
    (diffSource) => {
      isImageDiffCandidateMock.mockReturnValue(true);
      const entrySide = diffSource === "staged" ? "unstaged" : "staged";
      seedPanel({
        filePath: "logo.png",
        fileStatus: "modified",
        diffSource,
        changeSet: [{ ...entry("logo.png"), side: entrySide }],
      });
      renderPane();
      expect(screen.getByTestId("image-diff-mock").getAttribute("data-side")).toBe(diffSource);
    }
  );

  it("keeps them for a base-branch image, which the text viewer still handles", () => {
    // ImageDiffViewer compares local versions (HEAD, the index, the working
    // tree), so it has nothing to show for a base-branch comparison — those stay on DiffViewer whatever
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
  const realFetch = globalThis.fetch;
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
    vi.stubGlobal("fetch", realFetch);
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

    expect(screen.queryByRole("radio", { name: "Unified" })).toBeNull();
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
    // Not a dead end: the OS app plays codecs Chromium can't.
    const unavailable = container.querySelector('[data-testid="diff-pane-unavailable"]');
    expect(unavailable?.getAttribute("role")).toBe("status");
    expect(
      Array.from(unavailable?.querySelectorAll("button") ?? []).some(
        (button) => button.textContent?.trim() === "Open in default app"
      )
    ).toBe(true);
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
  const realFetch = globalThis.fetch;
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
    vi.stubGlobal("fetch", realFetch);
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
  // The frame mounts only once a HEAD on its URL answers 200 (#12598). Only
  // `fetch` is restored: `vi.unstubAllGlobals()` would also strip what
  // vitest.setup.ts installs for every later test.
  const pdfProbeMock = vi.fn();
  const realFetch = globalThis.fetch;
  let dispatchSpy: { mockRestore: () => void } | null = null;
  beforeEach(() => {
    pdfProbeMock.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", pdfProbeMock);
  });
  afterEach(() => {
    pdfProbeMock.mockReset();
    vi.stubGlobal("fetch", realFetch);
    // Restored here, not at the end of the test, so a failing assertion can't
    // leave the real ActionService stubbed for the rest of the file.
    dispatchSpy?.mockRestore();
    dispatchSpy = null;
  });

  function pdfFrame(container: HTMLElement): HTMLIFrameElement | null {
    return container.querySelector("iframe");
  }

  function waitForFrame(container: HTMLElement): Promise<HTMLIFrameElement> {
    return waitFor(() => {
      const frame = pdfFrame(container);
      if (!frame) throw new Error("no PDF frame yet");
      return frame;
    });
  }

  it("shows the working-tree PDF instead of rendering a diff", async () => {
    seedPanel({
      filePath: "docs/spec.pdf",
      fileStatus: "modified",
      changeSet: [entry("docs/spec.pdf")],
    });
    const { container } = renderPane();

    const src = new URL((await waitForFrame(container)).getAttribute("src") ?? "");
    expect(src.protocol).toBe("daintree-pdf:");
    // The absolute working-tree path rides the protocol URL, and no text diff
    // is attempted for a binary document.
    expect(src.searchParams.get("path")).toBe("/repo/docs/spec.pdf");
    expect(screen.queryByTestId("diff-viewer-mock")).toBeNull();
  });

  it("hides the text-diff layout controls in PDF mode", async () => {
    seedPanel({
      filePath: "docs/spec.pdf",
      fileStatus: "modified",
      changeSet: [entry("docs/spec.pdf")],
    });
    const { container } = renderPane();
    await waitForFrame(container);

    expect(screen.queryByRole("radio", { name: "Unified" })).toBeNull();
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
    const before = (await waitForFrame(container)).getAttribute("src");

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
    // Nothing to frame, so nothing to probe.
    expect(pdfProbeMock).not.toHaveBeenCalled();
  });

  it("shows the preview's reason instead of a blank frame when the document is refused (#12598)", async () => {
    pdfProbeMock.mockResolvedValue({ ok: false, status: 413 });
    seedPanel({
      filePath: "docs/spec.pdf",
      fileStatus: "modified",
      changeSet: [entry("docs/spec.pdf")],
    });
    const { container } = renderPane();

    const empty = await screen.findByTestId("empty-state-mock");
    expect(empty.getAttribute("data-title")).toBeTruthy();
    expect(empty.getAttribute("data-description")).toBeTruthy();
    expect(pdfFrame(container)).toBeNull();
  });

  it("hands a refused PDF to the default app from its error state", async () => {
    const dispatch = vi
      .spyOn(actionService, "dispatch")
      .mockResolvedValue({ ok: true, result: undefined });
    dispatchSpy = dispatch;
    pdfProbeMock.mockResolvedValue({ ok: false, status: 413 });
    seedPanel({
      filePath: "docs/spec.pdf",
      fileStatus: "modified",
      changeSet: [entry("docs/spec.pdf")],
    });
    renderPane();

    const empty = await screen.findByTestId("empty-state-mock");
    const open = Array.from(empty.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Open in default app"
    );
    if (!open) throw new Error("no default-app action in the PDF error state");
    await act(async () => {
      fireEvent.click(open);
    });

    expect(dispatch).toHaveBeenCalledWith(
      "file.openInBrowser",
      { path: "/repo/docs/spec.pdf" },
      { source: "user" }
    );
  });

  it("tries the document again from the toolbar Refresh after a refusal", async () => {
    pdfProbeMock.mockResolvedValueOnce({ ok: false, status: 404 });
    seedPanel({
      filePath: "docs/spec.pdf",
      fileStatus: "modified",
      changeSet: [entry("docs/spec.pdf")],
    });
    const { container } = renderPane();
    await screen.findByTestId("empty-state-mock");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitForFrame(container);
    expect(screen.queryByTestId("empty-state-mock")).toBeNull();
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

describe("DiffPane ignore whitespace toggle (#17325)", () => {
  const LABEL = "Ignore whitespace changes";

  function toolbarToggle(): HTMLElement | null {
    return screen.queryByRole("button", { name: LABEL });
  }

  /** Below the toolbar's 720px fold, where secondary controls go into More actions. */
  function renderNarrow() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 500, 30)
    );
    return renderPane();
  }

  async function openMoreActions(): Promise<HTMLElement> {
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), { key: "Enter" });
    });
    return screen.findByRole("menu");
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sits beside Wrap long lines and flips the stored preference both ways", () => {
    seedPanel({ filePath: "src/a.ts", fileStatus: "modified", changeSet: [entry("src/a.ts")] });
    const { rerender } = renderPane();
    expect(screen.getByRole("button", { name: "Wrap long lines" })).toBeTruthy();
    expect(toolbarToggle()?.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toolbarToggle()!);
    rerender(paneElement());
    expect(preferences.setDiffIgnoreWhitespace).toHaveBeenLastCalledWith(true);
    expect(toolbarToggle()?.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(toolbarToggle()!);
    rerender(paneElement());
    expect(preferences.setDiffIgnoreWhitespace).toHaveBeenLastCalledWith(false);
    expect(toolbarToggle()?.getAttribute("aria-pressed")).toBe("false");
  });

  it("is absent from a since-review diff, whose read takes no whitespace flag", () => {
    useDiffContentMock.mockReturnValue({
      content: "diff --git a/a.ts b/a.ts",
      sinceReview: { status: "none" },
      stale: false,
      retry: vi.fn(),
    });
    seedPanel({ filePath: "a.ts", fileStatus: "modified", diffSource: "since-review" });
    renderPane();

    expect(screen.getByRole("button", { name: "Wrap long lines" })).toBeTruthy();
    expect(toolbarToggle()).toBeNull();
  });

  it("is absent while rendered Markdown is requested, even on the source fallback", () => {
    // The rendered request forces a whitespace-sensitive patch before it knows
    // whether the layout can render, so the fallback diff ignores the
    // preference too. Wrap stays, since it still applies to the fallback.
    preferences.diffMarkdownRendered = true;
    useDiffContentMock.mockReturnValue({
      content: "diff --git a/docs/guide.md b/docs/guide.md",
      stale: true,
      retry: vi.fn(),
    });
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    renderPane();

    expect(screen.getByTestId("diff-viewer-mock")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Wrap long lines" })).toBeTruthy();
    expect(toolbarToggle()).toBeNull();
  });

  it("is absent from an image diff, which has no text to filter", () => {
    isImageDiffCandidateMock.mockReturnValue(true);
    seedPanel({ filePath: "img/a.png", fileStatus: "modified", changeSet: [entry("img/a.png")] });
    renderPane();

    expect(toolbarToggle()).toBeNull();
  });

  it("folds into More actions beside Wrap long lines on a narrow panel while off", async () => {
    seedPanel({ filePath: "src/a.ts", fileStatus: "modified", changeSet: [entry("src/a.ts")] });
    renderNarrow();
    expect(toolbarToggle()).toBeNull();

    const menu = await openMoreActions();
    const rows = within(menu)
      .getAllByRole("menuitemcheckbox")
      .map((row) => row.textContent);
    expect(rows).toEqual(["Wrap long lines", LABEL]);
    const row = within(menu).getByRole("menuitemcheckbox", { name: LABEL });
    expect(row.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      fireEvent.click(row);
    });
    expect(preferences.setDiffIgnoreWhitespace).toHaveBeenCalledWith(true);
  });

  it("stays out of the fold on a narrow panel while on, and folds back once off", async () => {
    preferences.diffIgnoreWhitespace = true;
    seedPanel({ filePath: "src/a.ts", fileStatus: "modified", changeSet: [entry("src/a.ts")] });
    const { rerender } = renderNarrow();

    const button = toolbarToggle();
    expect(button?.getAttribute("aria-pressed")).toBe("true");
    let menu = await openMoreActions();
    expect(within(menu).queryByRole("menuitemcheckbox", { name: LABEL })).toBeNull();
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Wrap long lines" })).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(menu, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    fireEvent.click(button!);
    rerender(paneElement());

    expect(preferences.setDiffIgnoreWhitespace).toHaveBeenCalledWith(false);
    expect(toolbarToggle()).toBeNull();
    menu = await openMoreActions();
    const row = within(menu).getByRole("menuitemcheckbox", { name: LABEL });
    expect(row.getAttribute("aria-checked")).toBe("false");
  });

  it.each(["media/clip.mp4", "media/track.mp3", "docs/spec.pdf"])(
    "is absent from %s, which previews the file rather than diffing it",
    (path) => {
      // The previews fetch the working-tree bytes; held pending, they never land.
      const realFetch = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise(() => {}))
      );
      try {
        preferences.diffIgnoreWhitespace = true;
        seedPanel({ filePath: path, fileStatus: "modified", changeSet: [entry(path)] });
        renderNarrow();

        expect(toolbarToggle()).toBeNull();
      } finally {
        vi.stubGlobal("fetch", realFetch);
      }
    }
  );

  it("hands focus to More actions when switching off folds the narrow button away", () => {
    preferences.diffIgnoreWhitespace = true;
    seedPanel({ filePath: "src/a.ts", fileStatus: "modified", changeSet: [entry("src/a.ts")] });
    const { rerender } = renderNarrow();
    const button = toolbarToggle()!;
    button.focus();

    fireEvent.click(button);
    rerender(paneElement());

    expect(toolbarToggle()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More actions" }));
  });

  it("leaves focus on the wide button, which stays put when switched off", () => {
    preferences.diffIgnoreWhitespace = true;
    seedPanel({ filePath: "src/a.ts", fileStatus: "modified", changeSet: [entry("src/a.ts")] });
    const { rerender } = renderPane();
    const button = toolbarToggle()!;
    button.focus();

    fireEvent.click(button);
    rerender(paneElement());

    expect(document.activeElement).toBe(toolbarToggle());
    expect(toolbarToggle()?.getAttribute("aria-pressed")).toBe("false");
  });

  it("offers the way back from an empty diff only while the filter applies", () => {
    useDiffContentMock.mockReturnValue({ content: "NO_CHANGES", stale: false, retry: vi.fn() });
    seedPanel({ filePath: "src/a.ts", fileStatus: "modified", changeSet: [entry("src/a.ts")] });
    const { rerender } = renderPane();
    expect(screen.queryByRole("button", { name: "Show whitespace changes" })).toBeNull();

    preferences.diffIgnoreWhitespace = true;
    rerender(paneElement());
    fireEvent.click(screen.getByRole("button", { name: "Show whitespace changes" }));
    expect(preferences.setDiffIgnoreWhitespace).toHaveBeenCalledWith(false);
  });

  it("offers no way back on the rendered fallback, which never filtered", () => {
    preferences.diffIgnoreWhitespace = true;
    preferences.diffMarkdownRendered = true;
    useDiffContentMock.mockReturnValue({ content: "NO_CHANGES", stale: true, retry: vi.fn() });
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    renderPane();

    expect(screen.getByTestId("diff-viewer-mock")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show whitespace changes" })).toBeNull();
  });
});

describe("DiffPane — rendered Markdown layout (#12171)", () => {
  function layoutSegments(): string[] {
    const group = screen.getByRole("radiogroup", { name: "Diff layout" });
    return [...group.querySelectorAll("button")].map((button) => button.textContent ?? "");
  }

  function clickSegment(label: string): void {
    const group = screen.getByRole("radiogroup", { name: "Diff layout" });
    const button = [...group.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label
    );
    if (!button) throw new Error(`no "${label}" segment`);
    fireEvent.click(button);
  }

  it("offers the third segment only for a Markdown file", () => {
    seedPanel({ filePath: "src/index.ts", fileStatus: "modified" });
    const { unmount } = renderPane();
    expect(layoutSegments()).toEqual(["Unified", "Split"]);
    unmount();

    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    renderPane();
    expect(layoutSegments()).toEqual(["Unified", "Split", "Rendered"]);
  });

  it("selecting Rendered sets only the markdown preference, leaving the layout sticky", () => {
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    renderPane();

    clickSegment("Rendered");

    expect(preferences.setDiffMarkdownRendered).toHaveBeenCalledWith(true);
    expect(preferences.setDiffViewType).not.toHaveBeenCalled();
  });

  it("selecting a source layout clears rendered mode and records the layout", () => {
    preferences.diffMarkdownRendered = true;
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    renderPane();

    clickSegment("Split");

    expect(preferences.setDiffMarkdownRendered).toHaveBeenCalledWith(false);
    expect(preferences.setDiffViewType).toHaveBeenCalledWith("split");
  });

  it("swaps the body for the rendered layout and drops the source-only controls", async () => {
    preferences.diffMarkdownRendered = true;
    useDiffFileSourceMock.mockReturnValue({ source: "# Guide\n", errorCode: null });
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    renderPane();

    // The rendered body is behind a lazy() boundary; asserting synchronously
    // would only ever see the Suspense fallback.
    expect(await screen.findByTestId("rendered-markdown-mock")).toBeTruthy();
    expect(screen.queryByTestId("diff-viewer-mock")).toBe(null);
    expect(screen.queryByRole("radiogroup", { name: "Diff content" })).toBe(null);
    expect(screen.queryByLabelText("Wrap long lines")).toBe(null);
  });

  it("keeps the source layout and its controls when rendered mode is off", () => {
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    renderPane();

    expect(screen.getByTestId("diff-viewer-mock")).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Diff content" })).toBeTruthy();
  });

  it("disables the segment on a staged diff and describes why for the keyboard path", () => {
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified", diffSource: "staged" });
    renderPane();

    const group = screen.getByRole("radiogroup", { name: "Diff layout" });
    const rendered = [...group.querySelectorAll("button")].find(
      (button) => button.textContent === "Rendered"
    );
    expect(rendered?.hasAttribute("disabled")).toBe(true);

    const describedBy = group.getAttribute("aria-describedby");
    if (!describedBy) throw new Error("layout group carries no aria-describedby");
    expect(document.getElementById(describedBy)?.textContent).toContain("staged changes");
  });

  it("falls back to the source diff when the file can render but the diff is stale", () => {
    preferences.diffMarkdownRendered = true;
    useDiffContentMock.mockReturnValue({
      content: "diff --git a/docs/guide.md b/docs/guide.md",
      stale: true,
      retry: vi.fn(),
    });
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    renderPane();

    // The preference survives — the file that can't render doesn't cost the setting.
    expect(screen.getByTestId("diff-viewer-mock")).toBeTruthy();
    expect(preferences.setDiffMarkdownRendered).not.toHaveBeenCalled();
  });

  it("asks for a whitespace-sensitive patch only while rendered mode is requested", () => {
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    const { unmount } = renderPane();
    expect(useDiffContentMock.mock.calls.at(-1)?.[2]).toBeUndefined();
    unmount();

    useDiffContentMock.mockClear();
    preferences.diffMarkdownRendered = true;
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    renderPane();
    expect(useDiffContentMock.mock.calls.at(-1)?.[2]).toEqual({ ignoreWhitespace: false });
  });

  it("reads no source for a deleted file, whose patch already carries the old document", async () => {
    preferences.diffMarkdownRendered = true;
    seedPanel({ filePath: "docs/guide.md", fileStatus: "deleted" });
    renderPane();

    const rendered = await screen.findByTestId("rendered-markdown-mock");
    expect(rendered.getAttribute("data-status")).toBe("deleted");
    expect(rendered.getAttribute("data-has-source")).toBe("false");
    // The read must not merely be unused — it must never be requested.
    expect(sourceEnabledCalls().some(Boolean)).toBe(false);
  });

  it("requests the whole-file read for a modified file even with Full file off", () => {
    preferences.diffMarkdownRendered = true;
    preferences.diffFullFile = false;
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    renderPane();

    expect(sourceEnabledCalls().some(Boolean)).toBe(true);
  });

  it("holds the body on a skeleton until the whole-file read lands", async () => {
    preferences.diffMarkdownRendered = true;
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    renderPane();

    // Flushed past the lazy boundary first, so this proves the pending-source
    // gate rather than just catching the Suspense fallback. Mounting the engine
    // with no source would make it report `source-required` — a failure the
    // availability verdict latches onto, disabling the segment over a read that
    // was merely in flight.
    await act(async () => {});
    expect(screen.queryByTestId("rendered-markdown-mock")).toBe(null);
    expect(screen.getByLabelText("Loading rendered Markdown")).toBeTruthy();
  });

  it("mounts the engine once the source is there", async () => {
    preferences.diffMarkdownRendered = true;
    useDiffFileSourceMock.mockReturnValue({ source: "# Guide\n", errorCode: null });
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    renderPane();

    const rendered = await screen.findByTestId("rendered-markdown-mock");
    expect(rendered.getAttribute("data-has-source")).toBe("true");
  });

  it("stops requesting the source while the diff is stale, so Refresh re-reads it", () => {
    // Without this the source hook's inputs never change across a Refresh, and
    // the new patch would be paired with the file snapshot the old one was
    // measured against — reconstructing text that is no longer on disk.
    preferences.diffMarkdownRendered = true;
    useDiffContentMock.mockReturnValue({
      content: "diff --git a/docs/guide.md b/docs/guide.md",
      stale: true,
      retry: vi.fn(),
    });
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    renderPane();

    expect(sourceEnabledCalls().some(Boolean)).toBe(false);
  });

  it("stops requesting the source while the diff is reloading", () => {
    preferences.diffMarkdownRendered = true;
    useDiffContentMock.mockReturnValue({ content: undefined, stale: false, retry: vi.fn() });
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    renderPane();

    expect(sourceEnabledCalls().some(Boolean)).toBe(false);
  });

  it("stops applying an engine failure once the inputs it judged have changed", async () => {
    preferences.diffMarkdownRendered = true;
    useDiffFileSourceMock.mockReturnValue({ source: "# Guide\n", errorCode: null });
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    const { unmount } = renderPane();

    const firstAttempt = (await screen.findByTestId("rendered-markdown-mock")).getAttribute(
      "data-attempt-key"
    );
    expect(firstAttempt).toBeTruthy();
    unmount();

    // A different source is a different attempt, so a verdict stamped against
    // the first one can no longer disqualify it.
    useDiffFileSourceMock.mockReturnValue({ source: "# Guide edited\n", errorCode: null });
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    renderPane();

    const second = await screen.findByTestId("rendered-markdown-mock");
    expect(second.getAttribute("data-attempt-key")).not.toBe(firstAttempt);
  });

  it("steps only through the change count reported for the attempt on screen", async () => {
    preferences.diffMarkdownRendered = true;
    useDiffFileSourceMock.mockReturnValue({ source: "# Guide\n", errorCode: null });
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    const { rerender } = renderPane();

    const first = await screen.findByTestId("rendered-markdown-mock");
    const firstAttempt = first.getAttribute("data-attempt-key") ?? "";
    act(() => renderedProps.current?.onChangeCount?.(3, firstAttempt));
    expect(screen.getByText("1 of 3")).toBeTruthy();

    // The source moves on. The view reports nothing until its new comparison is
    // built, so the first document's three changes must not stay steppable.
    useDiffFileSourceMock.mockReturnValue({ source: "# Guide edited\n", errorCode: null });
    rerender(paneElement());
    const second = await screen.findByTestId("rendered-markdown-mock");
    const secondAttempt = second.getAttribute("data-attempt-key") ?? "";
    expect(secondAttempt).not.toBe(firstAttempt);
    expect(screen.queryByRole("group", { name: "Changes" })).toBe(null);

    // A count for the old attempt arriving late is not this one's either.
    act(() => renderedProps.current?.onChangeCount?.(3, firstAttempt));
    expect(screen.queryByRole("group", { name: "Changes" })).toBe(null);

    act(() => renderedProps.current?.onChangeCount?.(2, secondAttempt));
    expect(screen.getByText("1 of 2")).toBeTruthy();
  });

  it("keeps one comparison slot per pane: stable across files, distinct between panes", async () => {
    preferences.diffMarkdownRendered = true;
    useDiffFileSourceMock.mockReturnValue({ source: "# Guide\n", errorCode: null });
    seedPanel({ filePath: "docs/guide.md", fileStatus: "modified" });
    const { rerender, unmount } = renderPane();
    const requestKey = (await screen.findByTestId("rendered-markdown-mock")).getAttribute(
      "data-request-key"
    );
    expect(requestKey).toBeTruthy();

    // Stepping to another file supersedes the last one's comparison only if
    // both are filed under the same key.
    seedPanel({ filePath: "docs/other.md", fileStatus: "modified" });
    rerender(paneElement());
    const next = await screen.findByTestId("rendered-markdown-mock");
    expect(next.getAttribute("data-attempt-key")).toContain("docs/other.md");
    expect(next.getAttribute("data-request-key")).toBe(requestKey);
    unmount();

    // A second pane must not supersede the first one's comparison.
    panelsById["diff-2"] = {
      id: "diff-2",
      kind: "diff",
      diffSource: "working-tree",
      filePath: "docs/guide.md",
      fileStatus: "modified",
    };
    render(
      <DiffPane
        id="diff-2"
        title="pane"
        isFocused
        location="dialog"
        worktreeId={WORKTREE_ID}
        onFocus={() => {}}
        onClose={() => {}}
      />
    );
    const other = await screen.findByTestId("rendered-markdown-mock");
    expect(other.getAttribute("data-request-key")).toBeTruthy();
    expect(other.getAttribute("data-request-key")).not.toBe(requestKey);
  });
});

describe("DiffPane — submodule gitlinks (#12309)", () => {
  // Real `git diff` output for a submodule whose recorded commit moved. The
  // trailing 160000 on the index line is what marks the entry a gitlink.
  const GITLINK_DIFF = `diff --git a/vendor/sub b/vendor/sub
index ada605e..029ae62 160000
--- a/vendor/sub
+++ b/vendor/sub
@@ -1 +1 @@
-Subproject commit ada605e3957df590939d8d977a26e1735b98390f
+Subproject commit 029ae62ae5f30fb47a84aa76407e4e42dd165e6d`;

  function seedGitlink(overrides: Record<string, unknown> = {}): void {
    useDiffContentMock.mockReturnValue({ content: GITLINK_DIFF, stale: false, retry: vi.fn() });
    seedPanel({
      filePath: "vendor/sub",
      fileStatus: "modified",
      changeSet: [entry("vendor/sub")],
      ...overrides,
    });
  }

  it("never asks to read a submodule path, even with Full file on", () => {
    // The path is the submodule's checkout directory, so the read fails with a
    // message no Retry can clear. It must never be requested.
    preferences.diffFullFile = true;
    seedGitlink();
    renderPane();

    expect(sourceEnabledCalls().some(Boolean)).toBe(false);
  });

  it("disables Full file with a reason instead of raising a failed-read banner", () => {
    preferences.diffFullFile = true;
    seedGitlink();
    renderPane();

    const group = screen.getByRole("radiogroup", { name: "Diff content" });
    const describedBy = group.getAttribute("aria-describedby");
    if (!describedBy) throw new Error("scope group carries no aria-describedby");
    expect(document.getElementById(describedBy)?.textContent).toMatch(/submodule/i);

    const fullFile = [...group.querySelectorAll("button")].find(
      (button) => button.textContent === "Full file"
    );
    expect(fullFile?.hasAttribute("disabled")).toBe(true);
    // The bug: a warning banner claiming the read failed, with a dead Retry.
    expect(screen.queryByText("Showing changed lines only")).toBeNull();
    expect(
      [...document.querySelectorAll("button")].some((button) => button.textContent === "Retry")
    ).toBe(false);
  });

  it("still hands the viewer the commit-pair patch", () => {
    preferences.diffFullFile = true;
    seedGitlink();
    renderPane();

    // Refusing the full-file scope must not cost the patch that IS renderable.
    const viewer = screen.getByTestId("diff-viewer-mock");
    expect(viewer.getAttribute("data-diff")).toContain("Subproject commit");
  });

  it("leaves an ordinary file's Full file scope alone", () => {
    // The guard keys off the patch, so it must not leak onto everything else.
    preferences.diffFullFile = true;
    useDiffContentMock.mockReturnValue({
      content: `diff --git a/a.ts b/a.ts\nindex 83db48f..bf269f4 100644`,
      stale: false,
      retry: vi.fn(),
    });
    seedPanel({ filePath: "a.ts", fileStatus: "modified", changeSet: [entry("a.ts")] });
    renderPane();

    const group = screen.getByRole("radiogroup", { name: "Diff content" });
    const fullFile = [...group.querySelectorAll("button")].find(
      (button) => button.textContent === "Full file"
    );
    expect(fullFile?.hasAttribute("disabled")).toBe(false);
    expect(sourceEnabledCalls().some(Boolean)).toBe(true);
  });

  it("refuses the rendered layout for a .md-suffixed submodule rather than reading it", async () => {
    // The rendered layout is a second, independent reason to read the new side.
    preferences.diffMarkdownRendered = true;
    seedGitlink({ filePath: "vendor/docs.md", changeSet: [entry("vendor/docs.md")] });
    renderPane();

    await act(async () => {});
    expect(sourceEnabledCalls().some(Boolean)).toBe(false);
    const layoutGroup = screen.getByRole("radiogroup", { name: "Diff layout" });
    const describedBy = layoutGroup.getAttribute("aria-describedby");
    if (!describedBy) throw new Error("layout group carries no aria-describedby");
    expect(document.getElementById(describedBy)?.textContent).toMatch(/submodule/i);
  });

  it("shows a folder read failure without a Retry that cannot work", () => {
    // Belt and braces: the guard above stops the read being issued, but any
    // residual path that still reaches a directory must not offer a retry.
    preferences.diffFullFile = true;
    useDiffFileSourceMock.mockReturnValue({ source: undefined, errorCode: "NOT_A_FILE" });
    useDiffContentMock.mockReturnValue({
      content: `diff --git a/a.ts b/a.ts\nindex 83db48f..bf269f4 100644`,
      stale: false,
      retry: vi.fn(),
    });
    seedPanel({ filePath: "a.ts", fileStatus: "modified", changeSet: [entry("a.ts")] });
    renderPane();

    expect(screen.getByText("This is a folder, not a file")).toBeTruthy();
    expect(
      [...document.querySelectorAll("button")].some((button) => button.textContent === "Retry")
    ).toBe(false);
  });

  it("keeps Retry for a read failure that a refresh could clear", () => {
    preferences.diffFullFile = true;
    useDiffFileSourceMock.mockReturnValue({ source: undefined, errorCode: "PERMISSION" });
    useDiffContentMock.mockReturnValue({
      content: `diff --git a/a.ts b/a.ts\nindex 83db48f..bf269f4 100644`,
      stale: false,
      retry: vi.fn(),
    });
    seedPanel({ filePath: "a.ts", fileStatus: "modified", changeSet: [entry("a.ts")] });
    renderPane();

    expect(
      [...document.querySelectorAll("button")].some((button) => button.textContent === "Retry")
    ).toBe(true);
  });

  it("does not treat an image-suffixed submodule as an image", () => {
    isImageDiffCandidateMock.mockReturnValue(true);
    seedGitlink({ filePath: "vendor/icons.png", changeSet: [entry("vendor/icons.png")] });
    renderPane();

    expect(screen.queryByTestId("image-diff-mock")).toBeNull();
    expect(screen.getByTestId("diff-viewer-mock")).toBeTruthy();
  });
});

describe("DiffPane — hunk staging (#17331)", () => {
  const TWO_HUNKS = [
    "diff --git a/a.ts b/a.ts",
    "index 1111111..2222222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,3 +1,3 @@",
    "-one",
    "+ONE",
    " two",
    " three",
    "@@ -20,3 +20,3 @@ function f() {",
    " x",
    "-y",
    "+Y",
    " z",
    "",
  ].join("\n");
  const FIRST = "@@ -1,3 +1,3 @@\n-one\n+ONE\n two\n three";
  const SECOND = "@@ -20,3 +20,3 @@ function f() {\n x\n-y\n+Y\n z";

  let dispatchSpy: { mockRestore: () => void } | null = null;
  beforeEach(() => {
    _resetDiffCacheForTests();
    viewerRenderedHunks.current = null;
  });
  afterEach(() => {
    dispatchSpy?.mockRestore();
    dispatchSpy = null;
    viewerRenderedHunks.current = null;
  });

  function seedTwin(fileSide: "staged" | "unstaged", content = TWO_HUNKS, filePath = "a.ts") {
    const changeSet: DiffChangeSetEntry[] = [
      { path: filePath, status: "modified", viewedKey: `working-tree:${filePath}`, side: "staged" },
      {
        path: filePath,
        status: "modified",
        viewedKey: `working-tree:${filePath}`,
        side: "unstaged",
      },
    ];
    seedPanel({
      filePath,
      fileStatus: "modified",
      viewedKey: `working-tree:${filePath}`,
      fileSide,
      changeSet,
    });
    useDiffContentMock.mockReturnValue({
      content,
      stale: false,
      ignoreWhitespace: false,
      retry: vi.fn(),
    });
  }

  type Dispatch = typeof actionService.dispatch;
  /** Answers the hunk actions with `answers` in turn, and a diff read with a patch. */
  function stubDispatch(...answers: unknown[]) {
    const dispatch = vi.spyOn(actionService, "dispatch").mockImplementation((async (id: string) => {
      if (id === "git.getFileDiff") {
        return { ok: true, result: { content: TWO_HUNKS, truncated: false } };
      }
      return answers.length > 1 ? answers.shift() : answers[0];
    }) as unknown as Dispatch);
    dispatchSpy = dispatch;
    return dispatch;
  }

  const hunkCalls = (dispatch: { mock: { calls: unknown[][] } }) =>
    dispatch.mock.calls.filter(([id]) => id !== "git.getFileDiff");

  async function warmBothSides(): Promise<void> {
    for (const source of ["staged", "unstaged"] as const) {
      await requestDiff(
        { source, worktreePath: WORKTREE_PATH, filePath: "a.ts", status: "modified" },
        false
      );
    }
  }

  const cachedSide = (source: "staged" | "unstaged") =>
    peekCachedDiff(
      { source, worktreePath: WORKTREE_PATH, filePath: "a.ts", status: "modified" },
      false
    );

  it("offers Stage hunk on each of git's hunks of an unstaged diff, and Unstage hunk on a staged one", () => {
    seedTwin("unstaged");
    renderPane();
    expect(screen.getAllByRole("button", { name: "Stage hunk" })).toHaveLength(2);
    cleanup();

    seedTwin("staged");
    renderPane();
    expect(screen.getAllByRole("button", { name: "Unstage hunk" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Stage hunk" })).toBeNull();
  });

  it("offers nothing on a diff with no side, one read ignoring whitespace, or a new file", () => {
    seedPanel({ filePath: "a.ts", fileStatus: "modified", changeSet: [entry("a.ts")] });
    useDiffContentMock.mockReturnValue({ content: TWO_HUNKS, stale: false, retry: vi.fn() });
    renderPane();
    expect(screen.queryAllByTestId("hunk-actions")).toHaveLength(0);
    cleanup();

    seedTwin("unstaged");
    useDiffContentMock.mockReturnValue({
      content: TWO_HUNKS,
      stale: false,
      ignoreWhitespace: true,
      retry: vi.fn(),
    });
    renderPane();
    expect(screen.queryAllByTestId("hunk-actions")).toHaveLength(0);
    cleanup();

    seedTwin(
      "staged",
      "diff --git a/a.ts b/a.ts\nnew file mode 100644\nindex 0000000..2222222\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+one\n"
    );
    renderPane();
    expect(screen.queryAllByRole("button", { name: /stage hunk/i })).toHaveLength(0);
  });

  it("stages the git hunk under the button, as read, and drops both sides' cached diffs", async () => {
    seedTwin("unstaged");
    const dispatch = stubDispatch({ ok: true, result: { status: "applied" } });
    await warmBothSides();
    expect(cachedSide("staged")).toBeDefined();
    renderPane();

    fireEvent.click(screen.getAllByRole("button", { name: "Stage hunk" })[1]!);

    await waitFor(() => expect(cachedSide("staged")).toBeUndefined());
    expect(cachedSide("unstaged")).toBeUndefined();
    expect(hunkCalls(dispatch)).toEqual([
      [
        "git.stageHunk",
        { worktreeId: WORKTREE_ID, filePath: "a.ts", hunks: [SECOND] },
        { source: "user" },
      ],
    ]);
    expect(screen.queryByText("Hunk changed since this diff loaded")).toBeNull();
  });

  it("stages every git hunk a merged header holds, and says how many", async () => {
    seedTwin("unstaged");
    viewerRenderedHunks.current = [{ oldStart: 1, oldLines: 22, newStart: 1, newLines: 22 }];
    const dispatch = stubDispatch({ ok: true, result: { status: "applied" } });
    renderPane();

    fireEvent.click(screen.getByRole("button", { name: "Stage 2 hunks" }));

    await waitFor(() => expect(hunkCalls(dispatch)).toHaveLength(1));
    expect(hunkCalls(dispatch)[0]![1]).toMatchObject({ hunks: [FIRST, SECOND] });
  });

  it("says the hunk changed when Main refuses it, even under the stale banner", async () => {
    seedTwin("unstaged");
    useDiffContentMock.mockReturnValue({
      content: TWO_HUNKS,
      stale: true,
      ignoreWhitespace: false,
      retry: vi.fn(),
    });
    const dispatch = stubDispatch({ ok: true, result: { status: "stale" } });
    await warmBothSides();
    renderPane();

    fireEvent.click(screen.getAllByRole("button", { name: "Stage hunk" })[0]!);

    expect(await screen.findByText("Hunk changed since this diff loaded")).toBeTruthy();
    expect(hunkCalls(dispatch)[0]![0]).toBe("git.stageHunk");
    expect(cachedSide("unstaged")).toBeUndefined();
  });

  it("unstages from the staged side, and Retry sends the same hunk again", async () => {
    seedTwin("staged");
    const failed = { ok: false, error: { code: "EXECUTION_ERROR", message: "Index is busy" } };
    const dispatch = stubDispatch(failed, failed);
    renderPane();

    fireEvent.click(screen.getAllByRole("button", { name: "Unstage hunk" })[1]!);
    expect(await screen.findByText("Couldn't unstage hunk")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(hunkCalls(dispatch)).toHaveLength(2));
    const expected = [
      "git.unstageHunk",
      { worktreeId: WORKTREE_ID, filePath: "a.ts", hunks: [SECOND] },
      { source: "user" },
    ];
    expect(hunkCalls(dispatch)).toEqual([expected, expected]);
  });

  it("drops a failure's Retry once the diff it would stage from is gone", async () => {
    seedTwin("unstaged");
    stubDispatch({ ok: false, error: { code: "EXECUTION_ERROR", message: "Index is busy" } });
    const { rerender } = renderPane();
    fireEvent.click(screen.getAllByRole("button", { name: "Stage hunk" })[0]!);
    expect(await screen.findByText("Couldn't stage hunk")).toBeTruthy();

    // A reload that read a different patch, still stageable.
    useDiffContentMock.mockReturnValue({
      content: TWO_HUNKS.replace("+Y", "+Z"),
      stale: false,
      ignoreWhitespace: false,
      retry: vi.fn(),
    });
    rerender(paneElement());

    expect(screen.queryByText("Couldn't stage hunk")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Stage hunk" })).toHaveLength(2);
  });

  /**
   * Clicks Stage hunk, moves the pane with `move`, answers the write as stale,
   * then steps back: an answer for a target the pane had left is never kept.
   */
  async function answerAfterMoving(move: () => void): Promise<void> {
    let answer!: (value: Awaited<ReturnType<Dispatch>>) => void;
    dispatchSpy = vi.spyOn(actionService, "dispatch").mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    const { rerender } = renderPane();
    fireEvent.click(screen.getAllByRole("button", { name: "Stage hunk" })[0]!);
    move();
    rerender(paneElement());
    await act(async () => {
      answer({ ok: true, result: { status: "stale" } });
    });
    expect(screen.queryByText("Hunk changed since this diff loaded")).toBeNull();

    seedTwin("unstaged");
    rerender(paneElement());
    expect(screen.queryByText("Hunk changed since this diff loaded")).toBeNull();
  }

  it("keeps a refusal's notice on the diff it was about, not the twin the pane steps to", async () => {
    seedTwin("unstaged");
    stubDispatch({ ok: true, result: { status: "stale" } });
    const { rerender } = renderPane();
    fireEvent.click(screen.getAllByRole("button", { name: "Stage hunk" })[0]!);
    expect(await screen.findByText("Hunk changed since this diff loaded")).toBeTruthy();

    seedTwin("staged");
    rerender(paneElement());
    expect(screen.queryByText("Hunk changed since this diff loaded")).toBeNull();

    seedTwin("unstaged");
    rerender(paneElement());
    expect(screen.getByText("Hunk changed since this diff loaded")).toBeTruthy();
  });

  it("reports nothing on the twin the pane stepped to before the answer came", async () => {
    seedTwin("unstaged");
    await answerAfterMoving(() => seedTwin("staged"));
  });

  it("reports nothing on another file the pane stepped to before the answer came", async () => {
    seedTwin("unstaged");
    await answerAfterMoving(() => seedTwin("unstaged", TWO_HUNKS, "b.ts"));
  });
});
