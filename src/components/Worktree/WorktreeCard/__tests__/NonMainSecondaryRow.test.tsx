/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { WorktreeChanges, WorktreeState } from "@/types";
import type { CIStatus } from "@shared/types/forge";
import { usePRCircuitBreakerStore } from "@/store/prCircuitBreakerStore";
import { TooltipProvider } from "@/components/ui/tooltip";

const prBadgeProps: Array<Record<string, unknown>> = [];
const upstreamBadgeProps: Array<Record<string, unknown>> = [];

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

const issueBadgeProps: Array<Record<string, unknown>> = [];

vi.mock("../PRBadge", () => ({
  PRBadge: (props: Record<string, unknown>) => {
    prBadgeProps.push(props);
    return <div data-testid="pr-badge" data-call-index={prBadgeProps.length - 1} />;
  },
}));

vi.mock("../IssueBadge", () => ({
  IssueBadge: (props: Record<string, unknown>) => {
    issueBadgeProps.push(props);
    return <div data-testid="issue-badge" data-call-index={issueBadgeProps.length - 1} />;
  },
}));

vi.mock("../UpstreamSyncBadge", () => ({
  UpstreamSyncBadge: (props: Record<string, unknown>) => {
    upstreamBadgeProps.push(props);
    return (
      <div data-testid="upstream-sync-badge" data-call-index={upstreamBadgeProps.length - 1} />
    );
  },
}));

import { NonMainSecondaryRow } from "../NonMainSecondaryRow";

const baseWorktree = {
  id: "wt-1",
  path: "/repo",
  name: "feature",
  branch: "feature/test",
  issueNumber: 123,
  prNumber: 42,
  prState: "open",
  linked: {
    providerId: "github",
    pr: {
      ref: { providerId: "github", owner: "test", repo: "test", number: 42, rawData: {} },
      state: "open",
      url: "https://github.com/test/repo/pull/42",
    },
  },
} as unknown as WorktreeState;

interface RenderOverrides {
  worktree?: WorktreeState;
  hasUpstreamDelta?: boolean;
  hasAuthFailedSignIn?: boolean;
  hasDisplayTitle?: boolean;
  isPrOriginated?: boolean;
  hasCustomTitle?: boolean;
  hasPlanFile?: boolean;
  quietGit?: boolean;
  variant?: "sidebar" | "grid";
  density?: "comfortable" | "compact";
}

function renderRow(overrides: RenderOverrides = {}) {
  return render(
    <TooltipProvider>
      <NonMainSecondaryRow
        worktree={overrides.worktree ?? baseWorktree}
        branchLabel="feature/test"
        isActive
        hasUpstreamDelta={overrides.hasUpstreamDelta ?? false}
        hasAuthFailedSignIn={overrides.hasAuthFailedSignIn ?? false}
        hasDisplayTitle={overrides.hasDisplayTitle ?? false}
        isPrOriginated={overrides.isPrOriginated ?? false}
        hasCustomTitle={overrides.hasCustomTitle}
        hasPlanFile={overrides.hasPlanFile ?? false}
        quietGit={overrides.quietGit}
        variant={overrides.variant}
        density={overrides.density}
        badges={{ onOpenPlan: vi.fn() }}
      />
    </TooltipProvider>
  );
}

function ciFailureLinked() {
  return {
    providerId: "github",
    pr: {
      ref: { providerId: "github", owner: "test", repo: "test", number: 42, rawData: {} },
      state: "open" as const,
      url: "https://github.com/test/repo/pull/42",
      ciStatus: {
        state: "failure" as const,
        total: 1,
        passed: 0,
        failed: 1,
        pending: 0,
        rawData: {},
      },
    },
  };
}

describe("NonMainSecondaryRow → PRBadge circuit-breaker wiring", () => {
  beforeEach(() => {
    prBadgeProps.length = 0;
    upstreamBadgeProps.length = 0;
    usePRCircuitBreakerStore.setState({ tripped: false });
  });

  it("passes prDetectionPaused=true when the breaker is tripped", () => {
    usePRCircuitBreakerStore.setState({ tripped: true });
    renderRow();
    expect(prBadgeProps.at(-1)?.prDetectionPaused).toBe(true);
  });
});

