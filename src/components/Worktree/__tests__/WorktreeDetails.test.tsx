/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { WorktreeState } from "@/types";
import type { WorktreeChanges } from "@shared/types/git";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeDetails, type WorktreeDetailsProps } from "../WorktreeDetails";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

const noop = () => {};
const noopAsync = async () => {};

const baseWorktree: WorktreeState = {
  id: "wt",
  worktreeId: "wt",
  path: "/tmp/wt",
  name: "branch",
  branch: "feature/x",
  isCurrent: false,
  isMainWorktree: false,
  worktreeChanges: {
    worktreeId: "wt",
    changedFileCount: 0,
    insertions: 0,
    deletions: 0,
    changes: [],
    rootPath: "",
    lastCommitTimestampMs: Date.now() - 120_000,
    lastCommitAuthor: { name: "Jane Doe", email: "jane@example.com" },
    lastCommitMessage: "fix: stuff",
  } as WorktreeChanges,
  lastActivityTimestamp: Date.now() - 120_000,
};

const baseProps: WorktreeDetailsProps = {
  worktree: baseWorktree,
  worktreeErrors: [],
  hasChanges: false,
  isFocused: false,
  onPathClick: noop,
  onDismissError: noop,
  onRetryError: noopAsync,
  showTime: true,
};

function renderDetails(overrides: Partial<WorktreeDetailsProps> = {}) {
  return render(
    <TooltipProvider>
      <WorktreeDetails {...baseProps} {...overrides} />
    </TooltipProvider>
  );
}

describe("WorktreeDetails last-active line", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z").getTime());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a Last active line with the committer name and avatar", () => {
    const { container } = renderDetails();
    expect(screen.getByText("Last active")).toBeDefined();
    expect(screen.getByText("Jane Doe")).toBeDefined();
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toContain("gravatar.com");
  });

  it("drops the old colon-suffixed 'Last active:' label", () => {
    renderDetails();
    expect(screen.queryByText("Last active:")).toBeNull();
  });

  it("omits the Last active line when showTime is false", () => {
    renderDetails({ showTime: false });
    expect(screen.queryByText("Last active")).toBeNull();
  });

  it("shows the line without an avatar when there is no committer", () => {
    const worktree: WorktreeState = {
      ...baseWorktree,
      worktreeChanges: {
        ...baseWorktree.worktreeChanges,
        lastCommitAuthor: undefined,
      } as WorktreeChanges,
    };
    const { container } = renderDetails({ worktree });
    expect(screen.getByText("Last active")).toBeDefined();
    expect(container.querySelector("img")).toBeNull();
  });
});
