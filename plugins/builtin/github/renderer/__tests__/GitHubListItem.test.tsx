/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { Activity, type ReactNode } from "react";
import { GitHubListItem } from "../components/GitHubListItem";
import type { Issue, PR } from "@shared/types/forge";
import { actionService } from "@/services/ActionService";
import { UI_ACTION_SUCCESS_DWELL_MS } from "@/lib/animationUtils";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: vi.fn((selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() })
  ),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: vi.fn((selector: (s: { activeWorktreeId: null }) => unknown) =>
    selector({ activeWorktreeId: null })
  ),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

vi.mock("@/utils/timeAgo", () => ({
  formatTimeAgo: (date: number | string) => `time:${date}`,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const baseIssue: Issue = {
  number: 42,
  title: "Fix the thing",
  body: "",
  url: "https://github.com/test/repo/issues/42",
  state: "open",
  rawState: "OPEN",
  updatedAt: 1001,
  createdAt: 1000,
  author: { login: "testuser", avatarUrl: "", rawData: null },
  assignees: [],
  labels: [],
  commentCount: 3,
  rawData: null,
};

const basePR: PR = {
  number: 99,
  title: "Add new feature",
  body: "",
  url: "https://github.com/test/repo/pull/99",
  state: "open",
  rawState: "OPEN",
  isDraft: false,
  merged: false,
  updatedAt: 1002,
  createdAt: 1000,
  author: { login: "prauthor", avatarUrl: "", rawData: null },
  baseRef: "main",
  headRef: "feature/new-thing",
  rawData: null,
};

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GitHubListItem", () => {
  it("renders issue title as a clickable button", () => {
    render(<GitHubListItem item={baseIssue} type="issue" />);
    const title = screen.getByText("Fix the thing");
    expect(title.tagName).toBe("BUTTON");
  });

  it("renders PR title as a clickable button", () => {
    render(<GitHubListItem item={basePR} type="pr" />);
    const title = screen.getByText("Add new feature");
    expect(title.tagName).toBe("BUTTON");
  });

  it("clicking issue title dispatches system.openExternal with item URL", () => {
    render(<GitHubListItem item={baseIssue} type="issue" />);
    fireEvent.click(screen.getByText("Fix the thing"));
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://github.com/test/repo/issues/42" },
      { source: "user" }
    );
  });

  it("clicking linked PR dispatches system.openExternal with PR URL", () => {
    const issueWithPR: Issue = {
      ...baseIssue,
      linkedPR: { number: 55, state: "open", url: "https://github.com/test/repo/pull/55" },
    };
    render(<GitHubListItem item={issueWithPR} type="issue" />);
    fireEvent.click(screen.getByRole("button", { name: "Open linked pull request #55" }));
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://github.com/test/repo/pull/55" },
      { source: "user" }
    );
  });

  it("renders author and time in metadata row", () => {
    render(<GitHubListItem item={baseIssue} type="issue" />);
    expect(screen.getByText("testuser")).toBeTruthy();
    expect(screen.getByText("time:1001")).toBeTruthy();
  });

  it("renders branch name for PRs", () => {
    render(<GitHubListItem item={basePR} type="pr" />);
    expect(screen.getByText("feature/new-thing")).toBeTruthy();
  });

  it("renders labels for issues", () => {
    const issueWithLabels: Issue = {
      ...baseIssue,
      labels: [
        { name: "bug", color: "d73a4a" },
        { name: "enhancement", color: "a2eeef" },
      ],
    };
    const { container } = render(<GitHubListItem item={issueWithLabels} type="issue" />);
    // One label rendered whole plus a count — clipping the second to
    // "enhanceme…" read as broken data, and anything past it used to vanish
    // with nothing to say so.
    expect(screen.getByText("bug")).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();
    // Every label is still reachable, in the tooltip (flattened by the mock).
    expect(container.textContent).toContain("bug, enhancement");
  });

  it("clicking #number copies to clipboard", async () => {
    render(<GitHubListItem item={baseIssue} type="issue" />);
    const copyButton = screen.getByLabelText("Copy number 42");

    await act(async () => {
      fireEvent.click(copyButton);
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("#42");
  });

  it("shows check icon after copy then reverts after timeout", async () => {
    render(<GitHubListItem item={baseIssue} type="issue" />);
    const copyButton = screen.getByLabelText("Copy number 42");

    await act(async () => {
      fireEvent.click(copyButton);
    });

    // Check icon should be visible (status-success class)
    const checkIcon = copyButton.querySelector(".text-status-success");
    expect(checkIcon).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(UI_ACTION_SUCCESS_DWELL_MS);
    });

    // Check icon should be gone
    const checkIconAfter = copyButton.querySelector(".text-status-success");
    expect(checkIconAfter).toBeNull();
  });

  it("resets copy state on Activity hide/reveal so checkmark does not persist across reopen", async () => {
    function Harness({ mode }: { mode: "visible" | "hidden" }) {
      return (
        <Activity mode={mode}>
          <GitHubListItem item={baseIssue} type="issue" />
        </Activity>
      );
    }

    const { rerender } = render(<Harness mode="visible" />);
    const copyButton = screen.getByLabelText("Copy number 42");

    await act(async () => {
      fireEvent.click(copyButton);
    });

    const checkIcon = copyButton.querySelector(".text-status-success");
    expect(checkIcon).not.toBeNull();

    rerender(<Harness mode="hidden" />);
    rerender(<Harness mode="visible" />);

    const copyButtonAfter = screen.getByLabelText("Copy number 42");
    const checkIconAfter = copyButtonAfter.querySelector(".text-status-success");
    expect(checkIconAfter).toBeNull();
  });

  it("names the row actions trigger per item so two rows never share a label", () => {
    render(<GitHubListItem item={baseIssue} type="issue" />);
    expect(screen.getByLabelText("Actions for #42")).toBeTruthy();
  });

  it("keeps the row actions trigger in the DOM and rendered whether or not the row is active", () => {
    // It used to be `opacity-0` until hover, which made it findable only by
    // people who already knew it was there.
    const { unmount } = render(<GitHubListItem item={baseIssue} type="issue" isActive={false} />);
    const resting = screen.getByLabelText("Actions for #42");
    expect(resting.className).not.toContain("opacity-0");
    unmount();

    render(<GitHubListItem item={baseIssue} type="issue" isActive />);
    expect(screen.getByLabelText("Actions for #42")).toBeTruthy();
  });

  it("renders CI status check icon for successful PRs", () => {
    const prWithCI: PR = { ...basePR, ciStatus: "success" };
    render(<GitHubListItem item={prWithCI} type="pr" />);
    const indicator = screen.getByLabelText("All checks passed");
    expect(indicator.querySelector("svg")).not.toBeNull();
    expect(indicator.querySelector(".text-status-success")).not.toBeNull();
    expect(indicator.querySelector(".rounded-full")).toBeNull();
  });

  it("renders CI status X icon for failing PRs", () => {
    const prWithCI: PR = { ...basePR, ciStatus: "failure" };
    render(<GitHubListItem item={prWithCI} type="pr" />);
    const indicator = screen.getByLabelText("Checks failing");
    expect(indicator.querySelector("svg")).not.toBeNull();
    expect(indicator.querySelector(".text-status-error")).not.toBeNull();
    expect(indicator.querySelector(".rounded-full")).toBeNull();
  });

  it("renders no CI indicator for a neutral roll-up", () => {
    const prWithCI: PR = { ...basePR, ciStatus: "neutral" };
    render(<GitHubListItem item={prWithCI} type="pr" />);
    expect(screen.queryByLabelText("All checks passed")).toBeNull();
    expect(screen.queryByLabelText("Checks failing")).toBeNull();
    expect(screen.queryByLabelText("Checks pending")).toBeNull();
  });

  it("renders CI status dot for pending PRs", () => {
    const prWithCI: PR = { ...basePR, ciStatus: "pending" };
    render(<GitHubListItem item={prWithCI} type="pr" />);
    const indicator = screen.getByLabelText("Checks pending");
    expect(indicator.querySelector("svg")).toBeNull();
    expect(indicator.querySelector(".bg-status-warning")).not.toBeNull();
  });

  it("renders no CI indicator for an unknown roll-up", () => {
    const prWithCI: PR = { ...basePR, ciStatus: "unknown" };
    render(<GitHubListItem item={prWithCI} type="pr" />);
    expect(screen.queryByLabelText("All checks passed")).toBeNull();
    expect(screen.queryByLabelText("Checks failing")).toBeNull();
    expect(screen.queryByLabelText("Checks pending")).toBeNull();
  });

  it("renders linked PR icon button for issues", () => {
    const issueWithPR: Issue = {
      ...baseIssue,
      linkedPR: { number: 55, state: "open", url: "https://github.com/test/repo/pull/55" },
    };
    render(<GitHubListItem item={issueWithPR} type="issue" />);
    const prButton = screen.getByRole("button", { name: "Open linked pull request #55" });
    expect(prButton).toBeTruthy();
    expect(prButton.querySelector("svg")).not.toBeNull();
  });

  it("renders labels and linked PR together without conflict", () => {
    const issueWithBoth: Issue = {
      ...baseIssue,
      labels: [
        { name: "bug", color: "d73a4a" },
        { name: "high-priority", color: "e11d48" },
      ],
      linkedPR: { number: 55, state: "open", url: "https://github.com/test/repo/pull/55" },
      assignees: [{ login: "alice", avatarUrl: "https://example.com/alice.png", rawData: null }],
    };
    const { container } = render(<GitHubListItem item={issueWithBoth} type="issue" />);
    expect(screen.getByText("bug")).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();
    expect(container.textContent).toContain("bug, high-priority");
    expect(screen.getByRole("button", { name: "Open linked pull request #55" })).toBeTruthy();
    expect(screen.getByAltText("alice")).toBeTruthy();
  });

  it("renders #number badge", () => {
    render(<GitHubListItem item={baseIssue} type="issue" />);
    const copyButton = screen.getByLabelText("Copy number 42");
    expect(copyButton.textContent).toBe("#42");
  });

  it("separates the keyboard cursor from membership, and spends no accent on either", () => {
    // Three distinct states have to stay distinguishable: resting, the row
    // Enter would act on, and the rows bulk actions would act on. The cursor
    // gets the leading rail; membership gets the heavier fill. Accent is
    // reserved for the one focus anchor in the region (the search field).
    const resting = render(<GitHubListItem item={baseIssue} type="issue" />);
    const restingClass = resting.container.querySelector("[role='row']")!.className;
    resting.unmount();

    const active = render(<GitHubListItem item={baseIssue} type="issue" isActive />);
    const activeOption = active.container.querySelector("[role='row']")!;
    expect(activeOption.getAttribute("aria-selected")).toBe("false");
    expect(activeOption.className).not.toBe(restingClass);
    active.unmount();

    const selected = render(
      <GitHubListItem
        item={baseIssue}
        type="issue"
        isSelected
        isSelectionActive
        onToggleSelect={vi.fn()}
      />
    );
    const selectedOption = selected.container.querySelector("[role='row']")!;
    expect(selectedOption.getAttribute("aria-selected")).toBe("true");
    expect(selectedOption.className).not.toBe(restingClass);
    expect(selectedOption.className).not.toBe(activeOption.className);

    for (const cls of [restingClass, activeOption.className, selectedOption.className]) {
      expect(cls).not.toMatch(/daintree-accent/);
    }
  });

  it("fills the checkbox with neutral ink, never the accent", () => {
    const { container } = render(
      <GitHubListItem
        item={baseIssue}
        type="issue"
        isSelected
        isSelectionActive
        onToggleSelect={vi.fn()}
      />
    );
    const checkboxes = container.querySelectorAll("[aria-hidden='true']");
    const classes = Array.from(checkboxes).map((el) => el.getAttribute("class") ?? "");
    expect(classes.some((c) => c.includes("bg-text-primary"))).toBe(true);
    expect(classes.some((c) => c.includes("bg-accent-primary"))).toBe(false);
  });

  it("scopes checkbox hover to icon area via named group", () => {
    const { container } = render(
      <GitHubListItem item={baseIssue} type="issue" onToggleSelect={vi.fn()} />
    );
    const iconWrapper = container.querySelector(".group\\/icon");
    expect(iconWrapper).not.toBeNull();

    const children = iconWrapper!.querySelectorAll(":scope > span");
    const stateIcon = children[0];
    const checkbox = children[1];

    expect(stateIcon?.className).toContain("group-hover/icon:hidden");
    expect(stateIcon?.className).not.toContain("group-hover:hidden");

    expect(checkbox?.className).toContain("group-hover/icon:flex");
    expect(checkbox?.className).not.toContain("group-hover:flex");
  });

  it("shows checkbox unconditionally when selection is active", () => {
    const { container } = render(
      <GitHubListItem item={baseIssue} type="issue" isSelectionActive onToggleSelect={vi.fn()} />
    );
    const iconWrapper = container.querySelector(".group\\/icon");
    expect(iconWrapper).not.toBeNull();

    const children = iconWrapper!.querySelectorAll(":scope > span");
    const stateIcon = children[0];
    const checkbox = children[1];

    expect(stateIcon?.className).toContain("hidden");
    expect(stateIcon?.className).not.toContain("group-hover/icon:hidden");

    expect(checkbox?.className).toContain("flex");
    expect(checkbox?.className).not.toContain("group-hover/icon:flex");
  });

  it("calls onToggleSelect when clicking title during active selection", () => {
    const onToggleSelect = vi.fn();
    vi.mocked(actionService.dispatch).mockClear();
    render(
      <GitHubListItem
        item={baseIssue}
        type="issue"
        isSelectionActive
        onToggleSelect={onToggleSelect}
      />
    );
    fireEvent.click(screen.getByText("Fix the thing"));
    expect(onToggleSelect).toHaveBeenCalled();
    expect(actionService.dispatch).not.toHaveBeenCalled();
  });

  it("renders assignee avatar for issues with assignees", () => {
    const issueWithAssignee: Issue = {
      ...baseIssue,
      assignees: [{ login: "alice", avatarUrl: "https://example.com/alice.png", rawData: null }],
    };
    render(<GitHubListItem item={issueWithAssignee} type="issue" />);
    const avatar = screen.getByAltText("alice");
    expect(avatar).toBeTruthy();
    expect(avatar.getAttribute("src")).toBe("https://example.com/alice.png");
  });

  it("renders only first assignee avatar when multiple assignees", () => {
    const issueWithMultiple: Issue = {
      ...baseIssue,
      assignees: [
        { login: "alice", avatarUrl: "https://example.com/alice.png", rawData: null },
        { login: "bob", avatarUrl: "https://example.com/bob.png", rawData: null },
      ],
    };
    render(<GitHubListItem item={issueWithMultiple} type="issue" />);
    expect(screen.getByAltText("alice")).toBeTruthy();
    expect(screen.queryByAltText("bob")).toBeNull();
  });

  it("does not render assignee avatar when no assignees", () => {
    const { container } = render(<GitHubListItem item={baseIssue} type="issue" />);
    const avatarImages = container.querySelectorAll("img[alt]");
    expect(avatarImages).toHaveLength(0);
  });

  it("does not render assignee avatar for PRs", () => {
    render(<GitHubListItem item={basePR} type="pr" />);
    const images = screen.queryAllByRole("img");
    expect(images).toHaveLength(0);
  });

  it("makes creating a worktree the row's primary click, not a hover-only glyph", async () => {
    const onCreateWorktree = vi.fn();
    const { container } = render(
      <GitHubListItem item={baseIssue} type="issue" onCreateWorktree={onCreateWorktree} />
    );
    // The old affordance was an `opacity-0` icon button that only appeared on
    // hover, duplicating a menu item nobody needed twice.
    expect(screen.queryByLabelText("Create worktree")).toBeNull();

    await act(async () => {
      fireEvent.click(container.querySelector("[role='row']")!);
    });
    expect(onCreateWorktree).toHaveBeenCalledWith(baseIssue);
  });

  it("does not create a worktree from a closed issue", async () => {
    const onCreateWorktree = vi.fn();
    const closedIssue: Issue = { ...baseIssue, state: "closed" };
    const { container } = render(
      <GitHubListItem item={closedIssue} type="issue" onCreateWorktree={onCreateWorktree} />
    );
    await act(async () => {
      fireEvent.click(container.querySelector("[role='row']")!);
    });
    expect(onCreateWorktree).not.toHaveBeenCalled();
  });

  it("creates a worktree from a fork PR row", async () => {
    const onCreateWorktree = vi.fn();
    const forkPR: PR = { ...basePR, rawData: { isFork: true } };
    const { container } = render(
      <GitHubListItem item={forkPR} type="pr" onCreateWorktree={onCreateWorktree} />
    );
    await act(async () => {
      fireEvent.click(container.querySelector("[role='row']")!);
    });
    expect(onCreateWorktree).toHaveBeenCalledWith(forkPR);
  });

  it("shows comment count for issues with commentCount >= 1", () => {
    render(<GitHubListItem item={{ ...baseIssue, commentCount: 3 }} type="issue" />);
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("hides comment count for issues with commentCount 0", () => {
    render(<GitHubListItem item={{ ...baseIssue, commentCount: 0 }} type="issue" />);
    // The "0" should not appear as a comment count
    const allText = screen.queryAllByText("0");
    expect(allText).toHaveLength(0);
  });

  it("shows comment count for PRs with commentCount >= 1", () => {
    render(<GitHubListItem item={{ ...basePR, commentCount: 7 }} type="pr" />);
    expect(screen.getByText("7")).toBeTruthy();
  });

  it("hides comment count for PRs with commentCount 0", () => {
    const { container } = render(
      <GitHubListItem item={{ ...basePR, commentCount: 0 }} type="pr" />
    );
    const svgs = container.querySelectorAll("svg.lucide-message-square");
    expect(svgs).toHaveLength(0);
  });

  it("hides comment count for PRs without commentCount", () => {
    const { container } = render(<GitHubListItem item={basePR} type="pr" />);
    const svgs = container.querySelectorAll("svg.lucide-message-square");
    expect(svgs).toHaveLength(0);
  });

  it("renders the issue comment count before labels in the metadata row", () => {
    const issue: Issue = {
      ...baseIssue,
      commentCount: 4,
      labels: [{ name: "enhancement", color: "a2eeef" }],
    };
    const { container } = render(<GitHubListItem item={issue} type="issue" />);
    const commentIcon = container.querySelector("svg.lucide-message-square");
    const label = screen.getByText("enhancement");
    expect(commentIcon).not.toBeNull();
    // DOCUMENT_POSITION_FOLLOWING set => label comes after the comment icon.
    expect(
      commentIcon!.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("renders the PR comment count before the head branch in the metadata row", () => {
    const pr: PR = { ...basePR, commentCount: 6, headRef: "feature/new-thing" };
    const { container } = render(<GitHubListItem item={pr} type="pr" />);
    const commentIcon = container.querySelector("svg.lucide-message-square");
    const headRef = screen.getByText("feature/new-thing");
    expect(commentIcon).not.toBeNull();
    expect(
      commentIcon!.compareDocumentPosition(headRef) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("does not show Copy icon - only # prefix and Check on copy", async () => {
    const { container } = render(<GitHubListItem item={baseIssue} type="issue" />);
    // No Copy icon should exist
    expect(container.querySelector(".lucide-copy")).toBeNull();

    const copyButton = screen.getByLabelText("Copy number 42");
    // Before copy: shows # prefix
    expect(copyButton.textContent).toBe("#42");

    await act(async () => {
      fireEvent.click(copyButton);
    });

    // After copy: Check icon replaces #
    const checkIcon = copyButton.querySelector(".text-status-success");
    expect(checkIcon).not.toBeNull();
    // The # yields to the check during the copied state, and the digits stay
    // put so the row does not reflow.
    expect(copyButton.textContent).toBe("42");
  });
});
