// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

import { Skeleton, SkeletonBone, SkeletonHint, SkeletonText } from "../Skeleton";

const BONE_TEST_ID = "bone";
const TEXT_TEST_ID = "text";

describe("Skeleton", () => {
  describe("ARIA contract", () => {
    it('uses role="status" on the wrapper', () => {
      render(
        <Skeleton>
          <SkeletonBone />
        </Skeleton>
      );
      expect(screen.getByRole("status")).toBeTruthy();
    });

    it('sets aria-live="polite" and aria-busy="true"', () => {
      render(<Skeleton />);
      const status = screen.getByRole("status");
      expect(status.getAttribute("aria-live")).toBe("polite");
      expect(status.getAttribute("aria-busy")).toBe("true");
    });

    it("uses default label when none provided", () => {
      render(<Skeleton />);
      const status = screen.getByRole("status");
      expect(status.getAttribute("aria-label")).toBe("Loading");
      expect(status.querySelector(".sr-only")?.textContent).toBe("Loading");
    });

    it("respects a custom label", () => {
      render(<Skeleton label="Loading commits" />);
      const status = screen.getByRole("status");
      expect(status.getAttribute("aria-label")).toBe("Loading commits");
      expect(status.querySelector(".sr-only")?.textContent).toBe("Loading commits");
    });

    it("hides each bone from assistive tech via aria-hidden", () => {
      render(
        <Skeleton>
          <SkeletonBone data-testid={BONE_TEST_ID} />
        </Skeleton>
      );
      expect(screen.getByTestId(BONE_TEST_ID).getAttribute("aria-hidden")).toBe("true");
    });

    it("is queryable by accessible name", () => {
      render(<Skeleton label="Loading commits" />);
      expect(screen.getByRole("status", { name: "Loading commits" })).toBeTruthy();
    });
  });

  describe("inert mode", () => {
    it("renders only an aria-hidden wrapper without status semantics", () => {
      render(
        <Skeleton inert data-testid="root">
          <SkeletonBone />
        </Skeleton>
      );
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getByTestId("root").getAttribute("aria-hidden")).toBe("true");
    });

    it("does not render the sr-only label when inert", () => {
      const { container } = render(<Skeleton inert label="Loading" />);
      expect(container.querySelector(".sr-only")).toBeNull();
    });
  });

  describe("className passthrough", () => {
    it("merges custom className on the wrapper", () => {
      render(<Skeleton className="my-skeleton" />);
      expect(screen.getByRole("status").className).toContain("my-skeleton");
    });
  });
});

describe("SkeletonBone", () => {
  it("is aria-hidden and carries the muted background", () => {
    render(<SkeletonBone data-testid={BONE_TEST_ID} />);
    const bone = screen.getByTestId(BONE_TEST_ID);
    expect(bone.getAttribute("aria-hidden")).toBe("true");
    expect(bone.className).toContain("bg-muted");
  });

  it("uses animate-pulse-delayed by default", () => {
    render(<SkeletonBone data-testid={BONE_TEST_ID} />);
    expect(screen.getByTestId(BONE_TEST_ID).className).toContain("animate-pulse-delayed");
  });

  it("switches to animate-pulse-immediate when immediate is set", () => {
    render(<SkeletonBone immediate data-testid={BONE_TEST_ID} />);
    const cls = screen.getByTestId(BONE_TEST_ID).className;
    expect(cls).toContain("animate-pulse-immediate");
    expect(cls).not.toContain("animate-pulse-delayed");
  });

  it("does not include shimmer class by default", () => {
    render(<SkeletonBone data-testid={BONE_TEST_ID} />);
    expect(screen.getByTestId(BONE_TEST_ID).className).not.toContain("animate-skeleton-shimmer");
  });

  it("adds animate-skeleton-shimmer when shimmer is set", () => {
    render(<SkeletonBone shimmer data-testid={BONE_TEST_ID} />);
    expect(screen.getByTestId(BONE_TEST_ID).className).toContain("animate-skeleton-shimmer");
  });

  it("applies a fixed pixel height when heightPx is provided", () => {
    render(<SkeletonBone heightPx={68} data-testid={BONE_TEST_ID} />);
    expect(screen.getByTestId(BONE_TEST_ID).style.height).toBe("68px");
  });

  it("heightPx wins over an explicit style.height", () => {
    render(<SkeletonBone heightPx={68} style={{ height: "40px" }} data-testid={BONE_TEST_ID} />);
    expect(screen.getByTestId(BONE_TEST_ID).style.height).toBe("68px");
  });

  it("ignores NaN heightPx", () => {
    render(<SkeletonBone heightPx={Number.NaN} data-testid={BONE_TEST_ID} />);
    expect(screen.getByTestId(BONE_TEST_ID).style.height).toBe("");
  });

  it("ignores negative heightPx", () => {
    render(<SkeletonBone heightPx={-20} data-testid={BONE_TEST_ID} />);
    expect(screen.getByTestId(BONE_TEST_ID).style.height).toBe("");
  });

  it("ignores Infinity heightPx", () => {
    render(<SkeletonBone heightPx={Number.POSITIVE_INFINITY} data-testid={BONE_TEST_ID} />);
    expect(screen.getByTestId(BONE_TEST_ID).style.height).toBe("");
  });

  it("forces aria-hidden true even if a caller passes aria-hidden={false}", () => {
    render(<SkeletonBone aria-hidden={false} data-testid={BONE_TEST_ID} />);
    expect(screen.getByTestId(BONE_TEST_ID).getAttribute("aria-hidden")).toBe("true");
  });

  it("merges custom className", () => {
    render(<SkeletonBone className="w-12 h-4" data-testid={BONE_TEST_ID} />);
    const cls = screen.getByTestId(BONE_TEST_ID).className;
    expect(cls).toContain("w-12");
    expect(cls).toContain("h-4");
  });
});

