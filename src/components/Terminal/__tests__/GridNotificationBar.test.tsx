// @vitest-environment jsdom
import { render, act, fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GRID_BAR_DWELL_FLOOR_MS, useNotificationStore } from "@/store/notificationStore";
import {
  BANNER_ENTER_DURATION,
  BANNER_EXIT_DURATION,
  LIVE_REGION_SWAP_DELAY,
} from "@/lib/animationUtils";
import { GridNotificationBar } from "../GridNotificationBar";

vi.stubGlobal("requestAnimationFrame", ((cb: FrameRequestCallback): number => {
  const timeoutId = setTimeout(() => cb(0), 0);
  return timeoutId as unknown as number;
}) satisfies typeof requestAnimationFrame);
vi.stubGlobal("cancelAnimationFrame", (id: number) =>
  clearTimeout(id as unknown as NodeJS.Timeout)
);

function stubMatchMedia(reducedMotion: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? reducedMotion : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  );
}

function addGridBar(overrides: Record<string, unknown> = {}): string {
  return useNotificationStore.getState().addNotification({
    type: "info",
    priority: "low",
    placement: "grid-bar",
    message: "Test message",
    inboxMessage: "Test message",
    ...overrides,
  });
}

function getWrapper(container: HTMLElement): HTMLElement | null {
  return container.querySelector(".grid-notification-wrapper");
}

function getLiveRegion(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[role="status"]');
}

