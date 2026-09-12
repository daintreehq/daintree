// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { WorktreeSnapshot } from "@shared/types";
import { WorktreeDragPreview } from "../WorktreeDragPreview";

function worktree(overrides: Partial<WorktreeSnapshot>): WorktreeSnapshot {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture
  return { id: "wt", name: "wt", path: "/wt", isCurrent: false, ...overrides } as WorktreeSnapshot;
}

const FIXTURES = [
  worktree({
    branch: "feature/issue-142-refund-flow",
    issueNumber: 142,
    issueTitle: "Add idempotent partial refunds",
  }),
  worktree({ branch: "bugfix/auth-redirect" }),
  worktree({ name: "surge-checkout", branch: "main", isMainWorktree: true }),
];

/**
 * The branch line is the smallest type on the ghost and used to be the
 * faintest — text-primary mixed to 50%, which the design system bans because
 * the contrast cannot be recovered downstream. Every text node steps down the
 * token hierarchy instead.
 */
describe("WorktreeDragPreview text", () => {
  it("never fades text with alpha or an inline colour", () => {
    for (const wt of FIXTURES) {
      const { container } = render(<WorktreeDragPreview worktree={wt} />);
      for (const el of container.querySelectorAll<HTMLElement>("*")) {
        expect(el.className.toString()).not.toMatch(/(?:^|\s)text-[a-z-]+\/\d+/);
        expect(el.style.color).toBe("");
      }
    }
  });

  it("shows the branch beneath an issue title, and only the branch otherwise", () => {
    const issue = render(<WorktreeDragPreview worktree={FIXTURES[0]!} />);
    expect(issue.container.textContent).toContain("Add idempotent partial refunds");
    expect(issue.container.textContent).toContain("feature/issue-142-refund-flow");

    const branchOnly = render(<WorktreeDragPreview worktree={FIXTURES[1]!} />);
    expect(branchOnly.container.textContent).toBe("bugfix/auth-redirect");

    const main = render(<WorktreeDragPreview worktree={FIXTURES[2]!} />);
    expect(main.container.textContent).toBe("surge-checkout");
  });
});
