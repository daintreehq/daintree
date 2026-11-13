/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import type { StagingFileEntry } from "@shared/types";
import type { CrossWorktreeFile } from "@shared/types/ipc/git";
import type { CommitShortcutHandler } from "../commitShortcut";
import type { FileStageRowSection } from "../FileStageRow";
import type { DiffMode } from "../reviewHubUtils";
import { useReviewHubFileCursor, type ReviewHubNavigableItem } from "../useReviewHubFileCursor";
import { useReviewHubKeyboard } from "../useReviewHubKeyboard";
import { useReviewHubRowSelection } from "../useReviewHubRowSelection";

const file: StagingFileEntry = {
  path: "src/app.ts",
  status: "modified",
  insertions: 1,
  deletions: 0,
};
const navigableItems: ReviewHubNavigableItem[] = [
  { section: "unstaged", file },
  { section: "unstaged", file: { ...file, path: "src/other.ts" } },
];

type OpenDiff = "working-tree" | "base-branch" | "since-review";

interface HarnessProps {
  openDiff: OpenDiff | null;
  spies: ReturnType<typeof makeSpies>;
}

function makeSpies() {
  return {
    onClose: vi.fn(),
    setSelectedFile: vi.fn(),
    setSelectedBaseBranchFile: vi.fn(),
    setSelectedSinceReviewPath: vi.fn(),
    openFileDiff: vi.fn(),
    handleToggleStaged: vi.fn(),
    handleToggleUnstaged: vi.fn(),
    handleViewedChange: vi.fn(),
    commit: vi.fn(),
  };
}

const baseFile: CrossWorktreeFile = {
  path: "src/app.ts",
  status: "M",
  insertions: 1,
  deletions: 0,
};

function Harness({ openDiff, spies }: HarnessProps) {
  const cursor = useReviewHubFileCursor({
    navigableItems,
    stagedCount: 0,
    menuReplayBlocked: true,
  });
  const selection = useReviewHubRowSelection(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const commitShortcutRef = useRef<CommitShortcutHandler | null>(spies.commit);
  useReviewHubKeyboard({
    isOpen: true,
    keyboardScope: document,
    onClose: spies.onClose,
    cursor,
    selection,
    navigableItems,
    selectedFile:
      openDiff === "working-tree"
        ? { path: file.path, status: file.status, section: "unstaged" as FileStageRowSection }
        : null,
    setSelectedFile: spies.setSelectedFile,
    selectedBaseBranchFile: openDiff === "base-branch" ? baseFile : null,
    setSelectedBaseBranchFile: spies.setSelectedBaseBranchFile,
    selectedSinceReviewPath: openDiff === "since-review" ? file.path : null,
    setSelectedSinceReviewPath: spies.setSelectedSinceReviewPath,
    fileListExpanded: true,
    // The working-tree list stays on screen whichever diff is open (a
    // since-review diff also opens from the review line), so only the overlay
    // guard stands between these keys and the rows beneath.
    diffMode: "working-tree" satisfies DiffMode,
    openFileDiff: spies.openFileDiff,
    handleToggleStaged: spies.handleToggleStaged,
    handleToggleUnstaged: spies.handleToggleUnstaged,
    handleViewedChange: spies.handleViewedChange,
    viewedFiles: new Set(),
    rootRef,
    commitShortcutRef,
  });
  return (
    <div ref={rootRef}>
      <div
        ref={cursor.fileListRef}
        role="listbox"
        tabIndex={0}
        data-testid="list"
        data-focused-index={cursor.focusedIndex}
      />
      <button type="button" data-testid="control">
        Refresh
      </button>
    </div>
  );
}

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
    );
  });
}

const COMMIT_CHORD: KeyboardEventInit = { metaKey: true, ctrlKey: true };

const clearerOf = (spies: ReturnType<typeof makeSpies>, openDiff: OpenDiff) =>
  ({
    "working-tree": spies.setSelectedFile,
    "base-branch": spies.setSelectedBaseBranchFile,
    "since-review": spies.setSelectedSinceReviewPath,
  })[openDiff];

/** Renders with the cursor on the first row, placed the way a user would. */
function renderWithCursor(spies: ReturnType<typeof makeSpies>) {
  const view = render(<Harness openDiff={null} spies={spies} />);
  const list = view.getByTestId("list");
  press(list, "ArrowDown");
  expect(list.getAttribute("data-focused-index")).toBe("0");
  return { ...view, list };
}

afterEach(() => {
  cleanup();
});

// Proves each key below reaches the branch the overlay guard has to stop.
describe("useReviewHubKeyboard with no diff open", () => {
  it("acts on the list, commits and closes the hub", () => {
    const spies = makeSpies();
    const { list, getByTestId } = renderWithCursor(spies);

    press(list, "ArrowDown");
    expect(list.getAttribute("data-focused-index")).toBe("1");
    press(list, "Enter");
    expect(spies.openFileDiff).toHaveBeenCalledTimes(1);
    press(list, " ");
    expect(spies.handleToggleUnstaged).toHaveBeenCalledTimes(1);
    press(list, "v");
    expect(spies.handleViewedChange).toHaveBeenCalledTimes(1);
    press(getByTestId("control"), "Enter", COMMIT_CHORD);
    expect(spies.commit).toHaveBeenCalledTimes(1);
    press(list, "Escape");
    expect(spies.onClose).toHaveBeenCalledTimes(1);
  });
});

// The diff layers over the hub, and the hub's capture listener still hears
// every key pressed inside it. Whichever tab opened it, an open diff has to
// read as the overlay it is.
describe.each<OpenDiff>(["working-tree", "base-branch", "since-review"])(
  "useReviewHubKeyboard with a %s diff open",
  (openDiff) => {
    it("closes the diff on Escape, not the hub", () => {
      const spies = makeSpies();
      const { getByTestId } = render(<Harness openDiff={openDiff} spies={spies} />);

      press(getByTestId("list"), "Escape");

      expect(clearerOf(spies, openDiff)).toHaveBeenCalledWith(null);
      expect(spies.onClose).not.toHaveBeenCalled();
    });

    it("leaves the commit chord to the diff", () => {
      const spies = makeSpies();
      const { getByTestId } = render(<Harness openDiff={openDiff} spies={spies} />);

      press(getByTestId("control"), "Enter", COMMIT_CHORD);

      expect(spies.commit).not.toHaveBeenCalled();
    });

    it.each([
      ["ArrowDown", () => undefined],
      ["Enter", (spies: ReturnType<typeof makeSpies>) => spies.openFileDiff],
      [" ", (spies: ReturnType<typeof makeSpies>) => spies.handleToggleUnstaged],
      ["v", (spies: ReturnType<typeof makeSpies>) => spies.handleViewedChange],
    ] as const)("doesn't act on the row beneath it for %j", (key, actionOf) => {
      const spies = makeSpies();
      const { list, rerender } = renderWithCursor(spies);
      rerender(<Harness openDiff={openDiff} spies={spies} />);

      press(list, key);

      expect(list.getAttribute("data-focused-index")).toBe("0");
      const action = actionOf(spies);
      if (action) expect(action).not.toHaveBeenCalled();
    });
  }
);
