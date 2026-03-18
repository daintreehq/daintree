/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, waitFor } from "@testing-library/react";
import { IssueBulkActionBar } from "../IssueBulkActionBar";
import type { GitHubIssue } from "@shared/types/github";
import type { ActionDispatchResult } from "@shared/types/actions";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true }) },
}));

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(),
}));

vi.mock("@/store/worktreeDataStore", () => ({
  useWorktreeDataStore: Object.assign(
    vi.fn((selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
      selector({ worktrees: new Map() })
    ),
    { getState: () => ({ worktrees: new Map() }) }
  ),
}));

vi.mock("@/components/Worktree/branchPrefixUtils", () => ({
  detectPrefixFromIssue: () => "feature",
  buildBranchName: (_prefix: string, slug: string) => `feature/${slug}`,
}));

vi.mock("@/utils/textParsing", () => ({
  generateBranchSlug: (title: string) => title.toLowerCase().replace(/\s+/g, "-"),
}));

let capturedRecipePickerProps: { isOpen: boolean; onSelect: (id: string | null) => void } | null =
  null;
vi.mock("../RecipePicker", () => ({
  RecipePicker: (props: { isOpen: boolean; onSelect: (id: string | null) => void }) => {
    capturedRecipePickerProps = props;
    return null;
  },
}));

const makeIssue = (n: number): GitHubIssue => ({
  number: n,
  title: `Issue ${n}`,
  url: `https://github.com/test/repo/issues/${n}`,
  state: "OPEN",
  updatedAt: "2026-01-01",
  author: { login: "user", avatarUrl: "" },
  assignees: [],
  commentCount: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  capturedRecipePickerProps = null;
});

afterEach(() => {
  cleanup();
});

describe("IssueBulkActionBar", () => {
  it("returns null when no issues selected and idle", () => {
    const { container } = render(<IssueBulkActionBar selectedIssues={[]} onClear={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders toolbar with count badge and Create Worktrees button when issues selected", () => {
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3)];
    render(<IssueBulkActionBar selectedIssues={issues} onClear={vi.fn()} />);

    const toolbar = screen.getByRole("toolbar", { name: "Bulk actions" });
    expect(toolbar).toBeTruthy();

    expect(screen.getByText("3")).toBeTruthy();
    const createBtn = screen.getByRole("button", { name: /Create Worktrees/i });
    expect(createBtn).toBeTruthy();
  });

  it("renders as inline footer row, not a floating pill", () => {
    const issues = [makeIssue(1)];
    render(<IssueBulkActionBar selectedIssues={issues} onClear={vi.fn()} />);

    const toolbar = screen.getByRole("toolbar");
    const classes = toolbar.className;

    expect(classes).not.toContain("absolute");
    expect(classes).not.toContain("rounded-full");
    expect(classes).not.toContain("backdrop-blur");
    expect(classes).not.toContain("bg-black");
    expect(classes).not.toContain("animate-pill-enter");

    expect(classes).toContain("border-t");
    expect(classes).toContain("shrink-0");
  });

  it("calls onClear when dismiss button is clicked", () => {
    const onClear = vi.fn();
    render(<IssueBulkActionBar selectedIssues={[makeIssue(1)]} onClear={onClear} />);

    fireEvent.click(screen.getByLabelText("Clear selection"));
    expect(onClear).toHaveBeenCalled();
  });

  it("renders clear selection button with correct aria-label", () => {
    render(<IssueBulkActionBar selectedIssues={[makeIssue(1)]} onClear={vi.fn()} />);
    expect(screen.getByLabelText("Clear selection")).toBeTruthy();
  });

  it("clicking Create Worktrees opens the recipe picker", () => {
    render(<IssueBulkActionBar selectedIssues={[makeIssue(1)]} onClear={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Create Worktrees/i }));
    expect(capturedRecipePickerProps?.isOpen).toBe(true);
  });

  it("shows executing state with spinner and progress text", async () => {
    const { actionService } = await import("@/services/ActionService");
    let resolveDispatch!: (v: ActionDispatchResult) => void;
    vi.mocked(actionService.dispatch).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDispatch = resolve;
        })
    );

    render(<IssueBulkActionBar selectedIssues={[makeIssue(1)]} onClear={vi.fn()} />);

    await act(async () => {
      capturedRecipePickerProps?.onSelect(null);
    });

    expect(screen.getByText(/Creating 0\/1/)).toBeTruthy();

    await act(async () => {
      resolveDispatch!({ ok: true, result: undefined });
    });
  });

  it("shows done state with created count after execution completes", async () => {
    const { actionService } = await import("@/services/ActionService");
    vi.mocked(actionService.dispatch).mockResolvedValue({ ok: true } as never);

    render(<IssueBulkActionBar selectedIssues={[makeIssue(1)]} onClear={vi.fn()} />);

    await act(async () => {
      capturedRecipePickerProps?.onSelect(null);
    });

    await waitFor(() => {
      expect(screen.getByText("1 created")).toBeTruthy();
    });
    expect(screen.getByLabelText("Dismiss")).toBeTruthy();
  });
});
