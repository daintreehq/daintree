/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { WorktreeState } from "@/types";
import type { WorktreeChanges, GitStatus } from "shared/types/git";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const { startDeleteMock, terminalCountsMock } = vi.hoisted(() => ({
  startDeleteMock: vi.fn(),
  terminalCountsMock: { total: 0 },
}));

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({
    getState: () => ({ startDelete: startDeleteMock }),
  }),
}));

vi.mock("@/hooks/useWorktreeTerminals", () => ({
  useWorktreeTerminals: () => ({ counts: terminalCountsMock }),
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

import { WorktreeDeleteDialog } from "../WorktreeDeleteDialog";

function makeWorktree(
  worktreeChanges: WorktreeChanges | null = null,
  overrides: Partial<WorktreeState> = {}
): WorktreeState {
  const base = {
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
  return { ...base, ...overrides };
}

function makeChanges(files: Array<{ path: string; status: GitStatus }>): WorktreeChanges {
  return {
    worktreeId: "wt-1",
    rootPath: "/test/worktree",
    changedFileCount: files.length,
    changes: files.map((f) => ({
      path: f.path,
      status: f.status,
      insertions: null,
      deletions: null,
    })),
  };
}

describe("WorktreeDeleteDialog — warning messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalCountsMock.total = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it("shows no warning when worktree has no changes", () => {
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.queryByText(/Standard deletion will fail/)).toBeNull();
  });

  it("shows untracked-file count when only untracked files exist", () => {
    const worktree = makeWorktree(
      makeChanges([
        { path: "new.txt", status: "untracked" },
        { path: "temp.log", status: "untracked" },
      ])
    );
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const warning = screen.getByText(/Standard deletion will fail/);
    expect(warning.textContent).toContain("2 untracked files");
    expect(warning.textContent).not.toContain("uncommitted file");
  });

  it("shows uncommitted-file count when only tracked changes exist", () => {
    const worktree = makeWorktree(
      makeChanges([
        { path: "src/app.ts", status: "modified" },
        { path: "src/index.ts", status: "deleted" },
      ])
    );
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const warning = screen.getByText(/Standard deletion will fail/);
    expect(warning.textContent).toContain("2 uncommitted files");
    expect(warning.textContent).not.toContain("untracked file");
  });

  it("shows both counts when tracked and untracked files exist", () => {
    const worktree = makeWorktree(
      makeChanges([
        { path: "src/app.ts", status: "modified" },
        { path: "src/index.ts", status: "modified" },
        { path: "new.txt", status: "untracked" },
      ])
    );
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const warning = screen.getByText(/Standard deletion will fail/);
    expect(warning.textContent).toContain("2 uncommitted files and 1 untracked file");
  });

  it("uses singular form for a single tracked change", () => {
    const worktree = makeWorktree(makeChanges([{ path: "src/app.ts", status: "modified" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const warning = screen.getByText(/Standard deletion will fail/);
    expect(warning.textContent).toContain("1 uncommitted file.");
    expect(warning.textContent).not.toContain("1 uncommitted files");
  });

  it("uses singular form for a single untracked file", () => {
    const worktree = makeWorktree(makeChanges([{ path: "new.txt", status: "untracked" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const warning = screen.getByText(/Standard deletion will fail/);
    expect(warning.textContent).toContain("1 untracked file.");
    expect(warning.textContent).not.toContain("1 untracked files");
  });

  it("excludes ignored files from the uncommitted count", () => {
    const worktree = makeWorktree(
      makeChanges([
        { path: "src/app.ts", status: "modified" },
        { path: "node_modules/foo", status: "ignored" },
      ])
    );
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const warning = screen.getByText(/Standard deletion will fail/);
    expect(warning.textContent).toContain("1 uncommitted file.");
  });

  it("persists banner with escalated copy when force is checked for tracked changes", () => {
    const worktree = makeWorktree(makeChanges([{ path: "src/app.ts", status: "modified" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.getByText(/Standard deletion will fail/)).toBeDefined();

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    expect(screen.queryByText(/Standard deletion will fail/)).toBeNull();
    expect(screen.getByText(/Force delete will discard/)).toBeDefined();
    expect(screen.getByText(/1 uncommitted tracked file. This is irreversible./)).toBeDefined();
  });

  it("persists banner with escalated copy when force is checked for untracked-only files", () => {
    const worktree = makeWorktree(makeChanges([{ path: "new.txt", status: "untracked" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.getByText(/Standard deletion will fail/)).toBeDefined();

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    expect(screen.queryByText(/Standard deletion will fail/)).toBeNull();
    expect(screen.getByText(/Force delete will permanently remove/)).toBeDefined();
    expect(screen.getByText(/1 untracked file./)).toBeDefined();
  });

  it("shows combined counts in force banner when both tracked and untracked files exist", () => {
    const worktree = makeWorktree(
      makeChanges([
        { path: "src/app.ts", status: "modified" },
        { path: "new.txt", status: "untracked" },
      ])
    );
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    const banner = screen.getByText(/Force delete will discard/);
    expect(banner.textContent).toContain("and 1 untracked file");
    expect(banner.textContent).toContain("This is irreversible.");
  });

  it('shows "remove untracked files" on force label when only untracked files exist', () => {
    const worktree = makeWorktree(makeChanges([{ path: "new.txt", status: "untracked" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.getByText(/Force delete \(remove untracked files\)/)).toBeDefined();
  });

  it('shows "lose uncommitted changes" on force label when tracked changes exist', () => {
    const worktree = makeWorktree(makeChanges([{ path: "src/app.ts", status: "modified" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.getByText(/Force delete \(lose uncommitted changes\)/)).toBeDefined();
  });

  it("shows combined force label when both tracked and untracked files exist", () => {
    const worktree = makeWorktree(
      makeChanges([
        { path: "src/app.ts", status: "modified" },
        { path: "new.txt", status: "untracked" },
      ])
    );
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(
      screen.getByText(/Force delete \(lose uncommitted changes and untracked files\)/)
    ).toBeDefined();
  });
});

describe("WorktreeDeleteDialog — body copy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalCountsMock.total = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the 'What will happen' heading", () => {
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.getByText("What will happen")).toBeDefined();
  });

  it("renders 'This cannot be undone.' trailing text", () => {
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.getByText("This cannot be undone.")).toBeDefined();
  });

  it("renders the directory row and it is never line-through", () => {
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const row = screen.getByText("Worktree directory will be deleted");
    expect(row).toBeDefined();
    expect(row.className).not.toContain("line-through");
  });

  it("renders the terminals row active when hasTerminals and closeTerminals is checked", () => {
    terminalCountsMock.total = 3;
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const row = screen.getByText(/3 terminals will be closed/);
    expect(row.className).not.toContain("line-through");
  });

  it("uses singular 'terminal' when one terminal is associated", () => {
    terminalCountsMock.total = 1;
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.getByText(/1 terminal will be closed/)).toBeDefined();
    expect(screen.queryByText(/1 terminals/)).toBeNull();
  });

  it("renders the terminals row inactive when closeTerminals is unchecked", () => {
    terminalCountsMock.total = 2;
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const closeTerminalsCheckbox = screen.getByRole("checkbox", {
      name: /close all terminals/i,
    });
    fireEvent.click(closeTerminalsCheckbox);

    const row = screen.getByText(/2 terminals will be closed/);
    expect(row.className).toContain("line-through");
  });

  it("renders the terminals row inactive when no terminals are associated", () => {
    terminalCountsMock.total = 0;
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const row = screen.getByText(/0 terminals will be closed/);
    expect(row.className).toContain("line-through");
  });

  it("renders the uncommitted row active (text-status-error) when force and hasChanges", () => {
    const worktree = makeWorktree(makeChanges([{ path: "src/app.ts", status: "modified" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    const row = screen.getByText("Uncommitted changes will be lost");
    expect(row.className).toContain("text-status-error");
    expect(row.className).not.toContain("line-through");
  });

  it("renders the uncommitted row inactive (line-through) when force is unchecked", () => {
    const worktree = makeWorktree(makeChanges([{ path: "src/app.ts", status: "modified" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const row = screen.getByText("Uncommitted changes will be lost");
    expect(row.className).toContain("line-through");
  });

  it("renders the uncommitted row inactive (line-through) when there are no changes", () => {
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const row = screen.getByText("Uncommitted changes will be lost");
    expect(row.className).toContain("line-through");
  });

  it("renders the branch row active when deleteBranch and canDeleteBranch", () => {
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const deleteBranchCheckbox = screen.getByRole("checkbox", {
      name: /delete branch/i,
    });
    fireEvent.click(deleteBranchCheckbox);

    const row = screen.getByText(
      (_content, element) => element?.textContent === "Branch feature/test will be deleted"
    );
    expect(row.className).not.toContain("line-through");
    expect(row.className).not.toContain("text-status-warning");
  });

  it("renders the branch row with text-status-warning when active and force is on", () => {
    const worktree = makeWorktree(makeChanges([{ path: "src/app.ts", status: "modified" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    const deleteBranchCheckbox = screen.getByRole("checkbox", {
      name: /delete branch/i,
    });
    fireEvent.click(deleteBranchCheckbox);

    const row = screen.getByText(
      (_content, element) => element?.textContent === "Branch feature/test will be deleted"
    );
    expect(row.className).toContain("text-status-warning");
    expect(row.className).not.toContain("line-through");
  });

  it("renders the branch row inactive (line-through) when deleteBranch is unchecked", () => {
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const row = screen.getByText(
      (_content, element) => element?.textContent === "Branch feature/test will be deleted"
    );
    expect(row.className).toContain("line-through");
  });

  it("renders the branch row always (even for protected branches, dimmed)", () => {
    const worktree = makeWorktree(makeChanges([]), { branch: "main", name: "main" });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const row = screen.getByText(
      (_content, element) => element?.textContent === "Branch main will be deleted"
    );
    expect(row.className).toContain("line-through");
  });

  it("renders the branch row with placeholder text for detached HEAD", () => {
    const worktree = makeWorktree(makeChanges([]), {
      branch: undefined,
      name: "abc1234",
    });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const row = screen.getByText("Branch will be deleted");
    expect(row.className).toContain("line-through");
  });

  it("does not reference 'restored from git' in the body copy", () => {
    const worktree = makeWorktree(makeChanges([{ path: "src/app.ts", status: "modified" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    const row = screen.getByText("Uncommitted changes will be lost");
    expect(row.className).toContain("text-status-error");
    expect(screen.queryByText(/restored from git/)).toBeNull();
  });
});

describe("WorktreeDeleteDialog — medium tier (no name confirmation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalCountsMock.total = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it("non-protected branch + force with only untracked files does not require name confirmation", () => {
    const worktree = makeWorktree(makeChanges([{ path: "new.txt", status: "untracked" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    expect(screen.queryByTestId("delete-worktree-confirm-input")).toBeNull();
    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Force delete worktree");
  });

  it("starts a delete on click and dismisses immediately", () => {
    const onClose = vi.fn();
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={onClose} worktree={worktree} />);

    const button = screen.getByTestId("delete-worktree-confirm");
    fireEvent.click(button);

    expect(startDeleteMock).toHaveBeenCalledTimes(1);
    expect(startDeleteMock).toHaveBeenCalledWith("wt-1", { force: false, deleteBranch: false });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("forwards closeTerminals when terminals are associated", () => {
    terminalCountsMock.total = 2;
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    fireEvent.click(screen.getByTestId("delete-worktree-confirm"));

    expect(startDeleteMock).toHaveBeenCalledWith("wt-1", {
      force: false,
      deleteBranch: false,
      closeTerminals: true,
    });
  });
});

describe("WorktreeDeleteDialog — high tier (name confirmation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalCountsMock.total = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it("renders type-to-confirm input when force-deleting a protected branch", () => {
    const worktree = makeWorktree(makeChanges([]), { branch: "main", name: "main" });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.queryByTestId("delete-worktree-confirm-input")).toBeNull();

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    expect(screen.getByTestId("delete-worktree-confirm-input")).toBeDefined();
    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    expect(button.textContent).toBe("Force delete 'main'");
    expect(button.disabled).toBe(true);
  });

  it("renders type-to-confirm input when force-deleting with uncommitted tracked changes", () => {
    const worktree = makeWorktree(makeChanges([{ path: "src/app.ts", status: "modified" }]), {
      branch: "feature/x",
      name: "feature/x",
    });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.queryByTestId("delete-worktree-confirm-input")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));

    expect(screen.getByTestId("delete-worktree-confirm-input")).toBeDefined();
    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    const input = screen.getByTestId("delete-worktree-confirm-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "feature/x" } });
    expect(button.disabled).toBe(false);
  });

  it("renders type-to-confirm input when force-deleting the main worktree", () => {
    const worktree = makeWorktree(makeChanges([]), {
      branch: "feature/x",
      name: "feature/x",
      isMainWorktree: true,
    });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    expect(screen.getByTestId("delete-worktree-confirm-input")).toBeDefined();
    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("enables the destructive button only when the typed name matches exactly", () => {
    const worktree = makeWorktree(makeChanges([]), { branch: "main", name: "main" });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));

    const input = screen.getByTestId("delete-worktree-confirm-input") as HTMLInputElement;
    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "mai" } });
    expect(button.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "Main" } });
    expect(button.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "main" } });
    expect(button.disabled).toBe(false);
  });

  it("falls back to worktree.name when branch is the empty string", () => {
    const worktree = makeWorktree(makeChanges([]), {
      branch: "",
      name: "abc1234",
      isMainWorktree: true,
    });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));

    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    expect(button.textContent).toBe("Force delete 'abc1234'");
    expect(button.disabled).toBe(true);

    const input = screen.getByTestId("delete-worktree-confirm-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc1234" } });
    expect(button.disabled).toBe(false);
  });

  it("uses worktree.name as the confirmation target for detached HEAD", () => {
    const worktree = makeWorktree(makeChanges([]), {
      branch: undefined,
      name: "abc1234",
      isMainWorktree: true,
    });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));

    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    expect(button.textContent).toBe("Force delete 'abc1234'");

    const input = screen.getByTestId("delete-worktree-confirm-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc1234" } });
    expect(button.disabled).toBe(false);
  });

  it("clears typed name and reverts to medium tier when force is unchecked", () => {
    const worktree = makeWorktree(makeChanges([]), { branch: "main", name: "main" });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    const input = screen.getByTestId("delete-worktree-confirm-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "main" } });
    expect(input.value).toBe("main");

    fireEvent.click(forceCheckbox);

    expect(screen.queryByTestId("delete-worktree-confirm-input")).toBeNull();
    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    expect(button.textContent).toBe("Delete worktree");
    expect(button.disabled).toBe(false);
  });

  it("submits on Enter when name is matched", async () => {
    const onClose = vi.fn();
    const worktree = makeWorktree(makeChanges([]), { branch: "main", name: "main" });
    render(<WorktreeDeleteDialog isOpen={true} onClose={onClose} worktree={worktree} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));
    const input = screen.getByTestId("delete-worktree-confirm-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "main" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(startDeleteMock).toHaveBeenCalledTimes(1);
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("does not submit on Enter when name is unmatched", () => {
    const worktree = makeWorktree(makeChanges([]), { branch: "main", name: "main" });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));
    const input = screen.getByTestId("delete-worktree-confirm-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "mai" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(startDeleteMock).not.toHaveBeenCalled();
  });
});

describe("WorktreeDeleteDialog — immediate dismiss", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalCountsMock.total = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it("does not render any in-modal skeleton after submit (progress surfaces on the card — #8417)", () => {
    const onClose = vi.fn();
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={onClose} worktree={worktree} />);

    fireEvent.click(screen.getByTestId("delete-worktree-confirm"));

    expect(screen.queryByTestId("delete-worktree-skeleton")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("never blocks dismissal — Cancel always closes (no isDeleting guard)", () => {
    const onClose = vi.fn();
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={onClose} worktree={worktree} />);

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("WorktreeDeleteDialog — state reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalCountsMock.total = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it("resets closeTerminals to true when the dialog re-opens", () => {
    const worktree = makeWorktree(makeChanges([]));
    const { rerender } = render(
      <WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />
    );

    const closeTerminalsCheckbox = screen.getByRole("checkbox", {
      name: /close all terminals/i,
    }) as HTMLInputElement;
    expect(closeTerminalsCheckbox.checked).toBe(true);
    fireEvent.click(closeTerminalsCheckbox);
    expect(closeTerminalsCheckbox.checked).toBe(false);

    rerender(<WorktreeDeleteDialog isOpen={false} onClose={vi.fn()} worktree={worktree} />);
    rerender(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const reopened = screen.getByRole("checkbox", {
      name: /close all terminals/i,
    }) as HTMLInputElement;
    expect(reopened.checked).toBe(true);
  });
});
