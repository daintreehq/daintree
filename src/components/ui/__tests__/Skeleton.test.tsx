// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

import { Skeleton, SkeletonBone, SkeletonText } from "../Skeleton";

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
