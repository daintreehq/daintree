/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { WorktreeState } from "@/types";
import type { WorktreeChanges } from "@shared/types/git";
import type { WorktreeLifecycleStatus } from "@shared/types/worktree";
import type { ComputedSubtitle } from "../hooks/useWorktreeStatus";
import { TooltipProvider } from "@/components/ui/tooltip";
import { isCardContentEvent } from "../cardClickTarget";
import { actionService } from "@/services/ActionService";
import { useReviewMarksStore } from "@/store/reviewMarksStore";
import {
  WorktreeDetailsSection,
  WorktreeDeleteErrorBanner,
  WorktreeIssueErrorBanner,
  type WorktreeDetailsSectionProps,
} from "../WorktreeDetailsSection";

const mockAnimate = vi.fn();
let mockReducedMotion = false;

vi.mock("framer-motion", () => {
  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...props }, ref) => (
      <div ref={ref} {...props}>
        {children}
      </div>
    )
  );
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    LazyMotion: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    domAnimation: {},
    domMax: {},
    m: { div: MotionDiv },
    motion: { div: MotionDiv },
    useReducedMotion: () => mockReducedMotion,
  };
});

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

const avatarLookups = vi.hoisted(() => ({
  calls: [] as Array<{ email?: string; cwd?: string; enabled?: boolean }>,
}));
vi.mock("@/hooks/useForgeAuthorAvatar", () => ({
  useForgeAuthorAvatar: (args: { email?: string; cwd?: string; enabled?: boolean }) => {
    avatarLookups.calls.push(args);
    return undefined;
  },
}));

vi.mock("../../LifecycleCommandApprovalDialog", () => ({
  LifecycleCommandApprovalDialog: (props: { isOpen: boolean; setupAwaitingApproval: boolean }) =>
    props.isOpen ? (
      <div
        data-testid="approval-dialog"
        data-setup-awaiting-approval={String(props.setupAwaitingApproval)}
      />
    ) : null,
}));

const noop = () => {};
const noopAsync = async () => {};

const baseWorktree: WorktreeState = {
  id: "test-wt",
  worktreeId: "test-wt",
  path: "/tmp/test-wt",
  name: "test-branch",
  branch: "feature/test",
  isCurrent: false,
  isMainWorktree: false,
  worktreeChanges: {
    worktreeId: "test-wt",
    changedFileCount: 3,
    insertions: 5,
    deletions: 2,
    changes: [],
    rootPath: "",
  },
  lastActivityTimestamp: null,
};

const baseSubtitle: ComputedSubtitle = { text: "3 files changed", tone: "muted" };

const baseProps: WorktreeDetailsSectionProps = {
  worktree: baseWorktree,
  isExpanded: false,
  hasChanges: true,
  computedSubtitle: baseSubtitle,
  worktreeErrors: [],
  isFocused: false,
  onToggleExpand: noop,
  onPathClick: noop,
  onDismissError: noop,
  onRetryError: noopAsync,
};

function withChanges(overrides: Partial<WorktreeChanges>): WorktreeState {
  return {
    ...baseWorktree,
    worktreeChanges: { ...baseWorktree.worktreeChanges, ...overrides } as WorktreeChanges,
  };
}

function renderSection(overrides: Partial<WorktreeDetailsSectionProps> = {}) {
  return render(
    <TooltipProvider>
      <WorktreeDetailsSection {...baseProps} {...overrides} />
    </TooltipProvider>
  );
}