describe("NonMainSecondaryRow → badge ordering by alarm tier", () => {
  // The grid keeps the sync line on the card, so the ordering contract lives
  // there; the sidebar moves ambient drift into Details (see below).
  beforeEach(() => {
    prBadgeProps.length = 0;
    upstreamBadgeProps.length = 0;
    usePRCircuitBreakerStore.setState({ tripped: false });
  });

  it("renders PR before UpstreamSync when no alarms are active", () => {
    const { container } = renderRow({
      variant: "grid",
      worktree: { ...baseWorktree, behindCount: 0, fetchAuthFailed: false } as WorktreeState,
      hasUpstreamDelta: true,
    });
    const order = Array.from(container.querySelectorAll("[data-testid]")).map((el) =>
      el.getAttribute("data-testid")
    );
    const prIdx = order.indexOf("pr-badge");
    const upIdx = order.indexOf("upstream-sync-badge");
    expect(prIdx).toBeGreaterThanOrEqual(0);
    expect(upIdx).toBeGreaterThanOrEqual(0);
    expect(prIdx).toBeLessThan(upIdx);
  });

  it("PR stays first when CI failed (PR is the salient alarm)", () => {
    const { container } = renderRow({
      variant: "grid",
      worktree: {
        ...baseWorktree,
        behindCount: 3,
        linked: ciFailureLinked(),
      } as WorktreeState,
      hasUpstreamDelta: true,
    });
    const order = Array.from(container.querySelectorAll("[data-testid]")).map((el) =>
      el.getAttribute("data-testid")
    );
    const prIdx = order.indexOf("pr-badge");
    const upIdx = order.indexOf("upstream-sync-badge");
    expect(prIdx).toBeGreaterThanOrEqual(0);
    expect(upIdx).toBeGreaterThanOrEqual(0);
    expect(prIdx).toBeLessThan(upIdx);
  });

  it("UpstreamSync moves before PR when auth-failed (auth > healthy PR)", () => {
    const { container } = renderRow({
      variant: "grid",
      worktree: {
        ...baseWorktree,
        fetchAuthFailed: true,
        matchedForgeProviderId: "daintree.github.github",
      } as WorktreeState,
      hasUpstreamDelta: false,
      hasAuthFailedSignIn: true,
    });
    const order = Array.from(container.querySelectorAll("[data-testid]")).map((el) =>
      el.getAttribute("data-testid")
    );
    const prIdx = order.indexOf("pr-badge");
    const upIdx = order.indexOf("upstream-sync-badge");
    expect(prIdx).toBeGreaterThanOrEqual(0);
    expect(upIdx).toBeGreaterThanOrEqual(0);
    expect(upIdx).toBeLessThan(prIdx);
  });

  it("UpstreamSync moves before PR when behindCount > 0 (no CI failure)", () => {
    const { container } = renderRow({
      variant: "grid",
      worktree: { ...baseWorktree, behindCount: 5 } as WorktreeState,
      hasUpstreamDelta: true,
    });
    const order = Array.from(container.querySelectorAll("[data-testid]")).map((el) =>
      el.getAttribute("data-testid")
    );
    const prIdx = order.indexOf("pr-badge");
    const upIdx = order.indexOf("upstream-sync-badge");
    expect(prIdx).toBeGreaterThanOrEqual(0);
    expect(upIdx).toBeGreaterThanOrEqual(0);
    expect(upIdx).toBeLessThan(prIdx);
  });

  it("PR-originated: the source PR is its own reference here, beside the linked issue", () => {
    issueBadgeProps.length = 0;
    prBadgeProps.length = 0;
    renderRow({
      variant: "grid",
      worktree: {
        ...baseWorktree,
        sourcePrNumber: 42,
        // A title the reference could repeat, so leaving it off is a decision.
        prTitle: "Fix the login flow",
        issueNumber: 123,
      } as WorktreeState,
      hasDisplayTitle: true,
      isPrOriginated: true,
    });
    // The headline above shows the PR's title as words (#15864), so the PR
    // opens from a reference of its own: the source PR, once, by number.
    expect(prBadgeProps.map((p) => p.prNumber)).toEqual([42]);
    expect(prBadgeProps[0]?.prTitle).toBeUndefined();
    // The linked issue surfaces in the secondary row even though hasDisplayTitle is true.
    expect(issueBadgeProps.at(-1)?.issueNumber).toBe(123);
  });

  it("issue headline: the issue opens from a number-only reference in the stack (#15864)", () => {
    issueBadgeProps.length = 0;
    renderRow({
      variant: "grid",
      worktree: { ...baseWorktree, issueNumber: 123, issueTitle: "Fix login" } as WorktreeState,
      hasDisplayTitle: true,
      isPrOriginated: false,
    });
    expect(issueBadgeProps.map((p) => p.issueNumber)).toEqual([123]);
    // The title is already the headline; the reference does not repeat it.
    expect(issueBadgeProps[0]?.issueTitle).toBeUndefined();
  });

  it("PR-originated with no linked issue: renders no issue badge", () => {
    issueBadgeProps.length = 0;
    prBadgeProps.length = 0;
    const { queryByTestId } = renderRow({
      variant: "grid",
      worktree: {
        ...baseWorktree,
        sourcePrNumber: 10,
        issueNumber: undefined,
      } as unknown as WorktreeState,
      hasDisplayTitle: true,
      isPrOriginated: true,
    });
    expect(queryByTestId("issue-badge")).toBeNull();
    expect(prBadgeProps.map((p) => p.prNumber)).toEqual([10]);
  });
});

