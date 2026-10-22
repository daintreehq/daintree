/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { WorktreeState } from "@/types";
import { TooltipProvider } from "@/components/ui/tooltip";

const prBadgeProps: Array<Record<string, unknown>> = [];
const issueBadgeProps: Array<Record<string, unknown>> = [];
const upstreamBadgeProps: Array<Record<string, unknown>> = [];

vi.mock("../PRBadge", () => ({
  PRBadge: (props: Record<string, unknown>) => {
    prBadgeProps.push(props);
    return <div data-testid="pr-badge" />;
  },
}));

vi.mock("../IssueBadge", () => ({
  IssueBadge: (props: Record<string, unknown>) => {
    issueBadgeProps.push(props);
    return <div data-testid="issue-badge" />;
  },
}));

vi.mock("../UpstreamSyncBadge", () => ({
  UpstreamSyncBadge: (props: Record<string, unknown>) => {
    upstreamBadgeProps.push(props);
    return <div data-testid="upstream-sync-badge" />;
  },
}));

import { QuietGitDetails } from "../QuietGitDetails";

const worktree: WorktreeState = {
  id: "wt-1",
  worktreeId: "wt-1",
  path: "/repo",
  name: "feature",
  branch: "feature/test",
  isCurrent: false,
  isMainWorktree: false,
  worktreeChanges: null,
  lastActivityTimestamp: null,
  issueNumber: 123,
  issueTitle: "Fix the login",
  baseBranchName: "develop",
  isDetached: false,
  linked: {
    providerId: "github",
    pr: {
      ref: { providerId: "github", owner: "o", repo: "r", number: 42, rawData: null },
      state: "open",
      title: "Login fix",
      url: "https://github.com/o/r/pull/42",
    },
  },
};

function renderDetails(overrides: Partial<WorktreeState> = {}) {
  const onOpenIssue = vi.fn();
  const onOpenPR = vi.fn();
  render(
    <TooltipProvider>
      <QuietGitDetails
        worktree={{ ...worktree, ...overrides }}
        branchLabel="feature/test"
        isActive
        onOpenIssue={onOpenIssue}
        onOpenPR={onOpenPR}
      />
    </TooltipProvider>
  );
  return { onOpenIssue, onOpenPR };
}

beforeEach(() => {
  prBadgeProps.length = 0;
  issueBadgeProps.length = 0;
  upstreamBadgeProps.length = 0;
});

describe("QuietGitDetails", () => {
  it("draws every line the quieted header stopped drawing", () => {
    renderDetails();

    expect(screen.getByText("feature/test")).not.toBeNull();
    expect(screen.queryByTestId("issue-badge")).not.toBeNull();
    expect(screen.queryByTestId("pr-badge")).not.toBeNull();
    expect(screen.queryByTestId("upstream-sync-badge")).not.toBeNull();
  });

  it("keeps the issue and PR openable, with their titles", () => {
    const { onOpenIssue, onOpenPR } = renderDetails();

    expect(issueBadgeProps[0]).toMatchObject({ issueTitle: "Fix the login", onOpen: onOpenIssue });
    expect(prBadgeProps[0]).toMatchObject({ prTitle: "Login fix", onOpen: onOpenPR });
  });

  it("leaves out a PR that is no longer open", () => {
    renderDetails({
      linked: { ...worktree.linked!, pr: { ...worktree.linked!.pr!, state: "closed" } },
    });

    expect(screen.queryByTestId("pr-badge")).toBeNull();
  });

  it("measures a detached HEAD against no base, as the header does", () => {
    renderDetails({ isDetached: true });

    expect(upstreamBadgeProps[0]?.baseBranchName).toBeUndefined();
  });
});