describe("WorktreeDetailsSection count pill bump", () => {
  // jsdom has no Web Animations API; the bump calls element.animate().
  const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");

  beforeEach(() => {
    mockAnimate.mockClear();
    mockReducedMotion = false;
    delete document.body.dataset.performanceMode;
    HTMLElement.prototype.animate = mockAnimate;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
    else delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });

  it("renders file count without calling animate on initial mount", () => {
    renderSection();
    expect(screen.getByText(/3 files/)).toBeDefined();
    expect(mockAnimate).not.toHaveBeenCalled();
  });

  it("calls animate when changedFileCount changes after mount", () => {
    const { rerender } = renderSection();

    const updated = withChanges({ changedFileCount: 5, insertions: 10, deletions: 3 });

    rerender(
      <TooltipProvider>
        <WorktreeDetailsSection {...baseProps} worktree={updated} />
      </TooltipProvider>
    );

    expect(mockAnimate).toHaveBeenCalledTimes(1);
    expect(mockAnimate.mock.contexts[0]).toBe(screen.getByText(/5 files/));
    expect(mockAnimate).toHaveBeenCalledWith(
      [
        { transform: "scale(1)", easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
        { transform: "scale(1.06)", easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
        { transform: "scale(1)" },
      ],
      { duration: 200 }
    );
  });

  it("coalesces rapid changes within 200ms gate", () => {
    const { rerender } = renderSection();

    const first = withChanges({ changedFileCount: 5, insertions: 10, deletions: 3 });
    const second = withChanges({ changedFileCount: 7, insertions: 12, deletions: 5 });
    const third = withChanges({ changedFileCount: 9, insertions: 15, deletions: 8 });

    rerender(
      <TooltipProvider>
        <WorktreeDetailsSection {...baseProps} worktree={first} />
      </TooltipProvider>
    );
    rerender(
      <TooltipProvider>
        <WorktreeDetailsSection {...baseProps} worktree={second} />
      </TooltipProvider>
    );
    rerender(
      <TooltipProvider>
        <WorktreeDetailsSection {...baseProps} worktree={third} />
      </TooltipProvider>
    );

    expect(mockAnimate).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/9 files/)).toBeDefined();
  });

  it("re-arms bump after throttle window expires", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = renderSection();

      const first = withChanges({ changedFileCount: 5, insertions: 10, deletions: 3 });

      rerender(
        <TooltipProvider>
          <WorktreeDetailsSection {...baseProps} worktree={first} />
        </TooltipProvider>
      );
      expect(mockAnimate).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(250);

      const second = withChanges({ changedFileCount: 7, insertions: 12, deletions: 5 });

      rerender(
        <TooltipProvider>
          <WorktreeDetailsSection {...baseProps} worktree={second} />
        </TooltipProvider>
      );

      expect(mockAnimate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips animation when reduced motion is preferred", () => {
    mockReducedMotion = true;
    const { rerender } = renderSection();

    const updated = withChanges({ changedFileCount: 5, insertions: 10, deletions: 3 });

    rerender(
      <TooltipProvider>
        <WorktreeDetailsSection {...baseProps} worktree={updated} />
      </TooltipProvider>
    );

    expect(mockAnimate).not.toHaveBeenCalled();
    expect(screen.getByText(/5 files/)).toBeDefined();
  });

  it("does not bump when reduced motion toggles off without a count change", () => {
    mockReducedMotion = true;
    const { rerender } = renderSection();

    mockReducedMotion = false;
    rerender(
      <TooltipProvider>
        <WorktreeDetailsSection {...baseProps} />
      </TooltipProvider>
    );

    expect(mockAnimate).not.toHaveBeenCalled();
  });

  it("keeps the count span DOM node stable across changes", () => {
    const { rerender } = renderSection();
    const firstNode = screen.getByText(/3 files/);

    const updated = withChanges({ changedFileCount: 5, insertions: 10, deletions: 3 });

    rerender(
      <TooltipProvider>
        <WorktreeDetailsSection {...baseProps} worktree={updated} />
      </TooltipProvider>
    );

    const secondNode = screen.getByText(/5 files/);
    expect(firstNode).toBe(secondNode);
  });

  it("does not animate when expanded (count span not rendered)", () => {
    const { rerender } = renderSection({ isExpanded: false });

    const updated = withChanges({ changedFileCount: 5, insertions: 10, deletions: 3 });

    rerender(
      <TooltipProvider>
        <WorktreeDetailsSection {...baseProps} isExpanded={true} worktree={updated} />
      </TooltipProvider>
    );

    expect(mockAnimate).not.toHaveBeenCalled();
  });

  it("does not animate when count span not rendered, then allows bump after collapse", () => {
    const { rerender } = renderSection({ isExpanded: true });

    const collapsed = withChanges({ changedFileCount: 5, insertions: 10, deletions: 3 });

    rerender(
      <TooltipProvider>
        <WorktreeDetailsSection {...baseProps} isExpanded={false} worktree={collapsed} />
      </TooltipProvider>
    );

    expect(mockAnimate).toHaveBeenCalledTimes(1);
  });

  it("skips animation in performance mode", () => {
    document.body.dataset.performanceMode = "true";
    const { rerender } = renderSection();

    const updated = withChanges({ changedFileCount: 5, insertions: 10, deletions: 3 });

    rerender(
      <TooltipProvider>
        <WorktreeDetailsSection {...baseProps} worktree={updated} />
      </TooltipProvider>
    );

    expect(mockAnimate).not.toHaveBeenCalled();
    expect(screen.getByText(/5 files/)).toBeDefined();
  });
});