describe("GridNotificationBar animation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubMatchMedia(false);
    useNotificationStore.getState().reset();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("keeps the live region mounted when no grid-bar notification is present", () => {
    const { container } = render(<GridNotificationBar />);

    const wrapper = getWrapper(container);
    expect(wrapper).not.toBeNull();
    // Outer wrapper exists but is collapsed.
    expect(wrapper?.className).toContain("h-0");
    expect(wrapper?.className).toContain("opacity-0");

    // Live region is always mounted with aria-atomic so AT registers it on load.
    const live = getLiveRegion(container);
    expect(live).not.toBeNull();
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.getAttribute("aria-atomic")).toBe("true");
    expect(live?.textContent).toBe("");
  });

  it("starts collapsed and animates open after one rAF tick", () => {
    addGridBar({ message: "Hello" });
    const { container } = render(<GridNotificationBar />);

    const wrapper = getWrapper(container);
    expect(wrapper).not.toBeNull();
    // Pre-rAF: collapsed.
    expect(wrapper?.className).toContain("h-0");
    expect(wrapper?.className).toContain("opacity-0");

    act(() => {
      vi.advanceTimersByTime(16);
    });

    const visible = getWrapper(container);
    expect(visible?.className).toContain("h-auto");
    expect(visible?.className).toContain("opacity-100");
  });

  it("uses entry duration and snappy easing while visible", () => {
    addGridBar();
    const { container } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });

    const wrapper = getWrapper(container);
    expect(wrapper).not.toBeNull();
    const wrapperEl = wrapper!;
    expect(wrapperEl.style.transitionDuration).toBe(`${BANNER_ENTER_DURATION}ms`);
    expect(wrapperEl.className).toContain("ease-[var(--ease-snappy)]");
  });

  it("collapses and clears content after the exit window", () => {
    addGridBar({ message: "Goodbye" });
    const { container } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(getWrapper(container)?.className).toContain("h-auto");
    expect(getLiveRegion(container)?.textContent).toContain("Goodbye");

    act(() => {
      useNotificationStore.getState().reset();
    });

    // Mid-exit: still mounted, collapsed, exit easing applied, content still visible.
    const exiting = getWrapper(container);
    expect(exiting).not.toBeNull();
    const exitingEl = exiting!;
    expect(exitingEl.className).toContain("h-0");
    expect(exitingEl.className).toContain("opacity-0");
    expect(exitingEl.className).toContain("ease-[var(--ease-exit)]");
    expect(exitingEl.style.transitionDuration).toBe(`${BANNER_EXIT_DURATION}ms`);

    // After exit window: wrapper still mounted (always-mounted live region),
    // but live region content is cleared.
    act(() => {
      vi.advanceTimersByTime(BANNER_EXIT_DURATION);
    });
    const settled = getWrapper(container);
    expect(settled).not.toBeNull();
    expect(settled?.className).toContain("h-0");
    expect(getLiveRegion(container)?.textContent).toBe("");
  });

  it("interrupts a pending exit and applies the swap delay when a replacement arrives", () => {
    addGridBar({ message: "First" });
    const { container, getByText, queryByText } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(getByText("First")).toBeTruthy();

    // A → null → B before the exit timer fires.
    act(() => {
      useNotificationStore.getState().reset();
    });
    act(() => {
      vi.advanceTimersByTime(BANNER_EXIT_DURATION / 2);
    });
    act(() => {
      addGridBar({ message: "Second" });
    });
    // Effect runs (synchronous setState batch); swap timer scheduled.
    act(() => {
      vi.advanceTimersByTime(16);
    });

    // Mid-swap: live region cleared, "Second" not yet rendered.
    expect(queryByText("Second")).toBeNull();
    expect(queryByText("First")).toBeNull();
    expect(getLiveRegion(container)?.textContent).toBe("");

    // After the swap delay, "Second" appears.
    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY);
    });
    expect(getByText("Second")).toBeTruthy();

    // Original exit timer's deadline passes; "Second" stays (exit was cancelled).
    act(() => {
      vi.advanceTimersByTime(BANNER_EXIT_DURATION);
    });
    expect(getByText("Second")).toBeTruthy();
    expect(getWrapper(container)?.className).toContain("h-auto");
  });

  it("cancels a pending entry rAF when the notification is removed pre-rAF", () => {
    addGridBar({ message: "Quick" });
    const { container } = render(<GridNotificationBar />);

    // Pre-rAF: collapsed.
    expect(getWrapper(container)?.className).toContain("h-0");

    // Remove before the entry rAF fires.
    act(() => {
      useNotificationStore.getState().reset();
    });

    // Flush the (cancelled) rAF window. If the rAF weren't cancelled, isVisible
    // would flip to true here and the bar would briefly reopen.
    act(() => {
      vi.advanceTimersByTime(16);
    });

    const wrapper = getWrapper(container);
    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).toContain("h-0");
    expect(wrapper?.className).not.toContain("h-auto");

    // Exit window completes, content cleared but wrapper persists.
    act(() => {
      vi.advanceTimersByTime(BANNER_EXIT_DURATION);
    });
    expect(getWrapper(container)).not.toBeNull();
    expect(getLiveRegion(container)?.textContent).toBe("");
  });

  it("scopes role=status, aria-live, and aria-atomic to the inner live region only", () => {
    addGridBar({ message: "Announce me" });
    const { container } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });

    const wrapper = getWrapper(container);
    // Outer animation wrapper must NOT carry live-region attributes — those
    // belong to the inner text-only region.
    expect(wrapper?.hasAttribute("role")).toBe(false);
    expect(wrapper?.hasAttribute("aria-live")).toBe(false);
    expect(wrapper?.hasAttribute("inert")).toBe(false);

    const live = getLiveRegion(container);
    expect(live).not.toBeNull();
    expect(live?.getAttribute("role")).toBe("status");
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.getAttribute("aria-atomic")).toBe("true");
    expect(live?.textContent).toContain("Announce me");
  });

  it("renders action and dismiss controls as siblings of the live region, not inside it", () => {
    const onClick = vi.fn();
    addGridBar({
      message: "Pick one",
      action: { label: "Confirm", onClick },
    });
    const { container, getByRole } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });

    const live = getLiveRegion(container);
    expect(live).not.toBeNull();
    // The live region announces flat text; buttons must not be its descendants.
    expect(within(live!).queryAllByRole("button")).toHaveLength(0);

    // A notification carrying actions still gets a dismiss control alongside
    // them, so the bar is clearable without committing to an action.
    const confirmBtn = getByRole("button", { name: "Confirm" });
    const dismissBtn = getByRole("button", { name: "Dismiss" });
    expect(live!.contains(confirmBtn)).toBe(false);
    expect(live!.contains(dismissBtn)).toBe(false);
    // Both still live in the bar row that owns the live region.
    expect(live!.parentElement?.contains(confirmBtn)).toBe(true);
    expect(live!.parentElement?.contains(dismissBtn)).toBe(true);

    // Actions lead, dismiss trails: the escape control is last in tab order.
    expect(Array.from(container.querySelectorAll("button"))).toEqual([confirmBtn, dismissBtn]);
  });

  it("renders the dismiss control as the only button when the notification has no actions", () => {
    addGridBar({ message: "Dismiss me" });
    const { container, getByRole } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });

    const live = getLiveRegion(container);
    expect(live).not.toBeNull();
    const dismissBtn = getByRole("button", { name: "Dismiss" });
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(live!.contains(dismissBtn)).toBe(false);
  });

  it("removes the notification from the store and empties the bar when dismiss is clicked", () => {
    const id = addGridBar({
      message: "Already handled",
      action: { label: "Confirm", onClick: vi.fn() },
    });
    const { container, getByRole } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });

    act(() => {
      fireEvent.click(getByRole("button", { name: "Dismiss" }));
    });

    // Hard removal: no soft `dismissed: true` row is left behind to accumulate,
    // since nothing downstream ever reads a dismissed grid-bar entry.
    expect(useNotificationStore.getState().notifications.some((n) => n.id === id)).toBe(false);
    // Collapse starts immediately rather than waiting on a duration.
    expect(getWrapper(container)?.className).toContain("h-0");

    act(() => {
      vi.advanceTimersByTime(BANNER_EXIT_DURATION);
    });

    // The live region stays mounted for AT registration, but is emptied and
    // every control is gone.
    expect(getLiveRegion(container)?.textContent).toBe("");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("blocks focus and screen readers on action and dismiss controls while collapsed", () => {
    const onClick = vi.fn();
    addGridBar({
      message: "Pick one",
      action: { label: "Confirm", onClick },
    });
    const { container } = render(<GridNotificationBar />);

    // Pre-rAF (collapsed): every control is non-tabbable and aria-hidden.
    const earlyButtons = Array.from(container.querySelectorAll("button"));
    expect(earlyButtons).toHaveLength(2);
    for (const btn of earlyButtons) {
      expect(btn.getAttribute("tabindex")).toBe("-1");
      expect(btn.getAttribute("aria-hidden")).toBe("true");
    }

    act(() => {
      vi.advanceTimersByTime(16);
    });

    // Visible: focusable and exposed to AT.
    const liveButtons = Array.from(container.querySelectorAll("button"));
    expect(liveButtons).toHaveLength(2);
    for (const btn of liveButtons) {
      expect(btn.hasAttribute("tabindex")).toBe(false);
      expect(btn.hasAttribute("aria-hidden")).toBe(false);
    }
  });

  it("animates in when a notification is added after mount", () => {
    const { container, getByText } = render(<GridNotificationBar />);
    // Always-mounted: wrapper exists, just collapsed.
    expect(getWrapper(container)).not.toBeNull();
    expect(getWrapper(container)?.className).toContain("h-0");

    act(() => {
      addGridBar({ message: "Late arrival" });
    });

    // Synchronously rendered, but collapsed pending rAF.
    expect(getByText("Late arrival")).toBeTruthy();
    expect(getWrapper(container)?.className).toContain("h-0");

    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(getWrapper(container)?.className).toContain("h-auto");
  });

  it("clears pending timers on unmount without throwing or warning", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    addGridBar();
    const { unmount } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });

    act(() => {
      useNotificationStore.getState().reset();
    });

    expect(() => {
      unmount();
      vi.advanceTimersByTime(BANNER_EXIT_DURATION * 2);
    }).not.toThrow();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("clears the swap timer on unmount mid-swap", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const firstId = addGridBar({ message: "First" });
    const { unmount } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });

    // Trigger a swap (clears live region, schedules timer).
    act(() => {
      useNotificationStore.getState().removeNotification(firstId);
      addGridBar({ message: "Second" });
    });

    expect(() => {
      unmount();
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY * 2);
    }).not.toThrow();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe("GridNotificationBar swap delay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubMatchMedia(false);
    useNotificationStore.getState().reset();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("clears the live region and waits LIVE_REGION_SWAP_DELAY before announcing the replacement", () => {
    const firstId = addGridBar({ message: "First" });
    const { container, queryByText, getByText } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(getByText("First")).toBeTruthy();

    // Direct A→B swap (no intermediate null).
    act(() => {
      useNotificationStore.getState().removeNotification(firstId);
      addGridBar({ message: "Second" });
    });

    // Live region is cleared immediately on swap.
    expect(getLiveRegion(container)?.textContent).toBe("");
    expect(queryByText("First")).toBeNull();
    expect(queryByText("Second")).toBeNull();

    // Just under the swap delay: still empty.
    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY - 1);
    });
    expect(queryByText("Second")).toBeNull();

    // At the swap delay boundary: "Second" appears.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(getByText("Second")).toBeTruthy();
    expect(getLiveRegion(container)?.textContent).toContain("Second");
    // Bar never collapsed visually — isVisible stayed true.
    expect(getWrapper(container)?.className).toContain("h-auto");
  });

  it("re-announces same-text content when the id changes (VoiceOver buffer flush)", () => {
    const firstId = addGridBar({ message: "Saved" });
    const { container, queryByText, getByText } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(getByText("Saved")).toBeTruthy();

    // Same message text, fresh id — must clear and re-announce so AT re-reads it.
    act(() => {
      useNotificationStore.getState().removeNotification(firstId);
      addGridBar({ message: "Saved" });
    });

    expect(getLiveRegion(container)?.textContent).toBe("");
    expect(queryByText("Saved")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY - 1);
    });
    expect(queryByText("Saved")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(getByText("Saved")).toBeTruthy();
  });

  it("collapses pending swaps so only the latest notification is announced (A→B→C)", () => {
    const firstId = addGridBar({ message: "First" });
    const { queryByText, getByText } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });

    // Swap to Second, then to Third before Second's timer fires.
    act(() => {
      useNotificationStore.getState().removeNotification(firstId);
      const secondId = addGridBar({ message: "Second" });
      // Mid-swap clear is now in effect; before the timer fires, swap again.
      useNotificationStore.getState().removeNotification(secondId);
      addGridBar({ message: "Third" });
    });

    // Advance through the original swap delay window.
    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY);
    });

    // Second was retargeted to Third — Second never appears.
    expect(queryByText("Second")).toBeNull();
    expect(getByText("Third")).toBeTruthy();
  });
});

