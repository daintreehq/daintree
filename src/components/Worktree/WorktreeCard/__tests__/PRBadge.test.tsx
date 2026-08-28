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

let mockMissingCredential = false;
let mockFreshnessCause: "rate-limit" | "circuit-breaker" | undefined = undefined;

vi.mock("@/hooks/useForgeTooltip", () => ({
  usePRTooltip: () => ({
    data: null,
    loading: false,
    error: null,
    missingCredential: mockMissingCredential,
    providerId: "daintree.github.github",
    fetchTooltip: vi.fn(),
    reset: vi.fn(),
  }),
}));

vi.mock("../hooks/useForgeBadgeTooltip", () => ({
  useForgeBadgeTooltip: () => ({
    isOpen: true,
    handleOpenChange: vi.fn(),
    handleClick: vi.fn(),
  }),
}));

vi.mock("../hooks/useForgeBadgeFreshness", () => ({
  useForgeBadgeFreshness: () => ({
    freshnessLevel: mockFreshnessCause ? "aging" : "fresh",
    freshnessCause: mockFreshnessCause,
    rateLimitResetAt: null,
    now: Date.now(),
  }),
}));

import { PRBadge } from "../PRBadge";
import type { CIStatus, CIStatusState } from "@shared/types/forge";

const ciStatus = (state: CIStatusState): CIStatus => ({
  state,
  total: 1,
  passed: state === "success" ? 1 : 0,
  failed: state === "failure" ? 1 : 0,
  pending: state === "pending" ? 1 : 0,
  rawData: null,
});

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
    mockMissingCredential = false;
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

  it("suppresses the paused signal when the forge credential is missing", () => {
    mockMissingCredential = true;
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
    expect(button.getAttribute("aria-label")).toContain("forge rate limited");
    expect(button.getAttribute("aria-label")).not.toContain("PR detection paused");
  });

  it("uses circuit-breaker aria label when prDetectionPaused is true", () => {
    renderBadge({ prDetectionPaused: true });

    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-label")).toContain("PR detection paused");
  });
});

describe("PRBadge CI rollup mark", () => {
  beforeEach(() => {
    mockMissingCredential = false;
    mockFreshnessCause = undefined;
  });

  it("marks a run still in flight with a dot, not a glyph", () => {
    renderBadge({ prCiStatus: ciStatus("pending") });

    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-label")).toContain("CI pending");
    // No stroked glyph — the dot is the whole mark, as it is on GitHub.
    expect(button.querySelector(".lucide-clock")).toBeNull();
    const dot = button.querySelector(".status-mark");
    expect(dot).toBeTruthy();
    // Painted as a background, which forced colors strips; `.status-mark` is
    // what src/index.css repaints, so the class is the mark's survival.
    expect(dot?.className).toContain("bg-status-warning");
  });

  it("marks a settled run with a glyph that carries its own shape", () => {
    renderBadge({ prCiStatus: ciStatus("success") });

    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-label")).toContain("CI passing");
    expect(button.querySelector(".lucide-check")).toBeTruthy();
    expect(button.querySelector(".status-mark")).toBeNull();
  });
});
