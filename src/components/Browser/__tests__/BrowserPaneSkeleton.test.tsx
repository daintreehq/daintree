// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrowserPaneSkeleton } from "../BrowserPaneSkeleton";

describe("BrowserPaneSkeleton", () => {
  it("renders a polite status region that is never marked busy", () => {
    render(<BrowserPaneSkeleton />);
    const el = screen.getByRole("status");
    expect(el.getAttribute("aria-live")).toBe("polite");
    expect(el.closest('[aria-busy="true"]')).toBeNull();
    expect(el.getAttribute("aria-label")).toBe("Loading browser panel");
  });

  it("has sr-only loading text", () => {
    render(<BrowserPaneSkeleton />);
    expect(screen.getByText("Loading browser panel")).toBeTruthy();
  });

  it("accepts a custom label", () => {
    render(<BrowserPaneSkeleton label="Loading dev preview panel" />);
    const el = screen.getByRole("status");
    expect(el.getAttribute("aria-label")).toBe("Loading dev preview panel");
    expect(screen.getByText("Loading dev preview panel")).toBeTruthy();
  });

  it("pulses all placeholder shapes immediately — never the delayed gate (Suspense fallback)", () => {
    const { container } = render(<BrowserPaneSkeleton />);
    const pulsing = container.querySelectorAll(".animate-pulse-immediate");
    // header: icon + title + menu + close = 4, toolbar: 3 nav + url bar + 2 action = 6, total = 10
    expect(pulsing.length).toBe(10);
    expect(container.querySelectorAll(".animate-pulse-delayed").length).toBe(0);
  });

  it("does not animate the content area", () => {
    const { container } = render(<BrowserPaneSkeleton />);
    const contentArea = container.querySelector(".bg-surface-canvas");
    expect(contentArea).toBeTruthy();
    expect(contentArea!.className).not.toContain("animate-pulse");
  });

  it("hides every bone from assistive tech", () => {
    const { container } = render(<BrowserPaneSkeleton />);
    const bones = container.querySelectorAll("[data-skeleton-bone]");
    expect(bones.length).toBeGreaterThan(0);
    for (const bone of bones) expect(bone.closest("[aria-hidden='true']")).toBeTruthy();
  });

  it("paints every bone with the shared primitive, never a surface-coloured fill", () => {
    // Hand-rolled `bg-muted` bones sat on `bg-surface`, and both resolve to
    // `--theme-surface-panel`: the whole silhouette was invisible in every theme.
    const { container } = render(<BrowserPaneSkeleton />);
    const pulsing = container.querySelectorAll(".animate-pulse-immediate");
    expect(pulsing.length).toBeGreaterThan(0);
    for (const el of pulsing) {
      expect(el.hasAttribute("data-skeleton-bone")).toBe(true);
      expect(el.className).not.toMatch(/\bbg-muted\b/);
    }
  });

  it("draws only the panel header for panes that have no browser toolbar", () => {
    const { container: withToolbar } = render(<BrowserPaneSkeleton />);
    const { container: headerOnly } = render(
      <BrowserPaneSkeleton label="Loading file panel" toolbar={false} />
    );
    const count = (c: HTMLElement) => c.querySelectorAll("[data-skeleton-bone]").length;
    expect(count(headerOnly)).toBeGreaterThan(0);
    expect(count(headerOnly)).toBeLessThan(count(withToolbar));
  });

  it("includes a SkeletonHint sibling outside the role=status element", () => {
    const { container } = render(<BrowserPaneSkeleton />);
    // SkeletonHint always renders an aria-live="polite" sr-only region; that
    // region must NOT live inside the role="status" subtree, otherwise
    // aria-busy="true" will silence the escalating copy on modern AT.
    const live = container.querySelector('span.sr-only[aria-live="polite"]');
    expect(live).toBeTruthy();
    expect(live!.closest('[role="status"]')).toBeNull();
  });
});
