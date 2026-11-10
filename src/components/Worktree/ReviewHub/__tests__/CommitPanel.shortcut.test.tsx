/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import type { GitPushCommitPreview } from "@shared/types/git";

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    children,
  }: {
    isOpen: boolean;
    title: ReactNode;
    children?: ReactNode;
  }) => (isOpen ? <div role="alertdialog">{children}</div> : null),
}));

import { CommitPanel } from "../CommitPanel";
import type { CommitShortcutHandler } from "../commitShortcut";

const CWD = "/repo/wt";

const listPushCommits = vi.fn();

function pushPreview(): GitPushCommitPreview {
  return {
    destination: { remote: "origin", branch: "feature/x" },
    rangeBasis: "tracked",
    commits: [],
    total: 0,
    behind: 0,
    headOid: "0".repeat(40),
  };
}

function renderPanel(overrides: Partial<ComponentProps<typeof CommitPanel>> = {}) {
  const shortcutRef: RefObject<CommitShortcutHandler | null> = { current: null };
  const props: ComponentProps<typeof CommitPanel> = {
    stagedCount: 2,
    isDetachedHead: false,
    hasConflicts: false,
    hasRemote: true,
    pushDestination: { remote: "origin", branch: "feature/x" },
    worktreePath: CWD,
    currentBranch: "feature/x",
    commitMessage: "fix: bug",
    onCommitMessageChange: vi.fn(),
    onCommit: vi.fn().mockResolvedValue(undefined),
    onCommitAndPush: vi.fn().mockResolvedValue(undefined),
    onFocusBlocker: vi.fn(),
    isPushing: false,
    pushProgress: new Map(),
    pushTargetBranch: null,
    skipPushConfirm: false,
    onSetSkipPushConfirm: vi.fn(),
    shortcutRef,
    ...overrides,
  };
  const view = render(<CommitPanel {...props} />);
  const press = async (commitOnly = false) => {
    await act(async () => {
      shortcutRef.current?.({ commitOnly });
    });
  };
  return { props, shortcutRef, press, ...view };
}

beforeEach(() => {
  listPushCommits.mockReset().mockResolvedValue(pushPreview());
  Object.defineProperty(window, "electron", {
    value: { git: { listCommits: vi.fn().mockResolvedValue({ items: [] }), listPushCommits } },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CommitPanel shortcut handler", () => {
  it("is registered while the panel is mounted and cleared when it unmounts", () => {
    const { shortcutRef, unmount } = renderPanel();
    expect(typeof shortcutRef.current).toBe("function");
    unmount();
    expect(shortcutRef.current).toBeNull();
  });

  it("runs the same flow as the primary button: the push confirm with a remote", async () => {
    const { props, press } = renderPanel();
    await press();
    expect(screen.getByRole("alertdialog")).toBeDefined();
    expect(props.onCommitAndPush).not.toHaveBeenCalled();
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it("pushes straight away when the confirm is opted out", async () => {
    const { props, press } = renderPanel({ skipPushConfirm: true });
    await press();
    expect(props.onCommitAndPush).toHaveBeenCalledWith("fix: bug");
  });

  it("commits without a remote", async () => {
    const { props, press } = renderPanel({ hasRemote: false, pushDestination: null });
    await press();
    expect(props.onCommit).toHaveBeenCalledWith("fix: bug");
    expect(props.onCommitAndPush).not.toHaveBeenCalled();
  });

  it("commits without pushing for the Shift variant when a remote exists", async () => {
    const { props, press } = renderPanel();
    await press(true);
    expect(props.onCommit).toHaveBeenCalledWith("fix: bug");
    expect(props.onCommitAndPush).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("sends focus to the blocker instead of committing", async () => {
    const { props, press } = renderPanel({ stagedCount: 0 });
    await press();
    expect(props.onFocusBlocker).toHaveBeenCalledWith("staged-files");
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(props.onCommitAndPush).not.toHaveBeenCalled();
  });

  it("focuses the message box when the message is the blocker", async () => {
    const { press } = renderPanel({ commitMessage: "  " });
    await press();
    expect(document.activeElement).toBe(screen.getByLabelText("Commit message"));
  });

  it("does nothing while a commit is in flight, even once the staged list has emptied", async () => {
    let finishCommit: () => void = () => {};
    const onCommit = vi.fn(() => new Promise<void>((resolve) => (finishCommit = resolve)));
    const { props, press, rerender } = renderPanel({ onCommit });
    await press(true);
    expect(onCommit).toHaveBeenCalledTimes(1);

    // The refresh after the commit drops the staged count to zero, which would
    // read as a blocker and pull focus away from the list mid-commit.
    rerender(<CommitPanel {...props} onCommit={onCommit} stagedCount={0} />);
    await press(true);
    await press();
    expect(props.onFocusBlocker).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    await act(async () => finishCommit());
  });

  it("does not restart the push confirm that is already open", async () => {
    const { props, press } = renderPanel();
    await press();
    expect(screen.getByRole("alertdialog")).toBeDefined();
    expect(listPushCommits).toHaveBeenCalledTimes(1);

    await press();
    await press(true);
    // A second opening re-reads the outgoing range, which re-blocks the approval.
    expect(listPushCommits).toHaveBeenCalledTimes(1);
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(props.onCommitAndPush).not.toHaveBeenCalled();
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
  });

  it("still answers the chord typed in the message box", () => {
    const { props } = renderPanel({ hasRemote: false, pushDestination: null });
    fireEvent.keyDown(screen.getByLabelText("Commit message"), { key: "Enter", ctrlKey: true });
    expect(props.onCommit).toHaveBeenCalledWith("fix: bug");
  });
});