describe("SkeletonText", () => {
  it("renders 3 lines by default", () => {
    render(<SkeletonText data-testid={TEXT_TEST_ID} />);
    expect(screen.getByTestId(TEXT_TEST_ID).children.length).toBe(3);
  });

  it("renders the requested line count", () => {
    render(<SkeletonText lines={5} data-testid={TEXT_TEST_ID} />);
    expect(screen.getByTestId(TEXT_TEST_ID).children.length).toBe(5);
  });

  it("clamps negative line counts to 0", () => {
    render(<SkeletonText lines={-2} data-testid={TEXT_TEST_ID} />);
    expect(screen.getByTestId(TEXT_TEST_ID).children.length).toBe(0);
  });

  it("clamps non-finite line counts to 0", () => {
    render(<SkeletonText lines={Number.NaN} data-testid={TEXT_TEST_ID} />);
    expect(screen.getByTestId(TEXT_TEST_ID).children.length).toBe(0);
  });

  it("floors fractional line counts", () => {
    render(<SkeletonText lines={3.9} data-testid={TEXT_TEST_ID} />);
    expect(screen.getByTestId(TEXT_TEST_ID).children.length).toBe(3);
  });

  it("clamps absurdly large line counts to a sane ceiling", () => {
    render(<SkeletonText lines={1_000_000} data-testid={TEXT_TEST_ID} />);
    const rendered = screen.getByTestId(TEXT_TEST_ID).children.length;
    expect(rendered).toBeLessThanOrEqual(100);
    expect(rendered).toBeGreaterThan(0);
  });

  it("cycles widths through [w-full, w-3/4, w-1/2]", () => {
    render(<SkeletonText lines={4} data-testid={TEXT_TEST_ID} />);
    const lines = Array.from(screen.getByTestId(TEXT_TEST_ID).children);
    expect(lines[0]?.className).toContain("w-full");
    expect(lines[1]?.className).toContain("w-3/4");
    expect(lines[2]?.className).toContain("w-1/2");
    expect(lines[3]?.className).toContain("w-full");
  });

  it("is aria-hidden on the container", () => {
    render(<SkeletonText lines={1} data-testid={TEXT_TEST_ID} />);
    expect(screen.getByTestId(TEXT_TEST_ID).getAttribute("aria-hidden")).toBe("true");
  });

  it("uses animate-pulse-delayed by default on each line", () => {
    render(<SkeletonText lines={2} data-testid={TEXT_TEST_ID} />);
    for (const line of Array.from(screen.getByTestId(TEXT_TEST_ID).children)) {
      expect(line.className).toContain("animate-pulse-delayed");
    }
  });

  it("switches to animate-pulse-immediate when immediate is set", () => {
    render(<SkeletonText lines={2} immediate data-testid={TEXT_TEST_ID} />);
    for (const line of Array.from(screen.getByTestId(TEXT_TEST_ID).children)) {
      expect(line.className).toContain("animate-pulse-immediate");
    }
  });

  it("layers shimmer on each line when shimmer is set", () => {
    render(<SkeletonText lines={2} shimmer data-testid={TEXT_TEST_ID} />);
    for (const line of Array.from(screen.getByTestId(TEXT_TEST_ID).children)) {
      expect(line.className).toContain("animate-skeleton-shimmer");
    }
  });

  it("respects custom line height and gap classes", () => {
    render(
      <SkeletonText
        lines={2}
        lineHeightClassName="h-6"
        gapClassName="space-y-4"
        data-testid={TEXT_TEST_ID}
      />
    );
    const root = screen.getByTestId(TEXT_TEST_ID);
    expect(root.className).toContain("space-y-4");
    for (const line of Array.from(root.children)) {
      expect(line.className).toContain("h-6");
    }
  });

  it("does not use transition-all", () => {
    const { container } = render(<SkeletonText lines={3} />);
    expect(container.innerHTML).not.toContain("transition-all");
  });
});

