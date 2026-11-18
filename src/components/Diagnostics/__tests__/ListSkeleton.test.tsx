// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_SKELETON_GATE_MS } from "@/lib/animationUtils";
import { ListSkeleton } from "../ListSkeleton";

describe("ListSkeleton onset gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("paints nothing before the onset threshold", () => {
    const { container, queryByRole } = render(<ListSkeleton label="Loading events" />);
    act(() => {
      vi.advanceTimersByTime(UI_SKELETON_GATE_MS - 1);
    });
    expect(queryByRole("status")).toBeNull();
    expect(container.querySelector("[data-skeleton-bone]")).toBeNull();
  });

  it("paints the rows once the threshold passes", () => {
    const { container, getByRole } = render(<ListSkeleton label="Loading events" />);
    act(() => {
      vi.advanceTimersByTime(UI_SKELETON_GATE_MS);
    });
    expect(getByRole("status").getAttribute("aria-label")).toBe("Loading events");
    const bones = container.querySelectorAll("[data-skeleton-bone]");
    expect(bones.length).toBe(5);
    for (const bone of bones) {
      expect(bone.classList.contains("animate-pulse-immediate")).toBe(true);
      expect(bone.classList.contains("animate-pulse-delayed")).toBe(false);
    }
  });

  it("never paints when unmounted inside the threshold", () => {
    const { container, unmount } = render(<ListSkeleton label="Loading events" />);
    act(() => {
      vi.advanceTimersByTime(UI_SKELETON_GATE_MS - 50);
    });
    expect(container.querySelector("[data-skeleton-bone]")).toBeNull();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(container.querySelector("[data-skeleton-bone]")).toBeNull();
  });
});
