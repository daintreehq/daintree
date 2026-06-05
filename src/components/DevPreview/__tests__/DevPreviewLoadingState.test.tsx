// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DevPreviewLoadingState } from "../DevPreviewLoadingState";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";

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
    // Sub-threshold: the status region exists for AT, but no visible spinner yet.
    expect(container.querySelector('[role="status"]')).toBeTruthy();
    expect(container.querySelector('[role="status"] svg')).toBeNull();
    advance(UI_DOHERTY_THRESHOLD);
    expect(container.querySelector('[role="status"] svg')).toBeTruthy();
    const caption = container.querySelector("p[aria-hidden='true']");
    expect(caption?.textContent).toBe("Installing dependencies");
  });

  it("never shows the spinner when loading resolves before the Doherty gate", () => {
    const { container, rerender } = render(
      <DevPreviewLoadingState variant="full" isLoading phaseLabel="Restarting" />
    );
    advance(UI_DOHERTY_THRESHOLD / 2);
    rerender(<DevPreviewLoadingState variant="full" isLoading={false} phaseLabel="Restarting" />);
    advance(UI_DOHERTY_THRESHOLD * 2);
    expect(container.querySelector('[role="status"] svg')).toBeNull();
    expect(container.querySelector("p[aria-hidden='true']")).toBeNull();
  });

  it("updates the visible caption when the phase label changes mid-load", () => {
    const { container, rerender } = render(
      <DevPreviewLoadingState variant="full" isLoading phaseLabel="Starting dev server" />
    );
    advance(UI_DOHERTY_THRESHOLD);
    rerender(
      <DevPreviewLoadingState variant="full" isLoading phaseLabel="Installing dependencies" />
    );
    expect(container.querySelector("p[aria-hidden='true']")?.textContent).toBe(
      "Installing dependencies"
    );
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
    // Sub-threshold: nothing rendered (Doherty gate).
    expect(container.querySelector("p")).toBeNull();
    advance(UI_DOHERTY_THRESHOLD);
    const caption = container.querySelector("p[aria-hidden='true']");
    expect(caption?.textContent).toBe("Rehydrating preview");
  });

  it("does not place a second live region inside the aria-busy status wrapper", () => {
    const { container } = render(
      <DevPreviewLoadingState variant="overlay" isLoading phaseLabel="Rehydrating preview" />
    );
    advance(UI_DOHERTY_THRESHOLD);
    // Every aria-live region lives outside the aria-busy status wrapper, where
    // it would otherwise be silenced.
    const liveRegions = container.querySelectorAll("[aria-live]");
    expect(liveRegions.length).toBeGreaterThan(0);
    for (const region of liveRegions) {
      expect(region.closest('[role="status"]')).toBeNull();
    }
  });
});
