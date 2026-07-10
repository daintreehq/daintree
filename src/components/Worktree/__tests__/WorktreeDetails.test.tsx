/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { WorktreeState } from "@/types";
import type { WorktreeChanges } from "@shared/types/git";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeDetails, type WorktreeDetailsProps } from "../WorktreeDetails";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

const { capturedModalProps } = vi.hoisted(() => ({
  capturedModalProps: {
    isOpen: false as boolean,
    filePath: "" as string,
    restoreFocusTo: undefined as unknown,
  },
}));

vi.mock("../FileDiffModal", () => ({
  FileDiffModal: (props: { isOpen: boolean; filePath: string; restoreFocusTo?: unknown }) => {
    capturedModalProps.isOpen = props.isOpen;
    capturedModalProps.filePath = props.filePath;
    capturedModalProps.restoreFocusTo = props.restoreFocusTo;
    return null;
  },
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

describe("WorktreeDetails — open changes button (#11041)", () => {
  const worktreeWithChanges: WorktreeState = {
    ...baseWorktree,
    worktreeChanges: {
      ...baseWorktree.worktreeChanges,
      changedFileCount: 2,
      changes: [
        { path: "a.ts", status: "modified", insertions: 5, deletions: 1 },
        { path: "b.ts", status: "added", insertions: 2, deletions: 0 },
      ],
      rootPath: "/tmp/wt",
    } as WorktreeChanges,
  };

  beforeEach(() => {
    capturedModalProps.isOpen = false;
    capturedModalProps.filePath = "";
    capturedModalProps.restoreFocusTo = undefined;
  });

  it("shows the button when there are changes and opens the first file's diff from it", () => {
    renderDetails({ worktree: worktreeWithChanges, hasChanges: true });
    const button = screen.getByLabelText("Open changes");

    fireEvent.click(button);

    expect(capturedModalProps.isOpen).toBe(true);
    // a.ts has the higher churn (6 vs 2), so it sorts to the first slot.
    expect(capturedModalProps.filePath).toBe("a.ts");
    // Focus restores to the header button that opened the modal, not a row.
    const restore = capturedModalProps.restoreFocusTo as { current: HTMLElement | null };
    expect(restore.current).toBe(button);
  });

  it("hides the button when the change list is empty", () => {
    renderDetails({ worktree: baseWorktree, hasChanges: true });
    expect(screen.queryByLabelText("Open changes")).toBeNull();
  });
});
