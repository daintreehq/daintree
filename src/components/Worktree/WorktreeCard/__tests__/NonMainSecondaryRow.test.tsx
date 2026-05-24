/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { WorktreeState } from "@/types";
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
}

function renderRow(overrides: RenderOverrides = {}) {
  return render(
    <TooltipProvider>
      <NonMainSecondaryRow
        worktree={overrides.worktree ?? baseWorktree}
        branchLabel="feature/test"
        isActive
        underlineOnHover={false}
        hasUpstreamDelta={overrides.hasUpstreamDelta ?? false}
        hasAuthFailedSignIn={overrides.hasAuthFailedSignIn ?? false}
        hasDisplayTitle={overrides.hasDisplayTitle ?? false}
        isPrOriginated={overrides.isPrOriginated ?? false}
        hasPlanFile={false}
        badges={{}}
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

  it("passes prDetectionPaused=false when the breaker is not tripped", () => {
    renderRow();
    expect(prBadgeProps.at(-1)?.prDetectionPaused).toBe(false);
  });

  it("passes prDetectionPaused=true when the breaker is tripped", () => {
    usePRCircuitBreakerStore.setState({ tripped: true });
    renderRow();
    expect(prBadgeProps.at(-1)?.prDetectionPaused).toBe(true);
  });
});

describe("NonMainSecondaryRow → badge ordering by alarm tier", () => {
  beforeEach(() => {
    prBadgeProps.length = 0;
    upstreamBadgeProps.length = 0;
    usePRCircuitBreakerStore.setState({ tripped: false });
  });

  it("renders PR before UpstreamSync when no alarms are active", () => {
    const { container } = renderRow({
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
      worktree: {
        ...baseWorktree,
        fetchAuthFailed: true,
        isGitHubRemote: true,
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

  it("CI failed beats auth-failed — PR stays first", () => {
    const { container } = renderRow({
      worktree: {
        ...baseWorktree,
        fetchAuthFailed: true,
        isGitHubRemote: true,
        linked: ciFailureLinked(),
      } as WorktreeState,
      hasAuthFailedSignIn: true,
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

  it("PR-originated: suppresses the subordinate PR badge and shows the linked issue", () => {
    issueBadgeProps.length = 0;
    const { queryByTestId } = renderRow({
      worktree: {
        ...baseWorktree,
        sourcePrNumber: 42,
        issueNumber: 123,
      } as WorktreeState,
      hasDisplayTitle: true,
      isPrOriginated: true,
    });
    // PR is the headline above — no subordinate PR badge here.
    expect(queryByTestId("pr-badge")).toBeNull();
    // The linked issue surfaces in the secondary row even though hasDisplayTitle is true.
    expect(issueBadgeProps.at(-1)?.issueNumber).toBe(123);
  });

  it("CI 'pending' does not flip the order (transient — no spatial churn)", () => {
    const pendingLinked = ciFailureLinked();
    pendingLinked.pr.ciStatus.state = "pending" as never;
    const { container } = renderRow({
      worktree: {
        ...baseWorktree,
        behindCount: 1,
        linked: pendingLinked,
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
    expect(upIdx).toBeLessThan(prIdx);
  });
});
