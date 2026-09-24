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

  const segments = (container: HTMLElement, kind: string) =>
    Array.from(container.querySelectorAll(`[data-segment="${kind}"]`)).map((el) => el.textContent);

  it("returns null when initialPrompt is empty", () => {
    mockSnapshot = { path: "/tmp/test" };
    const { container } = renderPreview("");
    expect(container.textContent).toBe("");
  });

  it("renders nothing when the prompt has no variable syntax, since it would repeat the field", () => {
    mockSnapshot = FULL_SNAPSHOT;
    const { container } = renderPreview("Review the latest changes", "wt-1");
    expect(container.textContent).toBe("");
  });

  it("renders resolved text with substitutions from worktree context", () => {
    mockSnapshot = FULL_SNAPSHOT;

    const { container } = renderPreview(
      "Fix {{issue_number}} on {{branch_name}} at {{worktree_path}} (PR {{pr_number}})",
      "wt-1"
    );

    expect(container.textContent).toContain(
      "Fix #42 on feature/my-branch at /home/project (PR #99)"
    );
    expect(segments(container, "value")).toEqual([
      "#42",
      "feature/my-branch",
      "/home/project",
      "#99",
    ]);
    expect(screen.getByText("Values from feature/my-branch")).toBeTruthy();
  });

  it("marks a missing value in place instead of letting it vanish", () => {
    mockSnapshot = { path: "/tmp/test", branch: "main" };

    const { container } = renderPreview("Fix {{issue_number}} on {{branch_name}}", "wt-1");

    const preview = container.querySelector('[data-segment="missing"]')!;
    expect(preview.textContent).toBe("{{issue_number}} (empty)");
    // The marker sits between the literal text around it, where the gap will be.
    const line = preview.parentElement!.textContent;
    expect(line).toBe("Fix {{issue_number}} (empty) on main");
    expect(screen.getByText(/has no value in this worktree and launches empty/)).toBeTruthy();
  });

  it("names every missing variable once in the note", () => {
    mockSnapshot = { path: "/tmp/test" };

    renderPreview("{{issue_number}} {{pr_number}} {{issue_number}}", "wt-1");

    expect(
      screen.getByText(
        "{{issue_number}} and {{pr_number}} have no value in this worktree and launch empty"
      )
    ).toBeTruthy();
  });

  it("shows run-time tokens without claiming they are missing when there is no worktree", () => {
    const { container } = renderPreview("Fix {{issue_number}} on {{branch_name}}", undefined);

    expect(segments(container, "variable")).toEqual(["{{issue_number}}", "{{branch_name}}"]);
    expect(segments(container, "missing")).toEqual([]);
    expect(screen.getByText("Values fill in from the worktree at launch")).toBeTruthy();
    expect(screen.queryByText(/no value/)).toBeNull();
  });

  it("falls back to run-time mode when the worktree snapshot is not in the store", () => {
    const { container } = renderPreview("Deploy {{branch_name}}", "wt-missing");

    expect(segments(container, "variable")).toEqual(["{{branch_name}}"]);
    expect(screen.getByText("Values fill in from the worktree at launch")).toBeTruthy();
  });

  it("does not flag {{number}} as missing during authoring without worktree", () => {
    const { container } = renderPreview("See {{number}}", undefined);

    expect(segments(container, "variable")).toEqual(["{{number}}"]);
    expect(segments(container, "missing")).toEqual([]);
  });

  it("flags an unknown {{var}} as sent as typed, never as missing", () => {
    mockSnapshot = { path: "/tmp/test", branch: "main" };

    const { container } = renderPreview("Use {{foo}} on {{Branch_Name}}", "wt-1");

    expect(segments(container, "unknown")).toEqual(["{{foo}}"]);
    expect(segments(container, "value")).toEqual(["main"]);
    expect(segments(container, "missing")).toEqual([]);
    expect(screen.getByText("{{foo}} isn't a recipe variable and is sent as typed")).toBeTruthy();
  });

  it("previews an unknown-only prompt so a typo is not hidden", () => {
    const { container } = renderPreview("Use {{isue_number}}", undefined);

    expect(segments(container, "unknown")).toEqual(["{{isue_number}}"]);
  });

  it("previews a spaced or hyphenated variable so the typo is visible", () => {
    const { container } = renderPreview("Use {{ issue_number }} or {{issue-number}}", undefined);

    expect(segments(container, "unknown")).toEqual(["{{ issue_number }}", "{{issue-number}}"]);
  });

  it("resolves {{number}} to issueNumber when set", () => {
    mockSnapshot = { path: "/tmp/test", issueNumber: 7 };

    const { container } = renderPreview("See {{number}}", "wt-1");

    expect(segments(container, "value")).toEqual(["#7"]);
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

    expect(segments(container, "value")).toEqual(["#55"]);
  });

  it("marks {{number}} missing when neither issue nor PR is set", () => {
    mockSnapshot = { path: "/tmp/test" };

    const { container } = renderPreview("See {{number}}", "wt-1");

    expect(segments(container, "missing")).toEqual(["{{number}} (empty)"]);
  });

  it("previews the prompt trimmed, the way launch sends it", () => {
    mockSnapshot = { path: "/tmp/test", branch: "main" };

    const { container } = renderPreview("  \n on {{branch_name}}  \n", "wt-1");

    expect(container.querySelector('[data-segment="value"]')!.parentElement!.textContent).toBe(
      "on main"
    );
  });
});