describe("NonMainSecondaryRow — base relationship without drift", () => {
  // Grid: the sidebar card leaves an in-sync or drifting line to Details.
  function changesWith(tracking: string | null): WorktreeChanges {
    return {
      worktreeId: "wt-1",
      rootPath: "/repo",
      changes: [],
      changedFileCount: 0,
      tracking,
      ahead: tracking ? 0 : undefined,
      behind: tracking ? 0 : undefined,
    };
  }

  function onBase(extra: Partial<WorktreeState> = {}): WorktreeState {
    return {
      ...baseWorktree,
      baseBranchName: "develop",
      baseAheadCount: 0,
      baseBehindCount: 0,
      worktreeChanges: changesWith(null),
      ...extra,
    } as WorktreeState;
  }

  beforeEach(() => {
    upstreamBadgeProps.length = 0;
  });

  it("mounts the sync badge for an in-sync branch, on the base name alone", () => {
    const { queryByTestId } = renderRow({
      variant: "grid",
      worktree: onBase(),
      hasUpstreamDelta: false,
    });
    expect(queryByTestId("upstream-sync-badge")).not.toBeNull();
  });

  // With no base to name the row still hands the badge what a status pass
  // established — here, that no upstream is configured — and the badge
  // decides whether that is worth a line.
  it("still mounts the badge with no base branch once a status pass has run", () => {
    const { queryByTestId } = renderRow({
      variant: "grid",
      worktree: onBase({ baseBranchName: null }),
      hasUpstreamDelta: false,
    });
    expect(queryByTestId("upstream-sync-badge")).not.toBeNull();
    expect(upstreamBadgeProps.at(-1)?.hasNoUpstream).toBe(true);
  });

  it("derives the no-upstream marker from the tracking ref, not from absent counts", () => {
    renderRow({ variant: "grid", worktree: onBase() });
    expect(upstreamBadgeProps.at(-1)?.hasNoUpstream).toBe(true);

    upstreamBadgeProps.length = 0;
    renderRow({
      variant: "grid",
      worktree: onBase({ worktreeChanges: changesWith("origin/feature/test") }),
    });
    expect(upstreamBadgeProps.at(-1)?.hasNoUpstream).toBe(false);
  });

  it("does not describe a detached HEAD as a branch sitting on its base", () => {
    const { queryByTestId } = renderRow({
      variant: "grid",
      worktree: onBase({ isDetached: true }),
      hasUpstreamDelta: false,
    });
    expect(queryByTestId("upstream-sync-badge")).toBeNull();
  });

  it("still shows a detached HEAD's drift, without calling it an unpushed branch", () => {
    const { queryByTestId } = renderRow({
      variant: "grid",
      worktree: onBase({ isDetached: true, baseAheadCount: 3 }),
      hasUpstreamDelta: true,
    });
    expect(queryByTestId("upstream-sync-badge")).not.toBeNull();
    expect(upstreamBadgeProps.at(-1)?.hasNoUpstream).toBe(false);
  });

  it("does not claim a missing upstream before any status snapshot has landed", () => {
    renderRow({
      variant: "grid",
      worktree: {
        ...baseWorktree,
        worktreeChanges: null,
        fetchAuthFailed: true,
        matchedForgeProviderId: "daintree.github.github",
      } as WorktreeState,
      hasAuthFailedSignIn: true,
    });
    expect(upstreamBadgeProps.at(-1)?.hasNoUpstream).toBe(false);
  });
});