describe("WorktreeDetailsSection — reviewState surfaces", () => {
  it('replaces churn subtitle with conflict callout when reviewState is "conflicted"', () => {
    renderSection({
      reviewState: "conflicted",
      worktree: withChanges({
        changedFileCount: 4,
        changes: [{ path: "a.ts", status: "conflicted", insertions: null, deletions: null }],
      }),
    });
    expect(screen.getByText("Conflicts need review")).toBeDefined();
    expect(screen.queryByText(/files/)).toBeNull();
  });

  it("renders the Review & Commit button when there are changes", () => {
    const onOpenReviewHub = vi.fn();
    renderSection({
      reviewState: "has-changes",
      onOpenReviewHub,
    });
    const button = screen.getByLabelText("Review & commit");
    expect(button).toBeDefined();
    fireEvent.click(button);
    expect(onOpenReviewHub).toHaveBeenCalledTimes(1);
  });

  it('renders a Review & Push button when reviewState is "unpushed-clean"', () => {
    const onOpenReviewHub = vi.fn();
    renderSection({
      reviewState: "unpushed-clean",
      hasChanges: false,
      computedSubtitle: { text: "fix: stuff", tone: "muted" },
      onOpenReviewHub,
      worktree: {
        ...baseWorktree,
        worktreeChanges: {
          ...baseWorktree.worktreeChanges,
          changedFileCount: 0,
          ahead: 2,
        } as WorktreeChanges,
      },
    });
    expect(screen.queryByLabelText("Review & commit")).toBeNull();
    expect(screen.queryByText("Conflicts need review")).toBeNull();
    expect(screen.getByText("fix: stuff")).toBeDefined();
    const button = screen.getByLabelText("Review & push");
    fireEvent.click(button);
    expect(onOpenReviewHub).toHaveBeenCalledTimes(1);
  });

  it("renders no review-hub button when the tree is clean with nothing to push", () => {
    renderSection({
      reviewState: null,
      hasChanges: false,
      computedSubtitle: { text: "fix: stuff", tone: "muted" },
      onOpenReviewHub: vi.fn(),
      worktree: {
        ...baseWorktree,
        worktreeChanges: {
          ...baseWorktree.worktreeChanges,
          changedFileCount: 0,
        } as WorktreeChanges,
      },
    });
    expect(screen.queryByLabelText("Review & commit")).toBeNull();
    expect(screen.queryByLabelText("Review & push")).toBeNull();
  });
});

describe("WorktreeDetailsSection activity chip (collapsed row)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z").getTime());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function withCommit(
    overrides: Partial<WorktreeChanges>,
    lastActivityTimestamp: number | null = null
  ): WorktreeState {
    return {
      ...withChanges({
        lastCommitTimestampMs: Date.now() - 120_000,
        lastCommitAuthor: { name: "Jane Doe", email: "jane@example.com" },
        lastCommitMessage: "fix: stuff",
        ...overrides,
      }),
      lastActivityTimestamp,
    };
  }

  it("renders the canonical activity time but never an avatar in the row", () => {
    const { container } = renderSection({ worktree: withCommit({}), hasChanges: false });
    expect(container.textContent).toContain("2m");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("group", { name: "Last activity" })).toBeDefined();
  });

  it("drives both the dot and visible time from a recent activity timestamp", () => {
    renderSection({ worktree: withCommit({}, Date.now()), hasChanges: false });
    const chip = screen.getByRole("group", { name: "Last activity" });
    expect(chip.querySelector("div[aria-hidden='true']")).not.toBeNull();
    expect(chip.textContent).toBe("now");
  });

  it("uses the commit as a defensive activity fallback", () => {
    renderSection({ worktree: withCommit({}, null), hasChanges: false });
    const chip = screen.getByRole("group", { name: "Last activity" });
    expect(chip.querySelector("div[aria-hidden='true']")).not.toBeNull();
    expect(chip.textContent).toBe("2m");
  });

  it("never paints an agent icon in the row, even for an agent committer", () => {
    const worktree = withCommit({
      lastCommitAuthor: { name: "Codex", email: "noreply@codex.openai.com" },
    });
    renderSection({ worktree, hasChanges: false });
    // Scoped to the chip itself. The row legitimately carries other icons —
    // the disclosure chevron, the Review Hub control — so asserting "no svg
    // anywhere in the row" tested the surrounding chrome rather than the rule,
    // which is that the activity chip never paints committer identity.
    const chip = screen.getByRole("group", { name: "Last activity" });
    expect(chip.querySelector("svg")).toBeNull();
    expect(chip.querySelector("img")).toBeNull();
  });
});

