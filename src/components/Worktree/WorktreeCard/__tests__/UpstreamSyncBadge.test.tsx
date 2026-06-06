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
    });
    const button = screen.getByRole("button", { name: /GitHub authentication failed/ });
    expect(button.getAttribute("data-fetch-auth-failed")).toBe("true");
    expect(button.textContent).toContain("—");
    fireEvent.click(button);
    expect(mockRetryAuthFetch).toHaveBeenCalledTimes(1);
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "code-forge", subtab: "daintree.github.github", sectionId: "github-token" },
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
