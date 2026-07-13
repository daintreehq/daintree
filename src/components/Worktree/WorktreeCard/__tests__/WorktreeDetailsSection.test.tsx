/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { WorktreeState } from "@/types";
import type { WorktreeChanges } from "@shared/types/git";
import type { ComputedSubtitle } from "../hooks/useWorktreeStatus";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  WorktreeDetailsSection,
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
    useAnimate: () => [{ current: null } as unknown as React.RefObject<HTMLElement>, mockAnimate],
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
  beforeEach(() => {
    mockAnimate.mockClear();
    mockReducedMotion = false;
    delete document.body.dataset.performanceMode;
  });

  afterEach(() => {
    vi.useRealTimers();
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
    expect(screen.getByText(/5 files/)).toBeDefined();
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

  it("does not bump when changedFileCount stays the same", () => {
    const { rerender } = renderSection();
    expect(mockAnimate).not.toHaveBeenCalled();

    rerender(
      <TooltipProvider>
        <WorktreeDetailsSection {...baseProps} />
      </TooltipProvider>
    );

    expect(mockAnimate).not.toHaveBeenCalled();
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
    const button = screen.getByLabelText("Open Review & Commit");
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
    expect(screen.queryByLabelText("Open Review & Commit")).toBeNull();
    expect(screen.queryByText("Conflicts need review")).toBeNull();
    expect(screen.getByText("fix: stuff")).toBeDefined();
    const button = screen.getByLabelText("Open Review & Push");
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
    expect(screen.queryByLabelText("Open Review & Commit")).toBeNull();
    expect(screen.queryByLabelText("Open Review & Push")).toBeNull();
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

  it("uses activity-focused accessible naming regardless of commit author", () => {
    renderSection({ worktree: withCommit({ lastCommitAuthor: undefined }), hasChanges: false });
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
    const { container } = renderSection({ worktree, hasChanges: false });
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders activity for a worktree with no commit", () => {
    const worktree: WorktreeState = { ...baseWorktree, lastActivityTimestamp: Date.now() };
    renderSection({ worktree, hasChanges: false });
    expect(screen.getByRole("group", { name: "Last activity" }).textContent).toBe("now");
  });

  it("omits the chip when neither activity nor commit timestamp is valid", () => {
    const { container } = renderSection({
      worktree: withCommit({ lastCommitTimestampMs: Number.NaN }),
      hasChanges: false,
    });
    expect(screen.queryByRole("group", { name: "Last activity" })).toBeNull();
    expect(container.textContent).not.toContain("NaN");
  });

  it("falls back to a valid commit when the activity timestamp is invalid", () => {
    renderSection({ worktree: withCommit({}, Number.NaN), hasChanges: false });
    expect(screen.getByRole("group", { name: "Last activity" }).textContent).toBe("2m");
  });

  it("rejects a future activity timestamp and falls back to the commit", () => {
    renderSection({ worktree: withCommit({}, Date.now() + 60_000), hasChanges: false });
    expect(screen.getByRole("group", { name: "Last activity" }).textContent).toBe("2m");
  });

  it("removes the standalone 'No activity' placeholder", () => {
    renderSection({ worktree: withCommit({}), hasChanges: false });
    expect(screen.queryByText("No activity")).toBeNull();
  });
});