describe("WorktreeDetailsSection — quiet git detail (#13777)", () => {
  const quietDetail = <div data-testid="quiet-git-detail">git identity</div>;
  const worktree = {
    ...withChanges({ lastCommitTimestampMs: Date.now() - 120_000, lastCommitMessage: "fix: x" }),
  };

  it("leaves the activity to the expanded panel's own last-active line", () => {
    const resting = renderSection({ worktree, quietGitDetail: quietDetail });
    expect(screen.queryByRole("group", { name: "Last activity" })).toBeNull();
    expect(screen.queryByTestId("quiet-git-detail")).toBeNull();
    resting.unmount();

    renderSection({ worktree, quietGitDetail: quietDetail, isExpanded: true });
    expect(screen.getByTestId("quiet-git-detail")).not.toBeNull();
    // Exactly one: the panel's line, not a second chip beside it.
    expect(screen.getAllByRole("group", { name: "Last activity" })).toHaveLength(1);
  });

  it("keeps the dirty-state summary on the resting row", () => {
    const { container } = renderSection({ worktree, quietGitDetail: quietDetail });
    expect(container.textContent).toContain("3 files");
  });

  it("takes the Review Hub shortcut off the resting row", () => {
    renderSection({
      reviewState: "has-changes",
      onOpenReviewHub: vi.fn(),
      quietGitDetail: quietDetail,
    });
    expect(screen.queryByLabelText("Review & commit")).toBeNull();
  });

  it("keeps the shortcut while the worktree is conflicted, where it is the way out", () => {
    renderSection({
      reviewState: "conflicted",
      onOpenReviewHub: vi.fn(),
      quietGitDetail: quietDetail,
      worktree: withChanges({
        changedFileCount: 1,
        changes: [{ path: "a.ts", status: "conflicted", insertions: null, deletions: null }],
      }),
    });
    expect(screen.getByText("Conflicts need review")).not.toBeNull();
    expect(screen.getByLabelText("Review & commit")).not.toBeNull();
  });
});

// Issue #12087 — the banners mount as bare siblings of the card's `relative
// z-10` content column, under a full-card select overlay whose click handler
// selects the worktree. Their buttons have to reach the user AND stop the click
// there; jsdom can't test the stacking half (no layout engine, no CSS), so the
// paint-order invariant is asserted as a source contract in
// WorktreeCardInteraction.test.tsx and the propagation half is asserted here.
describe("worktree error banners (issue #12087)", () => {
  const banners = [
    {
      name: "delete",
      renderBanner: (props: { onRetry: () => void; onDismiss: () => void }) => (
        <WorktreeDeleteErrorBanner message="cannot remove a locked working tree" {...props} />
      ),
    },
    {
      name: "issue",
      renderBanner: (props: { onRetry: () => void; onDismiss: () => void }) => (
        <WorktreeIssueErrorBanner
          message="network unreachable"
          mutationType="attach-issue"
          {...props}
        />
      ),
    },
  ];

  describe.each(banners)("$name banner", ({ renderBanner }) => {
    it.each([["Retry"], ["Dismiss"]])(
      "%s fires its own handler without bubbling to the card's click handler",
      (label) => {
        const onRetry = vi.fn();
        const onDismiss = vi.fn();
        const onCardClick = vi.fn();
        render(<div onClick={onCardClick}>{renderBanner({ onRetry, onDismiss })}</div>);

        fireEvent.click(screen.getByRole("button", { name: label }));

        const [fired, quiet] = label === "Retry" ? [onRetry, onDismiss] : [onDismiss, onRetry];
        expect(fired).toHaveBeenCalledTimes(1);
        expect(quiet).not.toHaveBeenCalled();
        // The card root selects the worktree on any click that reaches it, so a
        // bubbled Dismiss would switch worktrees as a side effect.
        expect(onCardClick).not.toHaveBeenCalled();
      }
    );

    it.each([["Retry"], ["Dismiss"]])(
      "hands focus to the card when %s clears the error and removes the banner",
      (label) => {
        function Card({ shown }: { shown: boolean }) {
          return (
            <div data-worktree-row="">
              <button type="button" data-card-select-overlay="" aria-label="Select worktree" />
              {shown && renderBanner({ onRetry: () => {}, onDismiss: () => {} })}
            </div>
          );
        }
        const { rerender } = render(<Card shown />);
        const button = screen.getByRole("button", { name: label });
        button.focus();
        expect(document.activeElement).toBe(button);
        rerender(<Card shown={false} />);
        expect(document.activeElement?.hasAttribute("data-card-select-overlay")).toBe(true);
      }
    );
  });

  it("renders no action buttons when neither handler is supplied", () => {
    const { rerender } = render(<WorktreeDeleteErrorBanner message="disk on fire" />);
    // Assert the banner is actually on screen first, so "no buttons" can't pass
    // by way of nothing having rendered. Checked via the message passed in — an
    // input/output contract — rather than the title, which is microcopy the
    // implementation owns.
    expect(screen.getByRole("alert").textContent).toContain("disk on fire");
    expect(screen.queryByRole("button")).toBeNull();

    rerender(<WorktreeIssueErrorBanner message="disk on fire" mutationType="detach-issue" />);
    expect(screen.getByRole("alert").textContent).toContain("disk on fire");
    expect(screen.queryByRole("button")).toBeNull();
  });

  // #12418. The host stopped cutting git's stderr at the first newline, so the
  // banner now receives multi-line text. The later lines are the ones that name
  // the worktree still holding the branch, so they have to reach the DOM whole
  // — and the actions have to stay reachable underneath them.
  it("renders a multi-line delete error without dropping or merging its lines", () => {
    const message =
      "Worktree removed. Couldn't delete branch 'feature/x': error: Cannot delete branch 'feature/x' checked out at '/other/tree'\nhint: remove that worktree first";
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    render(<WorktreeDeleteErrorBanner message={message} onRetry={onRetry} onDismiss={onDismiss} />);

    // Read `textContent` directly: Testing Library's matchers normalise
    // whitespace, which would collapse the newline this test exists to prove.
    const text = screen.getByTestId("worktree-delete-error-banner").textContent ?? "";
    expect(text).toContain(message);
    expect(text).toContain("\nhint: remove that worktree first");

    expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss" })).not.toBeNull();
  });
});

