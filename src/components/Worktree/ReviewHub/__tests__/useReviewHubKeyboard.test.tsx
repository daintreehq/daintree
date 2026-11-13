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
  openDiff: OpenDiff;
  diffMode: DiffMode;
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

function Harness({ openDiff, diffMode, spies }: HarnessProps) {
  const cursor = useReviewHubFileCursor({
    navigableItems,
    stagedCount: 0,
    menuReplayBlocked: true,
  });
  const selection = useReviewHubRowSelection(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const commitShortcutRef = useRef<CommitShortcutHandler | null>(spies.commit);
  const baseFile: CrossWorktreeFile = { path: "src/app.ts", status: "M" };
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
    diffMode,
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
      <div ref={cursor.fileListRef} role="listbox" tabIndex={0} data-testid="list" />
      <button type="button" data-testid="control">
        Refresh
      </button>
    </div>
  );
}

const clearerOf = (spies: ReturnType<typeof makeSpies>, openDiff: OpenDiff) =>
  ({
    "working-tree": spies.setSelectedFile,
    "base-branch": spies.setSelectedBaseBranchFile,
    "since-review": spies.setSelectedSinceReviewPath,
  })[openDiff];

afterEach(() => {
  cleanup();
});

// The diff layers over the hub, and the hub's capture listener still hears
// every key pressed inside it. Whichever tab opened it, an open diff has to
// read as the overlay it is.
describe.each<OpenDiff>(["working-tree", "base-branch", "since-review"])(
  "useReviewHubKeyboard with a %s diff open",
  (openDiff) => {
    it("closes the diff on Escape, not the hub", () => {
      const spies = makeSpies();
      const { getByTestId } = render(
        <Harness openDiff={openDiff} diffMode="working-tree" spies={spies} />
      );

      act(() => {
        getByTestId("list").dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
        );
      });

      expect(clearerOf(spies, openDiff)).toHaveBeenCalledWith(null);
      expect(spies.onClose).not.toHaveBeenCalled();
    });

    it("leaves the commit chord to the diff", () => {
      const spies = makeSpies();
      const { getByTestId } = render(
        <Harness openDiff={openDiff} diffMode="working-tree" spies={spies} />
      );

      act(() => {
        getByTestId("control").dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            metaKey: true,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          })
        );
      });

      expect(spies.commit).not.toHaveBeenCalled();
    });

    it("doesn't move, open, stage or mark the list beneath it", () => {
      const spies = makeSpies();
      const { getByTestId } = render(
        <Harness openDiff={openDiff} diffMode="working-tree" spies={spies} />
      );
      const list = getByTestId("list");
      const press = (key: string) =>
        act(() => {
          list.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        });

      press("ArrowDown");
      press("Enter");
      press(" ");
      press("v");

      expect(list.getAttribute("aria-activedescendant")).toBeNull();
      expect(spies.openFileDiff).not.toHaveBeenCalled();
      expect(spies.handleToggleStaged).not.toHaveBeenCalled();
      expect(spies.handleToggleUnstaged).not.toHaveBeenCalled();
      expect(spies.handleViewedChange).not.toHaveBeenCalled();
    });
  }
);