describe("NonMainSecondaryRow — a fetch mounts the sync line even with nothing to count", () => {
  // Grid: the sidebar keeps only a failed fetch on the card (see below).
  beforeEach(() => {
    upstreamBadgeProps.length = 0;
  });

  // With no counts and no base to show, the badge's failure mark is the only
  // thing saying the numbers are unconfirmed; gating it on the counts hid it.
  it.each([
    ["an unreachable remote", { fetchNetworkFailed: true }],
    ["an auth failure with no reconnect to offer", { fetchAuthFailed: true }],
    // The badge decides for itself whether a completed fetch leaves it
    // anything to say (no upstream, say), so the row lets it try.
    ["a completed fetch", { lastFetchedAt: 1 }],
  ])("mounts for %s", (_label, failure) => {
    renderRow({
      variant: "grid",
      worktree: { ...baseWorktree, baseBranchName: null, ...failure } as WorktreeState,
    });
    expect(upstreamBadgeProps).not.toHaveLength(0);
  });

  it("stays unmounted with nothing to say and nothing wrong", () => {
    renderRow({
      variant: "grid",
      worktree: { ...baseWorktree, baseBranchName: null } as WorktreeState,
    });
    expect(upstreamBadgeProps).toHaveLength(0);
  });
});

describe("NonMainSecondaryRow — quiet git detail (#13777)", () => {
  // Grid: the sidebar moves ambient drift into Details in every profile.
  const tracked: WorktreeChanges = {
    worktreeId: "wt-1",
    rootPath: "/repo",
    changes: [],
    changedFileCount: 0,
    tracking: "origin/feature/test",
  };
  const failing: CIStatus = {
    state: "failure",
    total: 3,
    passed: 2,
    failed: 1,
    pending: 0,
    rawData: null,
  };
  const syncedWorktree: WorktreeState = {
    ...baseWorktree,
    baseBranchName: "develop",
    aheadCount: 2,
    behindCount: 0,
    worktreeChanges: tracked,
  };

  function withPr(pr: Partial<NonNullable<NonNullable<WorktreeState["linked"]>["pr"]>>) {
    return {
      ...syncedWorktree,
      linked: { ...syncedWorktree.linked!, pr: { ...syncedWorktree.linked!.pr!, ...pr } },
    } as WorktreeState;
  }

  it("draws today's branch, issue, PR and sync lines when shown", () => {
    const { queryByTestId, queryByText } = renderRow({
      variant: "grid",
      worktree: syncedWorktree,
      hasDisplayTitle: true,
      hasCustomTitle: true,
    });

    expect(queryByTestId("issue-badge")).not.toBeNull();
    expect(queryByTestId("pr-badge")).not.toBeNull();
    expect(queryByTestId("upstream-sync-badge")).not.toBeNull();
    expect(queryByText("feature/test")).not.toBeNull();
  });

  it("drops the branch, issue, at-rest PR and in-sync line when quiet", () => {
    const { queryByTestId, queryByText } = renderRow({
      variant: "grid",
      worktree: syncedWorktree,
      hasDisplayTitle: true,
      hasCustomTitle: true,
      quietGit: true,
    });

    expect(queryByTestId("issue-badge")).toBeNull();
    expect(queryByTestId("pr-badge")).toBeNull();
    expect(queryByTestId("upstream-sync-badge")).toBeNull();
    expect(queryByText("feature/test")).toBeNull();
  });

  it("keeps a failing PR when quiet", () => {
    const { queryByTestId } = renderRow({
      variant: "grid",
      worktree: withPr({ ciStatus: failing }),
      quietGit: true,
    });

    expect(queryByTestId("pr-badge")).not.toBeNull();
  });

  it("drops a PR whose head moved with no merge armed, which is no warning", () => {
    const { queryByTestId } = renderRow({
      variant: "grid",
      worktree: withPr({ headMovedWhileArmed: true }),
      quietGit: true,
    });

    expect(queryByTestId("pr-badge")).toBeNull();
  });

  it("keeps a PR whose head moved under an armed merge when quiet", () => {
    const { queryByTestId } = renderRow({
      variant: "grid",
      worktree: withPr({
        mergeIntent: { kind: "auto-merge", method: null, enabledAt: null },
        headMovedWhileArmed: true,
      }),
      quietGit: true,
    });

    expect(queryByTestId("pr-badge")).not.toBeNull();
  });

  it("keeps the failing PR a custom title displaced when quiet", () => {
    const { queryAllByTestId } = renderRow({
      variant: "grid",
      worktree: {
        ...withPr({ ciStatus: failing }),
        sourcePrNumber: 42,
      } as WorktreeState,
      isPrOriginated: true,
      hasCustomTitle: true,
      quietGit: true,
    });

    expect(queryAllByTestId("pr-badge")).toHaveLength(1);
  });

  it.each([
    ["behind its upstream", { behindCount: 3 }, { hasUpstreamDelta: true }],
    ["behind its base", { baseBehindCount: 4 }, { hasUpstreamDelta: true }],
    ["after a failed fetch", { fetchNetworkFailed: true }, {}],
    ["after a refused sign-in", { fetchAuthFailed: true }, { hasAuthFailedSignIn: true }],
  ])("keeps the sync line %s when quiet", (_label, fields, overrides) => {
    const { queryByTestId } = renderRow({
      variant: "grid",
      worktree: { ...syncedWorktree, ...fields } as WorktreeState,
      quietGit: true,
      ...overrides,
    });

    expect(queryByTestId("upstream-sync-badge")).not.toBeNull();
  });

  it("keeps the plan file, which is not git detail", () => {
    const { container } = renderRow({
      variant: "grid",
      worktree: { ...syncedWorktree, planFilePath: "PLAN.md" } as WorktreeState,
      hasPlanFile: true,
      quietGit: true,
    });

    expect(container.textContent).toContain("PLAN.md");
  });
});

