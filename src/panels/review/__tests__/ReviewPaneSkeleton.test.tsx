// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReviewPaneSkeleton } from "../ReviewPaneSkeleton";

describe("ReviewPaneSkeleton", () => {
  it("renders with role=status and aria-busy", () => {
    render(<ReviewPaneSkeleton />);
    const el = screen.getByRole("status");
    expect(el).toBeTruthy();
    expect(el.getAttribute("aria-busy")).toBe("true");
    expect(el.getAttribute("aria-label")).toBe("Loading review panel");
  });

  it("has sr-only loading text", () => {
    render(<ReviewPaneSkeleton />);
    expect(screen.getByText("Loading review panel")).toBeTruthy();
  });

  it("mirrors review chrome (section rows), not the browser toolbar", () => {
    const { container } = render(<ReviewPaneSkeleton />);
    // Review's real chrome has staged/unstaged section headers on
    // bg-overlay-subtle; the browser toolbar silhouette uses bg-surface +
    // border-overlay and a flex-1 URL pill.
    expect(container.querySelectorAll(".bg-overlay-subtle").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".border-overlay")).toBeNull();
    expect(container.querySelector(".animate-pulse-immediate.flex-1")).toBeNull();
  });

  it("pulses immediately — never the delayed gate (Suspense fallback)", () => {
    const { container } = render(<ReviewPaneSkeleton />);
    expect(container.querySelectorAll(".animate-pulse-delayed").length).toBe(0);
    expect(container.querySelectorAll(".animate-pulse-immediate").length).toBeGreaterThan(0);
  });

  it("includes a SkeletonHint sibling outside the role=status element", () => {
    const { container } = render(<ReviewPaneSkeleton />);
    const live = container.querySelector('[aria-live="polite"]:not([role="status"])');
    expect(live).toBeTruthy();
    expect(live!.closest('[role="status"]')).toBeNull();
  });
});
