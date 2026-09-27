/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { PushProgressEvent } from "@shared/types/ipc/gitPush";

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

import { CommitPanel } from "../CommitPanel";

const CWD = "/repo/wt";

function progress(stage: string, value: number | null): PushProgressEvent {
  return { cwd: CWD, stage, progress: value, processed: null, total: null };
}

function renderPanel(overrides: Partial<ComponentProps<typeof CommitPanel>> = {}) {
  const props: ComponentProps<typeof CommitPanel> = {
    stagedCount: 2,
    isDetachedHead: false,
    hasConflicts: false,
    hasRemote: true,
    pushDestination: { remote: "origin", branch: "feature/x" } as ComponentProps<
      typeof CommitPanel
    >["pushDestination"],
    worktreePath: CWD,
    currentBranch: "feature/x",
    commitMessage: "fix: bug",
    onCommitMessageChange: vi.fn(),
    onCommit: vi.fn().mockResolvedValue(undefined),
    onCommitAndPush: vi.fn().mockResolvedValue(undefined),
    isPushing: false,
    pushProgress: new Map(),
    pushTargetBranch: null,
    skipPushConfirm: false,
    onSetSkipPushConfirm: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<CommitPanel {...props} />) };
}

/** The counter the message box names as its description, as a reader hears it. */
function counterText(): string {
  const box = screen.getByLabelText("Commit message");
  const counter = document.getElementById(box.getAttribute("aria-describedby") ?? "");
  return counter?.textContent ?? "";
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CommitPanel composer", () => {
  it("warns on the counter only when the subject line itself is over the limit", () => {
    const longLine = "x".repeat(90);
    const { rerender, props } = renderPanel({ commitMessage: `short subject\n\n${longLine}` });
    const quiet = counterText();

    rerender(<CommitPanel {...props} commitMessage={longLine} />);
    const loud = counterText();

    expect(quiet).not.toMatch(/over/);
    expect(loud).toMatch(/over/);
  });

  it("names every determinate push stage as a progressbar and shows valueless stages as text", () => {
    const pushProgress = new Map([
      ["counting", progress("counting", 100)],
      ["writing", progress("writing", 37.4)],
      ["remote:", progress("remote:", null)],
    ]);
    renderPanel({ isPushing: true, pushProgress, pushTargetBranch: "origin/feature/x" });

    const bars = screen.getAllByRole("progressbar");
    expect(bars.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Counting objects",
      "Writing objects",
    ]);
    for (const bar of bars) {
      const now = Number(bar.getAttribute("aria-valuenow"));
      expect(Number.isInteger(now)).toBe(true);
      expect(now).toBeGreaterThanOrEqual(Number(bar.getAttribute("aria-valuemin")));
      expect(now).toBeLessThanOrEqual(Number(bar.getAttribute("aria-valuemax")));
    }
    // A stage with no percentage is still activity the user should see, but never
    // as a bar reading 0%.
    expect(screen.getByText("Remote")).toBeTruthy();
  });

  it("notes a push that has gone quiet, and drops the note when progress resumes", () => {
    vi.useFakeTimers();
    try {
      const first = new Map([["writing", progress("writing", 10)]]);
      const { rerender, props } = renderPanel({
        isPushing: true,
        pushProgress: first,
        pushTargetBranch: "origin/feature/x",
      });
      const status = () => screen.getByTestId("review-hub-commit-status").textContent ?? "";
      expect(status()).not.toMatch(/no new progress/);

      act(() => vi.advanceTimersByTime(20_000));
      expect(status()).toMatch(/no new progress/);

      const next = new Map([["writing", progress("writing", 40)]]);
      rerender(<CommitPanel {...props} pushProgress={next} />);
      expect(status()).not.toMatch(/no new progress/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names every unmet requirement, not just the first", () => {
    renderPanel({ isDetachedHead: true, stagedCount: 0, commitMessage: "" });
    const text = screen.getByTestId("review-hub-commit-status").textContent ?? "";
    expect(text).toMatch(/branch/);
    expect(text).toMatch(/stage files/);
    expect(text).toMatch(/commit message/);
  });

  it("keeps the submitted count while the commit empties the staged list", async () => {
    let finishCommit: () => void = () => {};
    const onCommitAndPush = vi.fn(() => new Promise<void>((resolve) => (finishCommit = resolve)));
    const { rerender, props } = renderPanel({ skipPushConfirm: true, onCommitAndPush });
    fireEvent.click(screen.getByRole("button", { name: /^Commit & push$/i }));
    rerender(<CommitPanel {...props} onCommitAndPush={onCommitAndPush} stagedCount={0} />);
    expect(screen.getByTestId("review-hub-commit-status").textContent).toContain("2 files");
    finishCommit();
  });

  it("speaks the push target through a status region, not the visible line", () => {
    renderPanel({ isPushing: true, pushTargetBranch: "origin/feature/x" });
    const live = screen.getByRole("status");
    expect(live.textContent).toContain("origin/feature/x");
    expect(screen.getByTestId("review-hub-commit-status").getAttribute("role")).toBeNull();
  });

  it("names the destination before the user commits and pushes", () => {
    renderPanel();
    expect(screen.getByTestId("review-hub-commit-status").textContent).toContain(
      "origin/feature/x"
    );
  });

  it("moves focus to the status line when a detached-HEAD commit is attempted", () => {
    renderPanel({ isDetachedHead: true });
    fireEvent.click(screen.getByRole("button", { name: /^Commit & push$/i }));
    expect(document.activeElement).toBe(screen.getByTestId("review-hub-commit-status"));
  });

  it("never reports a zero staged count while a commit-and-push is in flight", () => {
    renderPanel({ stagedCount: 0, isPushing: true, pushTargetBranch: "origin/feature/x" });
    const buttons = screen.getAllByRole("button");
    for (const button of buttons) expect(button.textContent).not.toMatch(/\(0\)/);
    expect(screen.getByTestId("review-hub-commit-status").textContent).not.toMatch(/0 files/);
  });
});
