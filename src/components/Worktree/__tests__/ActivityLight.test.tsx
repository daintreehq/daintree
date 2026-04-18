/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ActivityLight } from "../ActivityLight";
import { DECAY_DURATION } from "@/utils/colorInterpolation";

vi.mock("@/hooks/useGlobalSecondTicker", () => ({
  useGlobalSecondTicker: () => 0,
}));

describe("ActivityLight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function getDot(container: HTMLElement): HTMLElement {
    const dot = container.querySelector('div[aria-hidden="true"]');
    if (!dot) throw new Error("ActivityLight dot not found");
    return dot as HTMLElement;
  }

  it("does not spam live regions (no role=status, no role=img)", () => {
    const { container } = render(<ActivityLight lastActivityTimestamp={Date.now()} />);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[role="img"]')).toBeNull();
  });

  it("marks the dot aria-hidden so adjacent text carries the label", () => {
    const { container } = render(<ActivityLight lastActivityTimestamp={Date.now()} />);
    expect(getDot(container).getAttribute("aria-hidden")).toBe("true");
  });

  it("does not render a tooltip subtree", () => {
    const { container } = render(<ActivityLight lastActivityTimestamp={Date.now()} />);
    expect(container.querySelectorAll("div").length).toBe(1);
  });

  it("renders a filled dot when actively working", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const { container } = render(<ActivityLight lastActivityTimestamp={now} />);
    const dot = getDot(container);
    expect(dot.style.backgroundColor).not.toBe("");
    expect(dot.style.borderColor).toBe("");
    expect(dot.className).not.toMatch(/\bborder\b/);
  });

  it("renders a hollow ring when idle (elapsed >= DECAY_DURATION)", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const past = now - DECAY_DURATION - 1;
    const { container } = render(<ActivityLight lastActivityTimestamp={past} />);
    const dot = getDot(container);
    expect(dot.className).toMatch(/\bborder\b/);
    expect(dot.className).toMatch(/bg-transparent/);
    expect(dot.style.borderColor).not.toBe("");
  });

  it("renders hollow ring when timestamp is null", () => {
    const { container } = render(<ActivityLight lastActivityTimestamp={null} />);
    const dot = getDot(container);
    expect(dot.className).toMatch(/\bborder\b/);
    expect(dot.className).toMatch(/bg-transparent/);
  });

  it("renders hollow ring when timestamp is undefined", () => {
    const { container } = render(<ActivityLight />);
    const dot = getDot(container);
    expect(dot.className).toMatch(/\bborder\b/);
  });

  it("applies the className prop", () => {
    const { container } = render(
      <ActivityLight lastActivityTimestamp={Date.now()} className="w-1.5 h-1.5" />
    );
    expect(getDot(container).className).toContain("w-1.5");
    expect(getDot(container).className).toContain("h-1.5");
  });
});
