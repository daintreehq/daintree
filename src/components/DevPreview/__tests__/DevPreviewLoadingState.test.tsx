// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DevPreviewLoadingState } from "../DevPreviewLoadingState";

describe("DevPreviewLoadingState", () => {
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

  it("shows a spinner and caption in the full variant once the Doherty gate clears", () => {
    const { container } = render(
      <DevPreviewLoadingState variant="full" isLoading phaseLabel="Installing dependencies" />
    );
    // Sub-400ms: the status region exists for AT, but no visible spinner yet.
    expect(container.querySelector('[role="status"]')).toBeTruthy();
    expect(container.querySelector('[role="status"] svg')).toBeNull();
    advance(400);
    expect(container.querySelector('[role="status"] svg')).toBeTruthy();
    const caption = container.querySelector("p[aria-hidden='true']");
    expect(caption?.textContent).toBe("Installing dependencies");
  });

  it("renders the SkeletonHint live region as a sibling, not nested in role=status", () => {
    const { container } = render(
      <DevPreviewLoadingState variant="full" isLoading phaseLabel="Installing dependencies" />
    );
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).toBeTruthy();
    expect(live!.closest('[role="status"]')).toBeNull();
  });

  it("shows a visible (aria-hidden) phase caption once the overlay clears the Doherty gate", () => {
    const { container } = render(
      <DevPreviewLoadingState variant="overlay" isLoading phaseLabel="Rehydrating preview" />
    );
    // Sub-400ms: nothing rendered (Doherty gate).
    expect(container.querySelector("p")).toBeNull();
    advance(400);
    const caption = container.querySelector("p[aria-hidden='true']");
    expect(caption?.textContent).toBe("Rehydrating preview");
  });

  it("does not place a second live region inside the aria-busy status wrapper", () => {
    const { container } = render(
      <DevPreviewLoadingState variant="overlay" isLoading phaseLabel="Rehydrating preview" />
    );
    advance(400);
    // The only aria-live region is the SkeletonHint sibling, outside role=status.
    const liveRegions = container.querySelectorAll("[aria-live]");
    expect(liveRegions.length).toBe(1);
    expect(liveRegions[0]!.closest('[role="status"]')).toBeNull();
  });
});