describe("WorktreeDetailsSection — repository command approval", () => {
  beforeEach(() => {
    vi.mocked(actionService.dispatch).mockClear();
  });

  it("offers a review when the host reports commands waiting for approval", async () => {
    const onCardClick = vi.fn();
    render(
      <div onClick={onCardClick}>
        <TooltipProvider>
          <WorktreeDetailsSection
            {...baseProps}
            worktree={{
              ...baseWorktree,
              lifecycleCommandsNeedApproval: true,
              lifecycleStatus: {
                phase: "setup",
                state: "needs-approval",
                startedAt: 1,
                completedAt: 1,
              },
            }}
          />
        </TooltipProvider>
      </div>
    );

    fireEvent.click(screen.getByRole("button", { name: /review commands/i }));

    const dialog = await screen.findByTestId("approval-dialog");
    expect(dialog.getAttribute("data-setup-awaiting-approval")).toBe("true");
    expect(onCardClick).not.toHaveBeenCalled();
    expect(actionService.dispatch).not.toHaveBeenCalled();
  });

  it("runs a skipped setup once its commands are already approved", () => {
    renderSection({
      worktree: {
        ...baseWorktree,
        lifecycleStatus: { phase: "setup", state: "needs-approval", startedAt: 1, completedAt: 1 },
      },
    });

    expect(screen.queryByRole("button", { name: /review commands/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /run setup/i }));

    expect(actionService.dispatch).toHaveBeenCalledWith(
      "worktree.lifecycle.retrySetup",
      { worktreeId: baseWorktree.id },
      expect.objectContaining({ source: "user" })
    );
  });

  it("keeps the approval request visible while Details is expanded", () => {
    renderSection({
      isExpanded: true,
      worktree: { ...baseWorktree, lifecycleCommandsNeedApproval: true },
    });

    expect(screen.getByRole("button", { name: /review commands/i })).toBeDefined();
  });

  it("still offers the skipped setup after a resource action overwrote the lifecycle slot", () => {
    renderSection({
      worktree: {
        ...baseWorktree,
        setupStatus: { state: "needs-approval", stage: "setup-script", startedAt: 1 },
        lifecycleStatus: {
          phase: "resource-status",
          state: "success",
          startedAt: 2,
          completedAt: 3,
        },
      },
    });

    expect(screen.getByRole("button", { name: /run setup/i })).toBeDefined();
  });

  it("keeps a failed plugin step retryable after a resource action overwrote the lifecycle slot (#13807)", () => {
    renderSection({
      worktree: {
        ...baseWorktree,
        setupStatus: {
          state: "failed",
          stage: "plugin-steps",
          startedAt: 1,
          error: 'Acme "Provision DB" failed: quota exceeded',
        },
        lifecycleStatus: {
          phase: "resource-status",
          state: "success",
          startedAt: 2,
          completedAt: 3,
        },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /retry setup/i }));
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "worktree.lifecycle.retrySetup",
      { worktreeId: baseWorktree.id },
      expect.objectContaining({ source: "user" })
    );
    expect(document.body.textContent).toContain('Acme "Provision DB" failed: quota exceeded');
  });

  it("offers no retry while setup is still running, whatever an overwritten slot says", () => {
    renderSection({
      worktree: {
        ...baseWorktree,
        setupStatus: { state: "running", stage: "plugin-steps", startedAt: 1 },
        lifecycleStatus: { phase: "resource-status", state: "failed", startedAt: 2, error: "down" },
      },
    });

    expect(screen.queryByRole("button", { name: /retry setup/i })).toBeNull();
  });

  it("asks to allow plugin steps, not to approve commands, when those are what setup waits on", () => {
    renderSection({
      worktree: {
        ...baseWorktree,
        lifecycleCommandsNeedApproval: true,
        setupStatus: { state: "needs-approval", stage: "plugin-steps", startedAt: 1 },
      },
    });

    expect(screen.getByText("Setup is waiting for you to allow plugin steps")).toBeDefined();
    expect(screen.getByRole("button", { name: /review steps/i })).toBeDefined();
  });

  it("stays out of the way when nothing needs approval", () => {
    renderSection();
    expect(screen.queryByTestId("worktree-command-approval")).toBeNull();
  });
});

