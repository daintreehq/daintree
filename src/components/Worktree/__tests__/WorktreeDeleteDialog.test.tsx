/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
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

const { dispatchMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: dispatchMock,
  },
}));

vi.mock("@/hooks/useWorktreeTerminals", () => ({
  useWorktreeTerminals: () => ({ counts: { total: 0 } }),
}));

vi.mock("@/store", () => ({
  usePanelStore: () => vi.fn(),
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
    dispatchMock.mockResolvedValue({ ok: true });
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
    const worktree = makeWorktree(makeChanges([{ path: "src/app.ts", status: "modified" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.getByText(/Standard deletion will fail/)).toBeDefined();

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    expect(screen.queryByText(/Standard deletion will fail/)).toBeNull();
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
    dispatchMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("ends body copy with 'This cannot be undone.' in medium tier", () => {
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const body = screen.getByText(/This will permanently delete the worktree directory/);
    expect(body.textContent).toMatch(/This cannot be undone\.$/);
  });

  it("ends body copy with 'This cannot be undone.' in high tier", () => {
    const worktree = makeWorktree(makeChanges([]), { branch: "main" });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    const body = screen.getByText(/This will permanently delete the worktree directory/);
    expect(body.textContent).toMatch(/This cannot be undone\.$/);
  });
});

describe("WorktreeDeleteDialog — medium tier (no name confirmation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("non-protected branch + force does not require name confirmation", () => {
    const worktree = makeWorktree(makeChanges([{ path: "src/app.ts", status: "modified" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    expect(screen.queryByTestId("delete-worktree-confirm-input")).toBeNull();
    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Delete worktree");
  });

  it("dispatches delete on click without typing", async () => {
    const onClose = vi.fn();
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={onClose} worktree={worktree} />);

    const button = screen.getByTestId("delete-worktree-confirm");
    fireEvent.click(button);

    await waitFor(() => {
      expect(dispatchMock).toHaveBeenCalledTimes(1);
    });
    expect(dispatchMock).toHaveBeenCalledWith(
      "worktree.delete",
      { worktreeId: "wt-1", force: false, deleteBranch: false },
      { source: "user" }
    );
  });
});

describe("WorktreeDeleteDialog — high tier (name confirmation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchMock.mockResolvedValue({ ok: true });
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
    expect(button.textContent).toBe("Delete 'main'");
    expect(button.disabled).toBe(true);
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

  it("uses worktree.name as the confirmation target for detached HEAD", () => {
    const worktree = makeWorktree(makeChanges([]), {
      branch: undefined,
      name: "abc1234",
      isMainWorktree: true,
    });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));

    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    expect(button.textContent).toBe("Delete 'abc1234'");

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
      expect(dispatchMock).toHaveBeenCalledTimes(1);
    });
  });

  it("does not submit on Enter when name is unmatched", () => {
    const worktree = makeWorktree(makeChanges([]), { branch: "main", name: "main" });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));
    const input = screen.getByTestId("delete-worktree-confirm-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "mai" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe("WorktreeDeleteDialog — in-flight skeleton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the skeleton and hides body copy while delete is in flight", async () => {
    let resolveDispatch: (value: { ok: true }) => void = () => {};
    dispatchMock.mockImplementationOnce(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveDispatch = resolve;
        })
    );
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    fireEvent.click(screen.getByTestId("delete-worktree-confirm"));

    await waitFor(() => {
      expect(screen.getByTestId("delete-worktree-skeleton")).toBeDefined();
    });
    expect(screen.queryByText(/This will permanently delete the worktree directory/)).toBeNull();

    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Deleting…");

    await act(async () => {
      resolveDispatch({ ok: true });
    });
  });
});

describe("WorktreeDeleteDialog — state reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchMock.mockResolvedValue({ ok: true });
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

describe("WorktreeDeleteDialog — error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders error message and re-enables controls when dispatch fails", async () => {
    dispatchMock.mockResolvedValueOnce({ ok: false, error: { message: "git error" } });
    const onClose = vi.fn();
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={onClose} worktree={worktree} />);

    fireEvent.click(screen.getByTestId("delete-worktree-confirm"));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("git error");
    });
    expect(screen.queryByTestId("delete-worktree-skeleton")).toBeNull();
    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("WorktreeDeleteDialog — reentrancy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("dispatches at most once when the destructive button is clicked rapidly", async () => {
    let resolveDispatch: (value: { ok: true }) => void = () => {};
    dispatchMock.mockImplementationOnce(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveDispatch = resolve;
        })
    );
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const button = screen.getByTestId("delete-worktree-confirm");
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByTestId("delete-worktree-skeleton")).toBeDefined();
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDispatch({ ok: true });
    });
  });
});