describe("GridNotificationBar reduced motion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubMatchMedia(true);
    useNotificationStore.getState().reset();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders the bar visible immediately without a rAF entry tick", () => {
    addGridBar({ message: "Instant" });
    const { container, getByText } = render(<GridNotificationBar />);

    // No rAF needed: wrapper starts visible.
    const wrapper = getWrapper(container);
    expect(wrapper?.className).toContain("h-auto");
    expect(wrapper?.className).toContain("opacity-100");
    expect(getByText("Instant")).toBeTruthy();
  });

  it("zeroes out the wrapper transition duration", () => {
    addGridBar({ message: "No motion" });
    const { container } = render(<GridNotificationBar />);

    const wrapper = getWrapper(container);
    expect(wrapper?.style.transitionDuration).toBe("0ms");
  });

  it("still applies the 150ms swap delay even under reduced motion", () => {
    const firstId = addGridBar({ message: "First" });
    const { container, queryByText, getByText } = render(<GridNotificationBar />);

    expect(getByText("First")).toBeTruthy();

    act(() => {
      useNotificationStore.getState().removeNotification(firstId);
      addGridBar({ message: "Second" });
    });

    // Live region cleared immediately.
    expect(getLiveRegion(container)?.textContent).toBe("");

    // Swap delay still applies — not gated on prefers-reduced-motion.
    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY - 1);
    });
    expect(queryByText("Second")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(getByText("Second")).toBeTruthy();
  });
});

