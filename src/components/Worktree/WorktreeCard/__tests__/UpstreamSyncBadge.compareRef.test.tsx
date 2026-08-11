/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

// The real tooltip lazy-loads Radix and renders nothing until it resolves, so
// its content is invisible to jsdom. Flatten it — these tests are about the
// tooltip's copy, which is where #11747 names the ref it compared against.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/formatRelativeTime", () => ({
  formatRelativeTime: () => "just now",
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

import { UpstreamSyncBadge } from "../UpstreamSyncBadge";

type Props = Parameters<typeof UpstreamSyncBadge>[0];

const baseProps: Props = {
  aheadCount: 0,
  behindCount: 0,
  isFetchInFlight: false,
  lastFetchedAt: Date.now(),
  fetchAuthFailed: false,
  fetchNetworkFailed: false,
  hasAuthFailedSignIn: false,
  containerGapClass: "gap-1.5",
  baseBranchName: "main",
  baseAheadCount: 0,
  baseBehindCount: 200,
  baseMatchesUpstream: false,
};

function renderBadge(extra: Partial<Props> = {}) {
  return render(<UpstreamSyncBadge {...baseProps} {...extra} />);
}

afterEach(() => {
  cleanup();
});

describe("UpstreamSyncBadge — base compare ref (#11747)", () => {
  it("names the resolved remote ref in the tooltip, not just the branch", () => {
    // On a fork layout the canonical base lives on `upstream`. Naming the ref
    // is what turns a still-wrong resolution from silently wrong into
    // obviously wrong.
    renderBadge({ baseCompareRef: "upstream/main" });

    expect(document.body.textContent).toContain("200 behind upstream/main");
  });

  it("keeps the compact pill on the bare branch name", () => {
    renderBadge({ baseCompareRef: "upstream/main" });

    // The pill is scanned across a dozen cards; the disambiguation belongs in
    // the tooltip, not in the dense triage row.
    const pill = screen.getByTestId("upstream-sync-indicator");
    expect(pill.textContent).toContain("main");
    expect(pill.textContent).not.toContain("upstream/");
  });

  it("falls back to the branch name when no compare ref was resolved", () => {
    renderBadge({ baseCompareRef: null, baseBehindCount: 4 });

    expect(document.body.textContent).toContain("4 behind main");
  });

  it("names the compare ref on the ahead line too", () => {
    renderBadge({ baseBehindCount: 0, baseAheadCount: 6, baseCompareRef: "upstream/main" });

    expect(document.body.textContent).toContain("6 ahead of upstream/main");
  });

  it("does not name a specific remote in the unreachable-remote warning", () => {
    // The fetch that failed may not have been origin at all once a repo
    // refreshes more than one remote.
    renderBadge({ fetchNetworkFailed: true });

    const warning = screen.getByTestId("upstream-sync-network-warning");
    expect(warning.textContent).not.toContain("origin");
  });
});
