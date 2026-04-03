/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { WorktreeState } from "@/types";
import type { WorktreeChanges } from "shared/types/git";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

vi.mock("@/hooks/useWorktreeTerminals", () => ({
  useWorktreeTerminals: () => ({ counts: { total: 0 } }),
}));

vi.mock("@/store", () => ({
  useTerminalStore: () => vi.fn(),
}));

vi.mock("@/components/ui/AppDialog", () => {
  const Dialog = ({
    children,
    isOpen,
  }: {
    children: React.ReactNode;
    isOpen: boolean;
    onClose?: () => void;
    size?: string;
    variant?: string;
    dismissible?: boolean;
    "data-testid"?: string;
  }) => (isOpen ? <div data-testid="delete-worktree-dialog">{children}</div> : null);
  Dialog.Body = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Dialog.Title = ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>;
  Dialog.Footer = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return { AppDialog: Dialog };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => {
    const { variant: _v, ...htmlProps } = props as Record<string, unknown>;
    return (
      <button {...(htmlProps as React.ButtonHTMLAttributes<HTMLButtonElement>)}>{children}</button>
    );
  },
}));

vi.mock("@/components/icons", () => ({
  WorktreeIcon: ({ className }: { className?: string }) => (
    <span data-testid="worktree-icon" className={className} />
  ),
}));

import { WorktreeDeleteDialog } from "../WorktreeDeleteDialog";

function makeWorktree(worktreeChanges: WorktreeChanges | null = null): WorktreeState {
  return {
    id: "wt-1",
    path: "/test/worktree",
    name: "feature/test",
    branch: "feature/test",
    isCurrent: false,
    isMainWorktree: false,
    gitDir: "/test/.git/worktrees/wt-1",
    worktreeChanges,
    agentStates: {},
    prNumber: null,
    prState: null,
    prUrl: null,
    issueNumber: null,
    mood: "stable",
    moodLabel: null,
  } as unknown as WorktreeState;
}

function makeChanges(
  files: Array<{ path: string; status: string }>
): WorktreeChanges {
  return {
    worktreeId: "wt-1",
    rootPath: "/test/worktree",
    changedFileCount: files.length,
    changes: files.map((f) => ({
      path: f.path,
      status: f.status as any,
      insertions: null,
      deletions: null,
    })),
  };
}

describe("WorktreeDeleteDialog — warning messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows no warning when worktree has no changes", () => {
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.queryByText(/Standard deletion will fail/)).toBeNull();
  });

  it('shows "untracked files" warning when only untracked files exist', () => {
    const worktree = makeWorktree(
      makeChanges([
        { path: "new.txt", status: "untracked" },
        { path: "temp.log", status: "untracked" },
      ])
    );
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const warning = screen.getByText(/Standard deletion will fail/);
    expect(warning.textContent).toContain("untracked files");
    expect(warning.textContent).not.toContain("uncommitted changes");
  });

  it('shows "uncommitted changes" warning when only tracked changes exist', () => {
    const worktree = makeWorktree(
      makeChanges([
        { path: "src/app.ts", status: "modified" },
        { path: "src/index.ts", status: "deleted" },
      ])
    );
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const warning = screen.getByText(/Standard deletion will fail/);
    expect(warning.textContent).toContain("uncommitted changes");
    expect(warning.textContent).not.toContain("untracked files");
  });

  it('shows "uncommitted changes and untracked files" when both exist', () => {
    const worktree = makeWorktree(
      makeChanges([
        { path: "src/app.ts", status: "modified" },
        { path: "new.txt", status: "untracked" },
      ])
    );
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const warning = screen.getByText(/Standard deletion will fail/);
    expect(warning.textContent).toContain("uncommitted changes and untracked files");
  });

  it("hides warning when force is checked", () => {
    const worktree = makeWorktree(
      makeChanges([{ path: "src/app.ts", status: "modified" }])
    );
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.getByText(/Standard deletion will fail/)).toBeDefined();

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    expect(screen.queryByText(/Standard deletion will fail/)).toBeNull();
  });

  it('shows "remove untracked files" on force label when only untracked files exist', () => {
    const worktree = makeWorktree(
      makeChanges([{ path: "new.txt", status: "untracked" }])
    );
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.getByText(/Force delete \(remove untracked files\)/)).toBeDefined();
  });

  it('shows "lose uncommitted changes" on force label when tracked changes exist', () => {
    const worktree = makeWorktree(
      makeChanges([{ path: "src/app.ts", status: "modified" }])
    );
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.getByText(/Force delete \(lose uncommitted changes\)/)).toBeDefined();
  });
});
