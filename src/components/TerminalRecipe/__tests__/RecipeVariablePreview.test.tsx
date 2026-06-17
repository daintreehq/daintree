// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RecipeVariablePreview } from "../RecipeVariablePreview";

let mockSnapshot: Record<string, unknown> | undefined;

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (sel: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    sel({
      worktrees: mockSnapshot
        ? (new Map([["wt-1", mockSnapshot]]) as unknown as Map<string, unknown>)
        : (new Map() as unknown as Map<string, unknown>),
    }),
}));

function renderPreview(initialPrompt: string, worktreeId?: string) {
  return render(<RecipeVariablePreview initialPrompt={initialPrompt} worktreeId={worktreeId} />);
}

const FULL_SNAPSHOT = {
  path: "/home/project",
  issueNumber: 42,
  branch: "feature/my-branch",
  linked: {
    providerId: "github",
    pr: {
      ref: { number: 99, owner: "o", repo: "r", providerId: "github", rawData: {} },
      url: "https://example.com",
      state: "open" as const,
    },
  },
} as const;

describe("RecipeVariablePreview", () => {
  beforeEach(() => {
    mockSnapshot = undefined;
  });

  it("returns null when initialPrompt is empty", () => {
    mockSnapshot = { path: "/tmp/test" };
    const { container } = renderPreview("");
    expect(container.textContent).toBe("");
  });

  it("renders resolved text with substitutions from worktree context", () => {
    mockSnapshot = FULL_SNAPSHOT;

    const { container } = renderPreview(
      "Fix {{issue_number}} on {{branch_name}} at {{worktree_path}} (PR {{pr_number}})",
      "wt-1"
    );

    expect(container.textContent).toContain("Resolved prompt");
    expect(container.textContent).toContain(
      "Fix #42 on feature/my-branch at /home/project (PR #99)"
    );
  });

  it("shows unresolved badge with icon when issueNumber is missing", () => {
    mockSnapshot = { path: "/tmp/test", branch: "main" };

    renderPreview("Fix {{issue_number}}", "wt-1");

    expect(screen.getByText(/unresolved/)).toBeTruthy();
    expect(screen.getByText(/{{issue_number}}/)).toBeTruthy();
  });

  it("shows fallback amber token spans when worktreeId is undefined", () => {
    const { container } = renderPreview("Fix {{issue_number}} on {{branch_name}}", undefined);

    expect(container.querySelector(".bg-category-amber-subtle")).toBeTruthy();
    expect(screen.getByText("Resolving at run time")).toBeTruthy();
  });

  it("shows fallback amber tokens when worktree snapshot is not in store", () => {
    const { container } = renderPreview("Deploy {{branch_name}}", "wt-missing");

    expect(container.querySelector(".bg-category-amber-subtle")).toBeTruthy();
    expect(screen.getByText("Resolving at run time")).toBeTruthy();
  });

  it("does not show unresolved badges in fallback mode without worktree context", () => {
    renderPreview("Fix {{issue_number}} on {{branch_name}}", undefined);

    expect(screen.queryByText(/unresolved/)).toBeNull();
  });

  it("treats unknown {{var}} as literal text, not as unresolved", () => {
    mockSnapshot = { path: "/tmp/test", branch: "main" };

    const { container } = renderPreview("Use {{foo}} here", "wt-1");

    expect(container.textContent).toContain("{{foo}}");
    expect(screen.queryByText(/unresolved/)).toBeNull();
  });

  it("resolves {{number}} to issueNumber when set", () => {
    mockSnapshot = { path: "/tmp/test", issueNumber: 7 };

    const { container } = renderPreview("See {{number}}", "wt-1");

    expect(container.textContent).toContain("#7");
  });

  it("resolves {{number}} to prNumber when issueNumber is absent", () => {
    mockSnapshot = {
      path: "/tmp/test",
      linked: {
        providerId: "github",
        pr: {
          ref: { number: 55, owner: "o", repo: "r", providerId: "github", rawData: {} },
          url: "https://example.com",
          state: "open",
        },
      },
    };

    const { container } = renderPreview("See {{number}}", "wt-1");

    expect(container.textContent).toContain("#55");
  });

  it("shows rose badge for {{number}} when neither issue nor PR is set", () => {
    mockSnapshot = { path: "/tmp/test" };

    renderPreview("See {{number}}", "wt-1");

    expect(screen.getByText(/unresolved/)).toBeTruthy();
  });
});
