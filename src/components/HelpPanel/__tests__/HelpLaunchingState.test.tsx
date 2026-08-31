// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HelpLaunchingState } from "../HelpLaunchingState";
import { __resetHelpSessionControllersForTests } from "@/controllers/helpSessionControllerRegistry";

describe("HelpLaunchingState", () => {
  beforeEach(() => {
  // #12108: controllers live in a per-view registry, not component
  // state, so they outlive a render and must be reset between tests.
  __resetHelpSessionControllersForTests();
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

  it("stays hidden until the Doherty gate elapses", () => {
    const { container } = render(
      <HelpLaunchingState phase="provisioning" isLoading onCancel={() => {}} />
    );
    expect(container.firstChild).toBeNull();
    advance(400);
    expect(container.firstChild).not.toBeNull();
  });

  it("threads the phase label through the hint so AT hears it (not the generic copy)", () => {
    const { container } = render(
      <HelpLaunchingState phase="provisioning" isLoading onCancel={() => {}} />
    );
    advance(400); // clear Doherty gate; hint mounts and starts its timers
    advance(8_000); // reach the first hint threshold
    // The Skeleton wrapper is itself a role=status / aria-live region; the hint's
    // live region is the sibling one, outside any role=status subtree.
    const live = Array.from(container.querySelectorAll('[aria-live="polite"]')).find(
      (el) => el.closest('[role="status"]') === null
    )!;
    expect(live.textContent).toBe("Provisioning session… Cancel option available.");
  });
});