describe("SkeletonHint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function advance(ms: number) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  it("renders nothing visible before the first threshold", () => {
    const { container } = render(<SkeletonHint />);
    expect(container.querySelector(".animate-hint-fade-in")).toBeNull();
    expect(screen.queryByText("Still working…")).toBeNull();
  });

  it("always renders an aria-live region so AT registers it up front", () => {
    const { container } = render(<SkeletonHint />);
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).toBeTruthy();
    expect(live?.getAttribute("aria-atomic")).toBe("true");
    expect(live?.classList.contains("sr-only")).toBe(true);
    expect(live?.textContent).toBe("");
  });

  it('shows "Still working…" at exactly 5000ms', () => {
    render(<SkeletonHint />);
    advance(4_999);
    expect(screen.queryByText("Still working…")).toBeNull();
    advance(1);
    expect(screen.getAllByText("Still working…").length).toBeGreaterThan(0);
  });

  it('escalates to "Taking longer than usual…" at 10000ms', () => {
    render(<SkeletonHint />);
    advance(10_000);
    expect(screen.getAllByText("Taking longer than usual…").length).toBeGreaterThan(0);
    expect(screen.queryByText("Still working…")).toBeNull();
  });

  it("updates the sr-only live region copy on phase change", () => {
    const { container } = render(<SkeletonHint />);
    const live = container.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe("");

    advance(5_000);
    expect(live.textContent).toBe("Still working…");

    advance(5_000);
    expect(live.textContent).toBe("Taking longer than usual…");
  });

  it("does not show action buttons at 15000ms when no handlers are passed", () => {
    render(<SkeletonHint />);
    advance(15_000);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("renders Cancel at 15000ms and fires the handler when clicked", () => {
    const onCancel = vi.fn();
    render(<SkeletonHint onCancel={onCancel} />);
    advance(15_000);
    const button = screen.getByRole("button", { name: "Cancel" });
    fireEvent.click(button);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders Retry at 15000ms and fires the handler when clicked", () => {
    const onRetry = vi.fn();
    render(<SkeletonHint onRetry={onRetry} />);
    advance(15_000);
    const button = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders both Cancel and Retry when both handlers are passed", () => {
    render(<SkeletonHint onCancel={() => {}} onRetry={() => {}} />);
    advance(15_000);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("does not show buttons before the action threshold even with handlers", () => {
    render(<SkeletonHint onCancel={() => {}} onRetry={() => {}} />);
    advance(10_000);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("clears all timers on unmount (no leaks)", () => {
    const { unmount } = render(<SkeletonHint />);
    advance(4_999);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("respects custom thresholds", () => {
    render(<SkeletonHint firstThreshold={1_000} secondThreshold={2_000} actionThreshold={3_000} />);
    advance(1_000);
    expect(screen.getAllByText("Still working…").length).toBeGreaterThan(0);
    advance(1_000);
    expect(screen.getAllByText("Taking longer than usual…").length).toBeGreaterThan(0);
  });

  it("falls back to defaults for non-finite or negative thresholds", () => {
    render(
      <SkeletonHint
        firstThreshold={Number.NaN}
        secondThreshold={-100}
        actionThreshold={Number.POSITIVE_INFINITY}
      />
    );
    advance(4_999);
    expect(screen.queryByText("Still working…")).toBeNull();
    advance(1);
    expect(screen.getAllByText("Still working…").length).toBeGreaterThan(0);
  });

  it("the hint root is not nested inside any role=status element", () => {
    const { container } = render(
      <div>
        <Skeleton>
          <SkeletonBone />
        </Skeleton>
        <SkeletonHint data-testid="hint" />
      </div>
    );
    const hint = container.querySelector('[data-testid="hint"]')!;
    expect(hint.closest('[role="status"]')).toBeNull();
  });

  it("re-keys the visible row on phase change so the fade-in re-fires", () => {
    const { container } = render(<SkeletonHint />);
    advance(5_000);
    const first = container.querySelector(".animate-hint-fade-in");
    expect(first).toBeTruthy();
    advance(5_000);
    const second = container.querySelector(".animate-hint-fade-in");
    expect(second).toBeTruthy();
    // React replaces the keyed node on phase change; the new element is a
    // different DOM reference, so the animation restarts.
    expect(second).not.toBe(first);
  });

  it("does not use transition-all", () => {
    const { container } = render(<SkeletonHint />);
    advance(5_000);
    expect(container.innerHTML).not.toContain("transition-all");
  });

  it("Cancel/Retry buttons use the ghost variant (no accent color)", () => {
    render(<SkeletonHint onCancel={() => {}} onRetry={() => {}} />);
    advance(15_000);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const retry = screen.getByRole("button", { name: "Retry" });
    // Ghost variant uses text-text-secondary, not text-accent-* / bg-primary
    for (const button of [cancel, retry]) {
      expect(button.className).toContain("text-text-secondary");
      expect(button.className).not.toContain("bg-primary");
      expect(button.className).not.toContain("text-accent");
    }
  });

  it("merges custom className on the wrapper", () => {
    const { container } = render(<SkeletonHint className="my-hint" data-testid="hint" />);
    const hint = container.querySelector('[data-testid="hint"]')!;
    expect(hint.className).toContain("my-hint");
  });
});

describe("animate-hint-fade-in CSS contract", () => {
  const css = readFileSync(resolve(__dirname, "../../../index.css"), "utf8");

  it("declares the hint-fade-in keyframe", () => {
    expect(css).toMatch(/@keyframes\s+hint-fade-in\b/);
  });

  it("declares the .animate-hint-fade-in utility class", () => {
    expect(css).toMatch(/\.animate-hint-fade-in\s*\{/);
  });

  it("disables the fade under prefers-reduced-motion", () => {
    const block = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/)?.[0];
    expect(block).toBeTruthy();
    expect(block).toMatch(/\.animate-hint-fade-in/);
  });

  it("disables the fade under body[data-reduce-animations]", () => {
    expect(css).toMatch(
      /body\[data-reduce-animations="true"\][\s\S]*?\.animate-hint-fade-in[\s\S]*?animation:\s*none/
    );
  });

  it("forces opacity 1 under body[data-performance-mode]", () => {
    expect(css).toMatch(
      /body\[data-performance-mode="true"\][\s\S]*?\.animate-hint-fade-in[\s\S]*?opacity:\s*1/
    );
  });
});

describe("animate-skeleton-shimmer CSS contract", () => {
  // Read the source CSS once. Build pipeline transforms (Tailwind, autoprefixer)
  // shouldn't matter — we're asserting authored intent in src/index.css.
  const css = readFileSync(resolve(__dirname, "../../../index.css"), "utf8");

  it("declares the skeleton-shimmer keyframe", () => {
    expect(css).toMatch(/@keyframes\s+skeleton-shimmer\b/);
  });

  it("declares the .animate-skeleton-shimmer utility class", () => {
    expect(css).toMatch(/\.animate-skeleton-shimmer\s*\{/);
  });

  it("hides the ::after sweep under prefers-reduced-motion", () => {
    const block = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/)?.[0];
    expect(block).toBeTruthy();
    expect(block).toMatch(/\.animate-skeleton-shimmer::after\s*\{[^}]*display:\s*none/);
  });

  it("hides the ::after sweep under body[data-reduce-animations]", () => {
    expect(css).toMatch(
      /body\[data-reduce-animations="true"\]\s+\.animate-skeleton-shimmer::after\s*\{[^}]*display:\s*none/
    );
  });

  it("hides the ::after sweep under body[data-performance-mode]", () => {
    expect(css).toMatch(
      /body\[data-performance-mode="true"\]\s+\.animate-skeleton-shimmer::after\s*\{[^}]*display:\s*none/
    );
  });
});
