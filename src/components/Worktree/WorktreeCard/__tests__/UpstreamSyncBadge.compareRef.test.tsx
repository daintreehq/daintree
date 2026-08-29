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

describe("UpstreamSyncBadge — a branch tracking its own base", () => {
  /**
   * `git worktree add -b topic --track origin/develop` leaves `@{u}` pointing
   * at the base, so `git status` and the base-divergence pass measure the same
   * distance. Both pairs then carry the same number and only one of them says
   * what it is counted against.
   */
  const mistracked: Partial<Props> = {
    aheadCount: 0,
    behindCount: 4,
    baseBranchName: "develop",
    baseAheadCount: 0,
    baseBehindCount: 4,
    baseMatchesUpstream: true,
    baseCompareRef: "origin/develop",
  };

  it("shows the count once, and shows it labelled", () => {
    renderBadge(mistracked);

    const pill = screen.getByTestId("upstream-sync-indicator");
    expect(pill.textContent).toContain("Δ develop");
    expect(pill.textContent?.match(/↓4/g)).toHaveLength(1);
  });

  it("renders identically whether or not the branch happens to track its base", () => {
    // The bug this fixes: two worktrees on the same commit off the same base
    // read as different measurements purely on how their tracking config was
    // written.
    renderBadge(mistracked);
    const tracked = screen.getByTestId("upstream-sync-indicator").textContent;
    cleanup();

    renderBadge({
      ...mistracked,
      aheadCount: undefined,
      behindCount: undefined,
      baseMatchesUpstream: false,
    });
    const untracked = screen.getByTestId("upstream-sync-indicator").textContent;

    expect(tracked).toBe(untracked);
  });

  it("keeps the unlabelled pair when the base counts have not caught up", () => {
    // Inter-pass race: base divergence reports zero while upstream already
    // sees drift. Suppressing the only non-zero pair would render nothing.
    renderBadge({
      ...mistracked,
      baseAheadCount: 0,
      baseBehindCount: 0,
    });

    const pill = screen.getByTestId("upstream-sync-indicator");
    expect(pill.textContent).toContain("↓4");
    expect(pill.textContent).not.toContain("Δ");
  });

  it("names the compare ref in the tooltip while the pill stays on the branch", () => {
    renderBadge(mistracked);

    expect(screen.getByTestId("upstream-sync-indicator").textContent).not.toContain("origin/");
    expect(document.body.textContent).toContain("4 behind origin/develop");
  });

  it("drops the upstream tooltip line rather than leaving a bare 'upstream'", () => {
    renderBadge(mistracked);

    // The line is built as counts followed by the word; with the counts gone
    // the word must go too, not survive on its own. `origin/develop` in the
    // base line is the only occurrence the tooltip should have left.
    const occurrences = document.body.textContent?.match(/upstream/g) ?? [];
    expect(occurrences).toHaveLength(0);
  });

  it("still renders both pairs when they measure different things", () => {
    // Pushed branch, 2 ahead of its own remote, 4 behind the base: two real
    // numbers, and neither is redundant.
    renderBadge({
      aheadCount: 2,
      behindCount: 0,
      baseBranchName: "develop",
      baseAheadCount: 0,
      baseBehindCount: 4,
      baseMatchesUpstream: false,
    });

    const pill = screen.getByTestId("upstream-sync-indicator");
    expect(pill.textContent).toContain("↑2");
    expect(pill.textContent).toContain("Δ develop");
    expect(pill.textContent).toContain("↓4");
  });

  it("labels the counts on the auth-failed pill too", () => {
    renderBadge({
      ...mistracked,
      fetchAuthFailed: true,
      hasAuthFailedSignIn: true,
    });

    const pill = screen.getByTestId("upstream-sync-indicator");
    expect(pill.textContent).toContain("Δ develop");
    expect(pill.textContent?.match(/↓4/g)).toHaveLength(1);
  });
});

describe("UpstreamSyncBadge — the auth-failed tooltip (#12074)", () => {
  it("names the compare ref, so a base name the pill had to ellipsize is still readable", () => {
    // The normal tooltip has always named the ref; the auth-failed one carried
    // only recovery copy. Once the pill can truncate the name, that is the one
    // state with nowhere left to read it in full.
    renderBadge({
      baseBranchName: "release/2026-08-long-lived-integration-branch",
      baseCompareRef: "upstream/release/2026-08-long-lived-integration-branch",
      fetchAuthFailed: true,
      hasAuthFailedSignIn: true,
    });

    expect(document.body.textContent).toContain(
      "Compared with upstream/release/2026-08-long-lived-integration-branch"
    );

    // Still bare in the dense row itself, same as the normal variant.
    const pill = screen.getByTestId("upstream-sync-indicator");
    expect(pill.textContent).not.toContain("upstream/");
  });

  it("says nothing about a base it has no name for", () => {
    renderBadge({
      baseBranchName: null,
      baseAheadCount: null,
      baseBehindCount: null,
      baseCompareRef: null,
      fetchAuthFailed: true,
      hasAuthFailedSignIn: true,
    });

    expect(document.body.textContent).not.toContain("Compared with");
  });
});
