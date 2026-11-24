/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import type { ComponentProps, ReactNode, RefObject } from "react";

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({ isOpen, children }: { isOpen: boolean; children?: ReactNode }) =>
    isOpen ? <div role="alertdialog">{children}</div> : null,
}));

import { CommitPanel } from "../CommitPanel";
import type { CommitShortcutHandler } from "../commitShortcut";

const listPushCommits = vi.fn();

/**
 * A branch with no commit yet, with a remote configured (#17588). Git names no
 * push destination for it, so the status carries `pushDestination: null`.
 */
function renderUnborn(overrides: Partial<ComponentProps<typeof CommitPanel>> = {}) {
  const shortcutRef: RefObject<CommitShortcutHandler | null> = { current: null };
  const props: ComponentProps<typeof CommitPanel> = {
    stagedCount: 1,
    stagedPaths: ["README.md"],
    isDetachedHead: false,
    hasConflicts: false,
    hasRemote: true,
    pushDestination: null,
    isUnbornBranch: true,
    worktreePath: "/repo",
    currentBranch: "main",
    commitMessage: "Initial commit",
    onCommitMessageChange: vi.fn(),
    onCommit: vi.fn().mockResolvedValue(undefined),
    onCommitAndPush: vi.fn().mockResolvedValue(undefined),
    onCommitThenReviewPush: vi.fn().mockResolvedValue(undefined),
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
  const clickPrimary = async () => {
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-hub-commit-primary"));
    });
  };
  return { props, press, clickPrimary, ...view };
}

function statusText(): string {
  return screen.getByTestId("review-hub-commit-status").textContent ?? "";
}

beforeEach(() => {
  listPushCommits.mockReset();
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

describe("CommitPanel — first commit on a branch with a remote (#17588)", () => {
  it("commits, then hands the push to its own review, without a confirm it can't fill", async () => {
    const { props, clickPrimary } = renderUnborn();

    await clickPrimary();

    expect(props.onCommitThenReviewPush).toHaveBeenCalledWith("Initial commit");
    expect(props.onCommitAndPush).not.toHaveBeenCalled();
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(listPushCommits).not.toHaveBeenCalled();
  });

  // The opt-out skips this panel's confirm. A first push never had one, so
  // there is nothing to skip: its review still runs.
  it("takes the same route when the confirm is opted out", async () => {
    const { props, clickPrimary } = renderUnborn({ skipPushConfirm: true });

    await clickPrimary();

    expect(props.onCommitThenReviewPush).toHaveBeenCalledTimes(1);
    expect(props.onCommitAndPush).not.toHaveBeenCalled();
  });

  it("answers the shortcut the same way, and Shift still commits only", async () => {
    const { props, press } = renderUnborn();

    await press();
    expect(props.onCommitThenReviewPush).toHaveBeenCalledWith("Initial commit");

    await press(true);
    expect(props.onCommit).toHaveBeenCalledWith("Initial commit");
    expect(props.onCommitThenReviewPush).toHaveBeenCalledTimes(1);
  });

  it("holds the composer busy until the commit and its push review finish", async () => {
    let finish!: () => void;
    const onCommitThenReviewPush = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { clickPrimary } = renderUnborn({ onCommitThenReviewPush });
    const message = () => screen.getByLabelText("Commit message") as HTMLTextAreaElement;

    await clickPrimary();
    expect(message().disabled).toBe(true);
    expect(screen.getByTestId("review-hub-commit-primary").getAttribute("aria-disabled")).toBe(
      "true"
    );
    await clickPrimary();
    expect(onCommitThenReviewPush).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    expect(message().disabled).toBe(false);
    await clickPrimary();
    expect(onCommitThenReviewPush).toHaveBeenCalledTimes(2);
  });

  it("says the push is reviewed after the commit instead of warning of a missing destination", () => {
    renderUnborn();

    const line = statusText();
    expect(line).toContain("1 file staged");
    expect(line).toContain("first commit");
    expect(line).toContain("review the push next");
    expect(line).not.toContain("no push destination");
    const status = screen.getByTestId("review-hub-commit-status");
    expect(status.querySelector("[data-severity-glyph]")).toBeNull();
  });

  it("still names the missing destination when the branch already has commits", async () => {
    const { props, clickPrimary } = renderUnborn({ isUnbornBranch: false });

    expect(statusText()).toContain("no push destination");
    const status = screen.getByTestId("review-hub-commit-status");
    expect(status.querySelector("[data-severity-glyph]")).not.toBeNull();
    await clickPrimary();

    expect(screen.getByRole("alertdialog")).toBeDefined();
    expect(screen.getByTestId("commit-panel-push-no-destination")).toBeDefined();
    expect(props.onCommitThenReviewPush).not.toHaveBeenCalled();
  });

  it("commits plainly when there is no remote", async () => {
    const { props, clickPrimary } = renderUnborn({ hasRemote: false });

    await clickPrimary();

    expect(props.onCommit).toHaveBeenCalledWith("Initial commit");
    expect(props.onCommitThenReviewPush).not.toHaveBeenCalled();
  });

  it("keeps the blockers ahead of the route", async () => {
    const { props, clickPrimary } = renderUnborn({ stagedCount: 0, stagedPaths: [] });

    await clickPrimary();

    expect(props.onCommitThenReviewPush).not.toHaveBeenCalled();
    expect(props.onFocusBlocker).toHaveBeenCalledWith("staged-files");
  });
});