describe("WorktreeDetailsSection review change hint", () => {
  const COMMIT = "c".repeat(40);

  function setMark() {
    useReviewMarksStore.setState({
      marks: {
        "test-wt": {
          markedAt: 2000,
          capturedAt: 1000,
          head: { kind: "branch", branch: "feature/test", commit: COMMIT },
          base: { ref: null, tip: null },
          complete: true,
          pathCount: 1,
          revision: 1,
        },
      },
      loaded: true,
    });
  }

  afterEach(() => {
    useReviewMarksStore.setState({ marks: {}, revision: 0, loaded: false });
  });

  it("shows the hint beside the file count once HEAD has moved", () => {
    setMark();
    renderSection({ worktree: withChanges({ headOid: "d".repeat(40) }) });
    expect(screen.getByText(/Changed since review/)).toBeDefined();
    expect(screen.getByText(/3 files/)).toBeDefined();
  });

  it("shows nothing when the marked worktree hasn't been seen to move", () => {
    setMark();
    renderSection({ worktree: withChanges({ headOid: COMMIT, latestFileMtime: 900 }) });
    expect(screen.queryByText(/Changed since review/)).toBeNull();
  });

  it("shows nothing without a mark", () => {
    renderSection({ worktree: withChanges({ headOid: "d".repeat(40) }) });
    expect(screen.queryByText(/Changed since review/)).toBeNull();
  });

  it("shows nothing for a mark made on another branch", () => {
    setMark();
    renderSection({
      worktree: { ...withChanges({ headOid: "d".repeat(40) }), branch: "feature/other" },
    });
    expect(screen.queryByText(/Changed since review/)).toBeNull();
  });

  it("shows the hint on a clean worktree whose HEAD moved", () => {
    setMark();
    renderSection({
      worktree: withChanges({ headOid: "d".repeat(40), changedFileCount: 0 }),
      hasChanges: false,
    });
    expect(screen.getByText(/Changed since review/)).toBeDefined();
  });
});

describe("WorktreeDetailsSection resource controls", () => {
  it.each([
    { status: "stopped", label: "Resume resource", callback: "onResourceResume" },
    { status: "running", label: "Pause resource", callback: "onResourcePause" },
    { status: "running", label: "Connect to resource", callback: "onResourceConnect" },
  ] as const)(
    "runs the visible $label button and mounts no hidden menu trigger beside it",
    ({ status, label, callback }) => {
      const handlers = {
        onResourceResume: vi.fn(),
        onResourcePause: vi.fn(),
        onResourceConnect: vi.fn(),
      };
      const { container } = renderSection({
        hasResourceConfig: true,
        resourceStatus: status,
        ...handlers,
      });

      fireEvent.click(screen.getByRole("button", { name: label }));

      expect(handlers[callback]).toHaveBeenCalledTimes(1);
      // A clipped 1px trigger no pointer can reach opened a menu nobody could use.
      expect(screen.queryByText("Resource actions")).toBeNull();
      expect(container.querySelector("[data-radix-context-menu-trigger], .sr-only")).toBeNull();
    }
  );
});