describe("NonMainSecondaryRow — sidebar identity row", () => {
  beforeEach(() => {
    upstreamBadgeProps.length = 0;
  });

  it("keeps upstream drift on the identity row and leaves the base relationship to Details", () => {
    const { container } = renderRow({
      hasDisplayTitle: true,
      hasUpstreamDelta: true,
      worktree: {
        ...baseWorktree,
        aheadCount: 2,
        behindCount: 3,
        baseBranchName: "develop",
        baseBehindCount: 6,
      } as WorktreeState,
    });
    expect(upstreamBadgeProps).toHaveLength(1);
    expect(upstreamBadgeProps[0]).toMatchObject({ aheadCount: 2, behindCount: 3 });
    expect(upstreamBadgeProps[0]?.baseBranchName).toBeUndefined();
    expect(container.textContent).toContain("feature/test");
  });

  it("leaves drift against the base alone to Details", () => {
    renderRow({
      hasDisplayTitle: true,
      hasUpstreamDelta: true,
      worktree: { ...baseWorktree, baseBranchName: "develop", baseBehindCount: 6 } as WorktreeState,
    });
    expect(upstreamBadgeProps).toHaveLength(0);
  });

  it("keeps a failed fetch on the card", () => {
    renderRow({
      hasDisplayTitle: true,
      worktree: { ...baseWorktree, fetchNetworkFailed: true } as WorktreeState,
    });
    expect(upstreamBadgeProps).not.toHaveLength(0);
  });
});

describe("NonMainSecondaryRow — comfortable sidebar sync line", () => {
  beforeEach(() => {
    upstreamBadgeProps.length = 0;
  });

  it("gives the sync line no row while the branch is level with its upstream and base", () => {
    renderRow({
      density: "comfortable",
      hasDisplayTitle: true,
      worktree: {
        ...baseWorktree,
        baseBranchName: "develop",
        lastFetchedAt: 1,
      } as WorktreeState,
    });
    expect(upstreamBadgeProps).toHaveLength(0);
  });

  it("gives drift against the base a row, with the base named", () => {
    renderRow({
      density: "comfortable",
      hasDisplayTitle: true,
      hasUpstreamDelta: true,
      worktree: { ...baseWorktree, baseBranchName: "develop", baseBehindCount: 6 } as WorktreeState,
    });
    expect(upstreamBadgeProps).toHaveLength(1);
    expect(upstreamBadgeProps[0]?.baseBranchName).toBe("develop");
  });

  it("gives a failed fetch a row even with no drift", () => {
    renderRow({
      density: "comfortable",
      hasDisplayTitle: true,
      worktree: { ...baseWorktree, fetchNetworkFailed: true } as WorktreeState,
    });
    expect(upstreamBadgeProps).toHaveLength(1);
  });
});
