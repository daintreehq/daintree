/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

vi.mock("@/lib/formatRelativeTime", () => ({
  formatRelativeTime: () => "just now",
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

import { actionService } from "@/services/ActionService";
import { UpstreamSyncBadge } from "../UpstreamSyncBadge";

const mockRetryAuthFetch = vi.fn().mockResolvedValue(undefined);

type Props = Parameters<typeof UpstreamSyncBadge>[0];

const baseProps: Props = {
  aheadCount: 2,
  behindCount: 0,
  isFetchInFlight: false,
  lastFetchedAt: Date.now(),
  fetchAuthFailed: false,
  fetchNetworkFailed: false,
  hasAuthFailedSignIn: false,
  containerGapClass: "gap-1.5",
  baseBranchName: null,
  baseAheadCount: null,
  baseBehindCount: null,
  baseMatchesUpstream: true,
};

function renderBadge(extra: Partial<Props> = {}) {
  return render(
    <TooltipProvider>
      <UpstreamSyncBadge {...baseProps} {...extra} />
    </TooltipProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("UpstreamSyncBadge — auth-failed sign-in branch (issue #9982)", () => {
  beforeEach(() => {
    vi.stubGlobal("electron", { worktree: { retryAuthFetch: mockRetryAuthFetch } });
    mockRetryAuthFetch.mockClear();
    vi.mocked(actionService.dispatch).mockClear();
  });

  it("renders a real <button> with the auth-failed aria-label and clicking it fires retry + dispatch", () => {
    renderBadge({
      aheadCount: 0,
      behindCount: 0,
      fetchAuthFailed: true,
      hasAuthFailedSignIn: true,
      authProviderId: "daintree.github.github",
    });
    const button = screen.getByRole("button", { name: /Forge authentication failed/ });
    expect(button.getAttribute("data-fetch-auth-failed")).toBe("true");
    expect(button.textContent).toContain("—");
    fireEvent.click(button);
    expect(mockRetryAuthFetch).toHaveBeenCalledTimes(1);
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "code-forge", subtab: "daintree.github.github" },
      { source: "user" }
    );
  });

  it("does not render the sign-in branch when hasAuthFailedSignIn is false even with auth-failed fetch", () => {
    renderBadge({
      aheadCount: 0,
      behindCount: 0,
      fetchAuthFailed: true,
      hasAuthFailedSignIn: false,
    });
    // No counts + no auth-failed-sign-in affordance + no base divergence → null
    expect(screen.queryByTestId("upstream-sync-indicator")).toBeNull();
  });
});

describe("UpstreamSyncBadge — base-divergence layout", () => {
  it("renders base-divergence arrows as separate flex children so the parent gap applies", () => {
    renderBadge({
      aheadCount: 0,
      behindCount: 0,
      baseBranchName: "develop",
      baseAheadCount: 2,
      baseBehindCount: 1,
      baseMatchesUpstream: false,
    });

    const indicator = screen.getByTestId("upstream-sync-indicator");
    const childSpans = Array.from(indicator.children) as HTMLElement[];

    const aheadSpan = childSpans.find((el) => el.textContent === "↑2");
    const behindSpan = childSpans.find((el) => el.textContent === "↓1");

    expect(aheadSpan).toBeDefined();
    expect(behindSpan).toBeDefined();
    expect(aheadSpan).not.toBe(behindSpan);

    // Counts must not be merged into a single text run.
    const mergedSpan = childSpans.find((el) => /↑2\s*↓1/.test(el.textContent ?? ""));
    expect(mergedSpan).toBeUndefined();
  });

  it("uses the upstream colour palette for base-divergence arrows", () => {
    renderBadge({
      aheadCount: 0,
      behindCount: 0,
      baseBranchName: "develop",
      baseAheadCount: 2,
      baseBehindCount: 1,
      baseMatchesUpstream: false,
    });

    const indicator = screen.getByTestId("upstream-sync-indicator");
    const childSpans = Array.from(indicator.children) as HTMLElement[];
    const aheadSpan = childSpans.find((el) => el.textContent === "↑2");
    const behindSpan = childSpans.find((el) => el.textContent === "↓1");

    expect(aheadSpan?.className).toContain("text-status-success");
    expect(behindSpan?.className).toContain("text-status-warning");
  });
});

describe("UpstreamSyncBadge — value-change flash", () => {
  it("does not flash on initial render", () => {
    renderBadge();
    const indicator = screen.getByTestId("upstream-sync-indicator");
    expect(indicator.className).not.toContain("animate-upstream-badge-flash");
  });

  it("does not apply the legacy pulse class for in-flight fetches", () => {
    renderBadge({ isFetchInFlight: true });
    const indicator = screen.getByTestId("upstream-sync-indicator");
    expect(indicator.className).not.toContain("animate-pulse-immediate");
  });

  it("does not flash across repeated polls with stable counts (issue #8872 regression)", () => {
    // Simulates the polling loop: lastFetchedAt advances each tick but the
    // counts are unchanged. The badge must stay still — that was the bug.
    const { rerender } = renderBadge({ aheadCount: 2, behindCount: 1, lastFetchedAt: 1000 });
    for (const t of [2000, 3000, 4000, 5000]) {
      rerender(
        <TooltipProvider>
          <UpstreamSyncBadge
            {...baseProps}
            aheadCount={2}
            behindCount={1}
            lastFetchedAt={t}
            isFetchInFlight={t % 2000 === 0}
          />
        </TooltipProvider>
      );
    }
    const indicator = screen.getByTestId("upstream-sync-indicator");
    expect(indicator.className).not.toContain("animate-upstream-badge-flash");
    expect(indicator.className).not.toContain("animate-pulse-immediate");
  });

  it("does not flash when hidden base counts churn between null and 0", () => {
    // baseMatchesUpstream=true hides base counts entirely. Backend transitions
    // null→0 on base counts must not cause a phantom flash on the visible badge.
    const { rerender } = renderBadge({
      aheadCount: 2,
      behindCount: 0,
      baseAheadCount: null,
      baseBehindCount: null,
      baseMatchesUpstream: true,
    });
    rerender(
      <TooltipProvider>
        <UpstreamSyncBadge
          {...baseProps}
          aheadCount={2}
          behindCount={0}
          baseAheadCount={0}
          baseBehindCount={0}
          baseMatchesUpstream={true}
        />
      </TooltipProvider>
    );
    const indicator = screen.getByTestId("upstream-sync-indicator");
    expect(indicator.className).not.toContain("animate-upstream-badge-flash");
  });

  it("does not flash when fetch is in-flight without count change", () => {
    const { rerender } = renderBadge({ isFetchInFlight: false });
    rerender(
      <TooltipProvider>
        <UpstreamSyncBadge {...baseProps} isFetchInFlight={true} />
      </TooltipProvider>
    );
    const indicator = screen.getByTestId("upstream-sync-indicator");
    expect(indicator.className).not.toContain("animate-upstream-badge-flash");
  });

  it("flashes when ahead count changes between renders", () => {
    const { rerender } = renderBadge({ aheadCount: 2 });
    rerender(
      <TooltipProvider>
        <UpstreamSyncBadge {...baseProps} aheadCount={3} />
      </TooltipProvider>
    );
    const indicator = screen.getByTestId("upstream-sync-indicator");
    expect(indicator.className).toContain("animate-upstream-badge-flash");
  });

  it("flashes when behind count changes between renders", () => {
    const { rerender } = renderBadge({ behindCount: 0 });
    rerender(
      <TooltipProvider>
        <UpstreamSyncBadge {...baseProps} behindCount={1} />
      </TooltipProvider>
    );
    const indicator = screen.getByTestId("upstream-sync-indicator");
    expect(indicator.className).toContain("animate-upstream-badge-flash");
  });

  it("flashes when base divergence counts change between renders", () => {
    const { rerender } = renderBadge({
      baseBranchName: "develop",
      baseAheadCount: 1,
      baseBehindCount: 0,
      baseMatchesUpstream: false,
    });
    rerender(
      <TooltipProvider>
        <UpstreamSyncBadge
          {...baseProps}
          baseBranchName="develop"
          baseAheadCount={2}
          baseBehindCount={0}
          baseMatchesUpstream={false}
        />
      </TooltipProvider>
    );
    const indicator = screen.getByTestId("upstream-sync-indicator");
    expect(indicator.className).toContain("animate-upstream-badge-flash");
  });

  it("clears the flash class via the 250ms safety timer when animationend never fires", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = renderBadge({ aheadCount: 2 });
      rerender(
        <TooltipProvider>
          <UpstreamSyncBadge {...baseProps} aheadCount={3} />
        </TooltipProvider>
      );
      const indicator = screen.getByTestId("upstream-sync-indicator");
      expect(indicator.className).toContain("animate-upstream-badge-flash");

      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(indicator.className).not.toContain("animate-upstream-badge-flash");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("UpstreamSyncBadge — resting base relationship", () => {
  const restingProps = {
    aheadCount: undefined,
    behindCount: undefined,
    baseBranchName: "develop",
    baseAheadCount: 0,
    baseBehindCount: 0,
    baseMatchesUpstream: false,
  } as const;

  it("names the base branch when the counts are zero, where it used to render nothing at all", () => {
    renderBadge(restingProps);
    const base = screen.getByTestId("upstream-sync-base");
    expect(base.textContent).toContain("develop");
    expect(base.textContent).toContain("≡");
    expect(base.textContent).not.toContain("Δ");
  });

  it("swaps the resting glyph for the drift one and adds the counts once the branch diverges", () => {
    const { rerender } = renderBadge(restingProps);
    expect(screen.getByTestId("upstream-sync-indicator").textContent).not.toContain("↑");

    rerender(
      <TooltipProvider>
        <UpstreamSyncBadge {...baseProps} {...restingProps} baseAheadCount={3} />
      </TooltipProvider>
    );
    const base = screen.getByTestId("upstream-sync-base");
    expect(base.textContent).toContain("Δ");
    expect(base.textContent).not.toContain("≡");
    expect(screen.getByTestId("upstream-sync-indicator").textContent).toContain("↑3");
  });

  it("returns to the resting form instead of unmounting when the drift is merged away", () => {
    const { rerender } = renderBadge({ ...restingProps, baseBehindCount: 12 });
    expect(screen.getByTestId("upstream-sync-indicator").textContent).toContain("↓12");

    rerender(
      <TooltipProvider>
        <UpstreamSyncBadge {...baseProps} {...restingProps} />
      </TooltipProvider>
    );
    const base = screen.getByTestId("upstream-sync-base");
    expect(base.textContent).toContain("≡");
    expect(screen.getByTestId("upstream-sync-indicator").textContent).not.toContain("↓");
  });

  it("does not claim equality when the base counts were never measured", () => {
    renderBadge({ ...restingProps, baseAheadCount: null, baseBehindCount: null });
    expect(screen.queryByTestId("upstream-sync-indicator")).toBeNull();
  });

  it("stands the equality claim down rather than contradicting the same measurement", () => {
    // baseMatchesUpstream says the two refs are one commit, so ↓3 beside
    // ≡ develop would have the halves disagreeing about a single number.
    renderBadge({
      ...restingProps,
      aheadCount: 0,
      behindCount: 3,
      baseMatchesUpstream: true,
    });
    const line = screen.getByTestId("upstream-sync-indicator").textContent ?? "";
    expect(line).toContain("↓3");
    expect(line).not.toContain("≡");
  });

  it("keeps the resting form beside upstream drift when the two refs really differ", () => {
    renderBadge({ ...restingProps, aheadCount: 3, behindCount: 0, baseMatchesUpstream: false });
    const line = screen.getByTestId("upstream-sync-indicator").textContent ?? "";
    expect(line).toContain("↑3");
    expect(line).toContain("≡ develop");
  });

  it("marks a branch with no upstream and drops the marker once it has one", () => {
    const { rerender } = renderBadge({ ...restingProps, hasNoUpstream: true });
    expect(screen.getByTestId("upstream-sync-unpushed").textContent).toBe("· local");

    rerender(
      <TooltipProvider>
        <UpstreamSyncBadge
          {...baseProps}
          {...restingProps}
          aheadCount={0}
          behindCount={0}
          hasNoUpstream={false}
        />
      </TooltipProvider>
    );
    expect(screen.queryByTestId("upstream-sync-unpushed")).toBeNull();
    expect(screen.getByTestId("upstream-sync-base").textContent).toContain("develop");
  });

  it("keeps the marker on a branch that has drifted from its base as well as its remote", () => {
    renderBadge({ ...restingProps, baseAheadCount: 3, hasNoUpstream: true });
    expect(screen.getByTestId("upstream-sync-base").textContent).toContain("Δ");
    expect(screen.queryByTestId("upstream-sync-unpushed")).not.toBeNull();
  });

  it("renders nothing when there is no base branch and no upstream delta", () => {
    renderBadge({ aheadCount: 0, behindCount: 0, hasNoUpstream: true });
    expect(screen.queryByTestId("upstream-sync-indicator")).toBeNull();
  });

  it("gives the auth-failed variant the same relationship line rather than the em-dash", () => {
    vi.stubGlobal("electron", { worktree: { retryAuthFetch: vi.fn() } });
    renderBadge({
      ...restingProps,
      aheadCount: 0,
      behindCount: 0,
      fetchAuthFailed: true,
      hasAuthFailedSignIn: true,
      hasNoUpstream: true,
    });
    const button = screen.getByRole("button", { name: /Forge authentication failed/ });
    expect(button.textContent).toContain("develop");
    expect(button.textContent).not.toContain("—");
    expect(screen.queryByTestId("upstream-sync-unpushed")).not.toBeNull();
  });
});

describe("UpstreamSyncBadge — a base branch longer than the card (#12074)", () => {
  const longBase = "feature/stacked-worktree-base-branch-name-that-keeps-going";

  // Distinct numbers per pair: identical ones would let a whole pair go
  // missing without any assertion noticing.
  const crowded: Partial<Props> = {
    aheadCount: 12,
    behindCount: 3,
    baseBranchName: longBase,
    baseMatchesUpstream: false,
    hasNoUpstream: true,
  };

  /**
   * jsdom computes no widths, so the ellipsis itself is not observable. What is
   * observable is the layout priority the fix installs: of the tokens the row
   * happens to hold, exactly one may give up width, it is the base label, and
   * it is the same element that clips. Read off the rendered row rather than
   * hardcoded per variant, so it holds for both and for tokens added later.
   *
   * It is still spelled in Tailwind's utilities, so an equivalent restyle would
   * have to update it — the trade for having any coverage at all here, since
   * mocking layout would only test the mock.
   */
  function assertOnlyTheNameYields(glyph: string, tokens: string[]) {
    const label = screen.getByTestId("upstream-sync-base");
    const row = label.parentElement!;
    const children = Array.from(row.children);
    expect(children.length).toBe(tokens.length + 1);

    const shrinkable = children.filter((el) => !el.classList.contains("shrink-0"));
    expect(shrinkable).toHaveLength(1);
    expect(shrinkable[0]).toBe(label);

    const clipping = children.filter((el) => el.classList.contains("truncate"));
    expect(clipping).toHaveLength(1);
    expect(clipping[0]).toBe(label);

    // The row itself has to be able to give up width, or the label inside it
    // never gets narrow enough to yield. In the auth-failed variant the row is
    // a flex item of the button above it and needs its own floor removed; in
    // the normal variant the row is the badge root, stretched across the card,
    // and there is nothing in between.
    const root = screen.getByTestId("upstream-sync-indicator");
    for (let el = row; el !== root; el = el.parentElement!) {
      expect(el.classList.contains("min-w-0")).toBe(true);
    }

    // The counts and the marker are the state the line exists to carry, so
    // they are what has to survive beside the name that yielded.
    const rendered = children.filter((el) => el !== label).map((el) => el.textContent);
    expect(rendered).toEqual(tokens);

    // Nothing caps the name on the way in — this is presentation-only, so the
    // full ref stays in the DOM for the tooltip to reveal.
    expect(label.textContent).toBe(`${glyph} ${longBase}`);
  }

  it("yields the name and keeps every count on the normal badge", () => {
    renderBadge({ ...crowded, baseAheadCount: 7, baseBehindCount: 5 });
    assertOnlyTheNameYields("Δ", ["↑12", "↓3", "↑7", "↓5", "· local"]);
  });

  it("yields the name and keeps every count on the auth-failed badge too", () => {
    renderBadge({
      ...crowded,
      baseAheadCount: 7,
      baseBehindCount: 5,
      fetchAuthFailed: true,
      hasAuthFailedSignIn: true,
    });
    assertOnlyTheNameYields("Δ", ["↑12", "↓3", "↑7", "↓5", "· local"]);
  });

  it("yields a long name on the resting line too, where there are no base counts", () => {
    renderBadge({ ...crowded, baseAheadCount: 0, baseBehindCount: 0 });
    assertOnlyTheNameYields("≡", ["↑12", "↓3", "· local"]);
  });
});