describe("GridNotificationBar selection contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubMatchMedia(false);
    useNotificationStore.getState().reset();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("does not preempt a low-priority notification with a high-priority one inside the dwell floor", () => {
    addGridBar({ message: "Low priority", priority: "low" });
    const { container, getByText, queryByText } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(getByText("Low priority")).toBeTruthy();

    // Higher-priority contender arrives well inside the dwell window.
    act(() => {
      vi.advanceTimersByTime(1000);
      addGridBar({ message: "High priority", priority: "high" });
    });

    // Dwell still active — newcomer is queued, low-priority stays.
    expect(getByText("Low priority")).toBeTruthy();
    expect(queryByText("High priority")).toBeNull();
    expect(getLiveRegion(container)?.textContent).toContain("Low priority");
  });

  it("preempts the locked notification once the dwell floor elapses", () => {
    addGridBar({ message: "Low priority", priority: "low" });
    const { getByText, queryByText } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(getByText("Low priority")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1000);
      addGridBar({ message: "High priority", priority: "high" });
    });
    // Still locked.
    expect(queryByText("High priority")).toBeNull();

    // Advance past the dwell floor + the live-region swap delay.
    act(() => {
      vi.advanceTimersByTime(GRID_BAR_DWELL_FLOOR_MS);
    });
    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY + 16);
    });

    expect(getByText("High priority")).toBeTruthy();
    expect(queryByText("Low priority")).toBeNull();
  });

  it("never lets a lower-priority newcomer preempt a higher-priority displayed notification, even after dwell", () => {
    addGridBar({ message: "High priority", priority: "high" });
    const { getByText, queryByText } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(getByText("High priority")).toBeTruthy();

    // Lower-priority newcomer arrives after dwell has fully elapsed.
    act(() => {
      vi.advanceTimersByTime(GRID_BAR_DWELL_FLOOR_MS + 1000);
      addGridBar({ message: "Low priority", priority: "low" });
    });
    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY + 16);
    });

    // High-priority wins on score regardless of dwell — selection contract,
    // not just dwell, keeps it visible.
    expect(getByText("High priority")).toBeTruthy();
    expect(queryByText("Low priority")).toBeNull();
  });

  it("picks the winning notification on first mount when multiple grid-bar notifications exist", () => {
    addGridBar({ message: "Low first", priority: "low" });
    addGridBar({ message: "High after", priority: "high" });

    const { getByText, queryByText } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });

    // Old behavior (bare .find()) would show "Low first". New contract picks
    // the high-priority winner regardless of insertion order.
    expect(getByText("High after")).toBeTruthy();
    expect(queryByText("Low first")).toBeNull();
  });

  it("locks the dwell window even when a higher-priority contender arrives in the same paint cycle", () => {
    const lowId = addGridBar({ message: "Low priority", priority: "low" });
    const { getByText, queryByText } = render(<GridNotificationBar />);

    // No rAF tick yet — entry hasn't even animated in. Add a high-priority
    // contender immediately, in the same paint cycle. The useLayoutEffect
    // ensures lockedIdRef is set before any re-render runs the selector.
    act(() => {
      addGridBar({ message: "High priority", priority: "high" });
    });

    // Flush the entry rAF.
    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(getByText("Low priority")).toBeTruthy();
    expect(queryByText("High priority")).toBeNull();

    // Cleanup: remove the low one to let the high one come up so afterEach
    // doesn't time out on pending dwell.
    act(() => {
      useNotificationStore.getState().removeNotification(lowId);
    });
    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY + 16);
    });
    expect(getByText("High priority")).toBeTruthy();
  });

  it("releases promptly when the locked notification is dismissed mid-dwell", () => {
    addGridBar({ message: "Low priority", priority: "low" });
    const { getByRole, getByText, queryByText } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(getByText("Low priority")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // High priority queued behind the dwell lock.
    act(() => {
      addGridBar({ message: "High priority", priority: "high" });
    });
    expect(queryByText("High priority")).toBeNull();

    // User dismisses the locked low one through the rendered control, ~1s into
    // a 5s floor. Removing it drops it from the candidate set, so the lock
    // releases without waiting out GRID_BAR_DWELL_FLOOR_MS.
    act(() => {
      fireEvent.click(getByRole("button", { name: "Dismiss" }));
    });
    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY + 16);
    });

    expect(getByText("High priority")).toBeTruthy();
    expect(queryByText("Low priority")).toBeNull();
  });

  it("clears the dwell timer on unmount without firing setState afterwards", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    addGridBar({ message: "Locked", priority: "low" });
    const { unmount } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(() => {
      unmount();
      // Advance past when the dwell timeout would have fired.
      vi.advanceTimersByTime(GRID_BAR_DWELL_FLOOR_MS * 2);
    }).not.toThrow();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
