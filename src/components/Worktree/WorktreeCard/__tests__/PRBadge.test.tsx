/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

let mockMissingToken = false;
let mockFreshnessCause: "rate-limit" | "circuit-breaker" | undefined = undefined;

vi.mock("@/hooks/useGitHubTooltip", () => ({
  usePRTooltip: () => ({
    data: null,
    loading: false,
    error: null,
    missingToken: mockMissingToken,
    fetchTooltip: vi.fn(),
    reset: vi.fn(),
  }),
}));

vi.mock("../hooks/useGitHubBadgeTooltip", () => ({
  useGitHubBadgeTooltip: () => ({
    isOpen: true,
    handleOpenChange: vi.fn(),
    handleClick: vi.fn(),
  }),
}));

vi.mock("../hooks/useGitHubBadgeFreshness", () => ({
  useGitHubBadgeFreshness: () => ({
    freshnessLevel: mockFreshnessCause ? "aging" : "fresh",
    freshnessCause: mockFreshnessCause,
    rateLimitResetAt: null,
    now: Date.now(),
  }),
}));

import { PRBadge } from "../PRBadge";

function renderBadge(extra: Partial<Parameters<typeof PRBadge>[0]> = {}) {
  return render(
    <TooltipProvider>
      <PRBadge
        prNumber={42}
        prState="open"
        isSubordinate={false}
        worktreePath="/repo"
        isActive
        {...extra}
      />
    </TooltipProvider>
  );
}

describe("PRBadge freshness glyphs", () => {
  beforeEach(() => {
    mockMissingToken = false;
    mockFreshnessCause = undefined;
  });

  it("shows the CloudOff glyph when prDetectionPaused is true", () => {
    const { container } = renderBadge({ prDetectionPaused: true });

    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-label")).toContain("PR detection paused");
    expect(button.querySelector(".lucide-cloud-off")).toBeTruthy();
    expect(container).toBeTruthy();
  });

  it("does not show the CloudOff glyph when prDetectionPaused is false", () => {
    renderBadge({ prDetectionPaused: false });

    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-label")).not.toContain("PR detection paused");
    expect(button.querySelector(".lucide-cloud-off")).toBeNull();
  });

  it("does not show the CloudOff glyph when prDetectionPaused is undefined", () => {
    renderBadge();

    const button = screen.getByRole("button");
    expect(button.querySelector(".lucide-cloud-off")).toBeNull();
  });

  it("keeps the badge button at full opacity (no dimming classes)", () => {
    renderBadge({ prDetectionPaused: true });

    const button = screen.getByRole("button");
    expect(button.className).not.toMatch(/opacity-/);
  });

  it("suppresses the paused signal when the GitHub token is missing", () => {
    mockMissingToken = true;
    renderBadge({ prDetectionPaused: true });

    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-label")).not.toContain("PR detection paused");
    expect(button.querySelector(".lucide-cloud-off")).toBeNull();
  });

  it("never shows a Clock glyph on the badge button — plain age is no longer surfaced", () => {
    for (const cause of [undefined, "rate-limit", "circuit-breaker"] as const) {
      mockFreshnessCause = cause;
      const { unmount } = renderBadge();
      const button = screen.getByRole("button");
      expect(button.querySelector(".lucide-clock")).toBeNull();
      unmount();
    }
  });

  it("surfaces the rate-limit freshness as a Clock-iconed tooltip line", () => {
    mockFreshnessCause = "rate-limit";
    renderBadge();

    expect(document.querySelector(".lucide-clock")).toBeTruthy();
    expect(screen.getAllByText(/rate limited/).length).toBeGreaterThan(0);
  });

  it("surfaces the circuit-breaker freshness with a PauseCircle, not a Clock", () => {
    mockFreshnessCause = "circuit-breaker";
    renderBadge();

    expect(document.querySelector(".lucide-circle-pause")).toBeTruthy();
    expect(document.querySelector(".lucide-clock")).toBeNull();
  });

  it("shows CloudOff when freshnessCause is rate-limit", () => {
    mockFreshnessCause = "rate-limit";
    renderBadge();

    const button = screen.getByRole("button");
    expect(button.querySelector(".lucide-cloud-off")).toBeTruthy();
  });

  it("shows CloudOff when freshnessCause is circuit-breaker", () => {
    mockFreshnessCause = "circuit-breaker";
    renderBadge();

    const button = screen.getByRole("button");
    expect(button.querySelector(".lucide-cloud-off")).toBeTruthy();
  });

  it("shows circuit-breaker tooltip suffix text when freshnessCause is circuit-breaker", () => {
    mockFreshnessCause = "circuit-breaker";
    renderBadge();

    expect(screen.getAllByText(/data may be stale/).length).toBeGreaterThan(0);
  });

  it("uses rate-limit aria label when freshnessCause is rate-limit", () => {
    mockFreshnessCause = "rate-limit";
    renderBadge();

    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-label")).toContain("GitHub rate limited");
    expect(button.getAttribute("aria-label")).not.toContain("PR detection paused");
  });

  it("uses circuit-breaker aria label when prDetectionPaused is true", () => {
    renderBadge({ prDetectionPaused: true });

    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-label")).toContain("PR detection paused");
  });
});