// #17072 — every card holds this section; a resting one asks for no avatar.
describe("WorktreeDetailsSection forge avatar lookup", () => {
  const authored = withChanges({
    lastCommitAuthor: { name: "Jane Doe", email: "jane@example.com" },
    lastCommitTimestampMs: Date.now() - 60_000,
  });

  beforeEach(() => {
    avatarLookups.calls = [];
  });

  it("asks for nothing while the details are closed, and for the author once opened", () => {
    const { rerender } = renderSection({ worktree: authored, isExpanded: false });
    expect(avatarLookups.calls.length).toBeGreaterThan(0);
    expect(avatarLookups.calls.every((call) => call.enabled === false)).toBe(true);

    rerender(
      <TooltipProvider>
        <WorktreeDetailsSection {...baseProps} worktree={authored} isExpanded={true} />
      </TooltipProvider>
    );
    expect(avatarLookups.calls.at(-1)).toEqual({
      email: "jane@example.com",
      cwd: authored.path,
      enabled: true,
    });
  });
});

describe("WorktreeDetailsSection — what a running lifecycle phase is doing (#17115)", () => {
  const NOW = 1_000_000;

  function runningSetup(overrides: Partial<WorktreeLifecycleStatus> = {}): WorktreeLifecycleStatus {
    return {
      phase: "setup",
      state: "running",
      commandIndex: 0,
      totalCommands: 2,
      currentCommand: "node scripts/link-shared-node-modules.mjs",
      startedAt: NOW - 65_000,
      commandStartedAt: NOW - 42_000,
      output: "Shared node_modules is behind package-lock.json.\nRefreshing it with npm ci\n",
      ...overrides,
    };
  }

  const succeededRun: WorktreeLifecycleStatus = {
    phase: "setup",
    state: "success",
    totalCommands: 2,
    startedAt: NOW - 90_000,
    completedAt: NOW - 30_000,
    output: "Refreshing it with npm ci\nadded 1200 packages\n",
  };

  /**
   * The section on a card that selects on a click into its content, by the
   * card's own filter, with the select overlay a sidebar card hands focus to.
   */
  function card(worktree: WorktreeState, onCardClick: () => void, isExpanded = false) {
    return (
      <div data-worktree-row="">
        <button type="button" data-card-select-overlay="" aria-label="Select worktree" />
        <div onClick={(event) => isCardContentEvent(event) && onCardClick()}>
          <TooltipProvider>
            <WorktreeDetailsSection
              {...baseProps}
              worktree={worktree}
              isExpanded={isExpanded}
              isLifecycleRunning={worktree.lifecycleStatus?.state === "running"}
              lifecycleLabel={
                worktree.lifecycleStatus?.state === "running"
                  ? `Running setup: ${worktree.lifecycleStatus.currentCommand ?? ""}`
                  : undefined
              }
            />
          </TooltipProvider>
        </div>
      </div>
    );
  }

  function renderRunning(status: WorktreeLifecycleStatus, onCardClick = vi.fn()) {
    const view = render(card({ ...baseWorktree, lifecycleStatus: status }, onCardClick));
    // Past the gate that keeps a quick run from adding a row at all.
    act(() => {
      vi.advanceTimersByTime(400);
    });
    return view;
  }

  function runRow(): HTMLElement {
    return screen.getByTestId("worktree-lifecycle-run");
  }

  function openDisclosure(details: HTMLDetailsElement) {
    act(() => {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    });
  }

  function disclosureOf(element: HTMLElement): HTMLDetailsElement {
    const details = element.closest("details") ?? element.querySelector("details");
    if (!(details instanceof HTMLDetailsElement)) throw new Error("no disclosure");
    return details;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says which command of how many is running, and for how long, without being opened", () => {
    renderRunning(runningSetup());

    expect(runRow().textContent).toContain("Command 1 of 2");
    expect(runRow().textContent).toContain("42s");

    // A second at a time: each tick re-arms the next from its own render.
    for (let second = 0; second < 3; second++) {
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
    }
    expect(runRow().textContent).toContain("45s");
  });

  it("restarts the clock when the next command starts, and moves on to minutes past one", () => {
    const view = renderRunning(runningSetup());

    view.rerender(
      card(
        {
          ...baseWorktree,
          lifecycleStatus: runningSetup({
            commandIndex: 1,
            currentCommand: "npm run build",
            commandStartedAt: NOW + 400,
          }),
        },
        vi.fn()
      )
    );
    expect(runRow().textContent).toContain("Command 2 of 2");
    expect(runRow().textContent).toMatch(/· 0s$/);

    for (let second = 0; second < 61; second++) {
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
    }
    expect(runRow().textContent).toContain("1m");
  });

  it("opens onto the command and what it has printed, and keeps up while open", () => {
    const view = renderRunning(runningSetup());
    expect(screen.queryByRole("region", { name: "Setup output" })).toBeNull();

    openDisclosure(disclosureOf(runRow()));
    expect(
      screen.getByText("node scripts/link-shared-node-modules.mjs", { selector: "code" })
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "Setup output" }).textContent).toBe(
      "Shared node_modules is behind package-lock.json.\nRefreshing it with npm ci\n"
    );

    view.rerender(
      card(
        {
          ...baseWorktree,
          lifecycleStatus: runningSetup({
            output: "Refreshing it with npm ci\nadded 1200 packages\n",
          }),
        },
        vi.fn()
      )
    );
    expect(screen.getByRole("region", { name: "Setup output" }).textContent).toBe(
      "Refreshing it with npm ci\nadded 1200 packages\n"
    );
  });

  it("shows a progress bar's latest state, not every state it drew", () => {
    renderRunning(runningSetup({ output: "fetching\n10%\r55%\r90%\r\n" }));

    openDisclosure(disclosureOf(runRow()));

    expect(screen.getByRole("region", { name: "Setup output" }).textContent).toBe(
      "fetching\n90%\n"
    );
  });

  it("says when the command has printed nothing yet", () => {
    renderRunning(runningSetup({ output: undefined }));

    openDisclosure(disclosureOf(runRow()));

    expect(screen.getByText("No output yet")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Setup output" })).toBeNull();
  });

  it("never selects the card for a click on the disclosure or in its log", () => {
    const onCardClick = vi.fn();
    renderRunning(runningSetup(), onCardClick);
    openDisclosure(disclosureOf(runRow()));

    fireEvent.click(runRow().querySelector("summary")!);
    fireEvent.click(screen.getByRole("region", { name: "Setup output" }));

    expect(onCardClick).not.toHaveBeenCalled();
  });

  it("hands focus to the card when the run settles under a reader's focus", () => {
    const view = renderRunning(runningSetup());
    openDisclosure(disclosureOf(runRow()));
    act(() => {
      screen.getByRole("region", { name: "Setup output" }).focus();
    });

    view.rerender(card({ ...baseWorktree, lifecycleStatus: succeededRun }, vi.fn()));

    expect(screen.queryByTestId("worktree-lifecycle-run")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Select worktree" }));
  });

  it("adds no row for a status check, which comes and goes on a timer", () => {
    renderRunning({ phase: "resource-status", state: "running", startedAt: NOW, output: "ok" });

    expect(screen.queryByTestId("worktree-lifecycle-run")).toBeNull();
  });

  it("adds no row for a setup that is over before the gate opens", () => {
    const view = render(card({ ...baseWorktree, lifecycleStatus: runningSetup() }, vi.fn()));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    view.rerender(card({ ...baseWorktree, lifecycleStatus: succeededRun }, vi.fn()));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(screen.queryByTestId("worktree-lifecycle-run")).toBeNull();
  });

  it("keeps a successful setup's output in Details after a status check takes the slot", () => {
    const worktree: WorktreeState = {
      ...baseWorktree,
      lifecycleStatus: { phase: "resource-status", state: "success", startedAt: NOW },
      setupRun: succeededRun,
    };
    const view = render(card(worktree, vi.fn()));
    expect(screen.queryByText("Setup output")).toBeNull();

    view.rerender(card(worktree, vi.fn(), true));
    openDisclosure(disclosureOf(screen.getByText("Setup output")));

    expect(screen.getByRole("region", { name: "Setup output" }).textContent).toBe(
      "Refreshing it with npm ci\nadded 1200 packages\n"
    );
  });

  it("offers no earlier output while setup runs again, nor for a run that did not succeed", () => {
    const view = render(
      card(
        { ...baseWorktree, lifecycleStatus: runningSetup(), setupRun: succeededRun },
        vi.fn(),
        true
      )
    );
    expect(screen.queryByText("Setup output")).toBeNull();

    view.rerender(
      card(
        {
          ...baseWorktree,
          lifecycleStatus: { phase: "resource-status", state: "success", startedAt: NOW },
          setupRun: { ...succeededRun, state: "failed" },
        },
        vi.fn(),
        true
      )
    );
    expect(screen.queryByText("Setup output")).toBeNull();

    // A retry whose slot a status check took mid-run is still a running setup.
    view.rerender(
      card(
        {
          ...baseWorktree,
          lifecycleStatus: { phase: "resource-status", state: "success", startedAt: NOW },
          setupStatus: { state: "running", stage: "setup-script", startedAt: NOW },
          setupRun: succeededRun,
        },
        vi.fn(),
        true
      )
    );
    expect(screen.queryByText("Setup output")).toBeNull();
  });
});
