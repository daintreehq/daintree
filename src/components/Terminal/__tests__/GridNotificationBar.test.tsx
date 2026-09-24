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

/** What the strip draws — the text a sighted user reads, outside the live region. */
function shownText(container: HTMLElement): string {
  const card = getWrapper(container)?.firstElementChild;
  if (!card) return "";
  return Array.from(card.children)
    .filter(
      (el) => el.getAttribute("role") !== "status" && el.getAttribute("aria-hidden") === "true"
    )
    .map((el) => el.textContent ?? "")
    .join("");
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
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY);
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
    const { container } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(shownText(container)).toContain("First");

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

    // Mid-swap: the strip already draws "Second" — it never blanks — while the
    // live region stays empty until the announcement gap has passed.
    expect(shownText(container)).toContain("Second");
    expect(shownText(container)).not.toContain("First");
    expect(getLiveRegion(container)?.textContent).toBe("");

    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY);
    });
    expect(getLiveRegion(container)?.textContent).toContain("Second");

    // Original exit timer's deadline passes; "Second" stays (exit was cancelled).
    act(() => {
      vi.advanceTimersByTime(BANNER_EXIT_DURATION);
    });
    expect(shownText(container)).toContain("Second");
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
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY);
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
    // Two actions, matching the shape real producers use, so the ordering
    // assertion would catch dismiss being inserted between them.
    addGridBar({
      message: "Pick one",
      actions: [
        { label: "Confirm", onClick: vi.fn() },
        { label: "Not now", onClick: vi.fn(), variant: "secondary" },
      ],
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
    const notNowBtn = getByRole("button", { name: "Not now" });
    const dismissBtn = getByRole("button", { name: "Dismiss" });
    for (const btn of [confirmBtn, notNowBtn, dismissBtn]) {
      expect(live!.contains(btn)).toBe(false);
      // Still inside the bar row that owns the live region.
      expect(live!.parentElement?.contains(btn)).toBe(true);
    }

    // Every action leads, dismiss trails: the escape control is last in tab
    // order. Identity per index, since toEqual on DOM nodes compares structure.
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toBe(confirmBtn);
    expect(buttons[1]).toBe(notNowBtn);
    expect(buttons[2]).toBe(dismissBtn);
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
    const { container, getByRole, queryByRole } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });

    act(() => {
      fireEvent.click(getByRole("button", { name: "Dismiss" }));
    });

    // Hard removal: no soft `dismissed: true` row is left behind to accumulate,
    // since nothing downstream ever reads a dismissed grid-bar entry.
    expect(useNotificationStore.getState().notifications.some((n) => n.id === id)).toBe(false);

    // Exit begins immediately rather than waiting on a duration: the controls
    // stay mounted for the collapse but are already out of the a11y tree.
    expect(container.querySelectorAll("button")).toHaveLength(2);
    expect(queryByRole("button", { name: "Dismiss" })).toBeNull();

    act(() => {
      vi.advanceTimersByTime(BANNER_EXIT_DURATION);
    });

    // The live region stays mounted for AT registration, but is emptied and
    // every control is gone.
    expect(getLiveRegion(container)?.textContent).toBe("");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("keeps the action and dismiss handlers separate", () => {
    const onClick = vi.fn();
    const id = addGridBar({
      message: "Pick one",
      action: { label: "Confirm", onClick },
    });
    const { getByRole } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });

    // The action fires its own callback and leaves the row in place for the
    // producer to clear; the bar never auto-dismisses on an action click.
    act(() => {
      fireEvent.click(getByRole("button", { name: "Confirm" }));
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(useNotificationStore.getState().notifications.some((n) => n.id === id)).toBe(true);

    // Dismiss clears the row without invoking the action.
    act(() => {
      fireEvent.click(getByRole("button", { name: "Dismiss" }));
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(useNotificationStore.getState().notifications.some((n) => n.id === id)).toBe(false);
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
    const { container } = render(<GridNotificationBar />);
    // Always-mounted: wrapper exists, just collapsed.
    expect(getWrapper(container)).not.toBeNull();
    expect(getWrapper(container)?.className).toContain("h-0");

    act(() => {
      addGridBar({ message: "Late arrival" });
    });

    // Synchronously rendered, but collapsed pending rAF.
    expect(shownText(container)).toContain("Late arrival");
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
    const { container } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(shownText(container)).toContain("First");

    // Direct A→B swap (no intermediate null).
    act(() => {
      useNotificationStore.getState().removeNotification(firstId);
      addGridBar({ message: "Second" });
    });

    // Live region is cleared immediately on swap; the strip switches at once.
    expect(getLiveRegion(container)?.textContent).toBe("");
    expect(shownText(container)).not.toContain("First");
    expect(shownText(container)).toContain("Second");

    // Just under the swap delay: the live region is still empty.
    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY - 1);
    });
    expect(getLiveRegion(container)?.textContent).toBe("");

    // At the swap delay boundary: "Second" is announced.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(getLiveRegion(container)?.textContent).toContain("Second");
    // Bar never collapsed visually — isVisible stayed true.
    expect(getWrapper(container)?.className).toContain("h-auto");
  });

  it("re-announces same-text content when the id changes (VoiceOver buffer flush)", () => {
    const firstId = addGridBar({ message: "Saved" });
    const { container } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(shownText(container)).toContain("Saved");

    // Same message text, fresh id — must clear and re-announce so AT re-reads it.
    act(() => {
      useNotificationStore.getState().removeNotification(firstId);
      addGridBar({ message: "Saved" });
    });

    expect(getLiveRegion(container)?.textContent).toBe("");
    expect(shownText(container)).toContain("Saved");

    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY - 1);
    });
    expect(getLiveRegion(container)?.textContent).toBe("");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(getLiveRegion(container)?.textContent).toContain("Saved");
  });

  it("collapses pending swaps so only the latest notification is announced (A→B→C)", () => {
    const firstId = addGridBar({ message: "First" });
    const { container } = render(<GridNotificationBar />);
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
    expect(shownText(container)).not.toContain("Second");
    expect(shownText(container)).toContain("Third");
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
    const { container } = render(<GridNotificationBar />);

    // No rAF needed: wrapper starts visible.
    const wrapper = getWrapper(container);
    expect(wrapper?.className).toContain("h-auto");
    expect(wrapper?.className).toContain("opacity-100");
    expect(shownText(container)).toContain("Instant");
  });

  it("zeroes out the wrapper transition duration", () => {
    addGridBar({ message: "No motion" });
    const { container } = render(<GridNotificationBar />);

    const wrapper = getWrapper(container);
    expect(wrapper?.style.transitionDuration).toBe("0ms");
  });

  it("still applies the 150ms swap delay even under reduced motion", () => {
    const firstId = addGridBar({ message: "First" });
    const { container } = render(<GridNotificationBar />);

    expect(shownText(container)).toContain("First");

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
    expect(getLiveRegion(container)?.textContent).toBe("");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(getLiveRegion(container)?.textContent).toContain("Second");
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
    const { container } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(shownText(container)).toContain("Low priority");

    // Higher-priority contender arrives well inside the dwell window.
    act(() => {
      vi.advanceTimersByTime(1000);
      addGridBar({ message: "High priority", priority: "high" });
    });

    // Dwell still active — newcomer is queued, low-priority stays.
    expect(shownText(container)).toContain("Low priority");
    expect(shownText(container)).not.toContain("High priority");
    expect(getLiveRegion(container)?.textContent).toContain("Low priority");
  });

  it("preempts the locked notification once the dwell floor elapses", () => {
    addGridBar({ message: "Low priority", priority: "low" });
    const { container } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(shownText(container)).toContain("Low priority");

    act(() => {
      vi.advanceTimersByTime(1000);
      addGridBar({ message: "High priority", priority: "high" });
    });
    // Still locked.
    expect(shownText(container)).not.toContain("High priority");

    // Advance past the dwell floor + the live-region swap delay.
    act(() => {
      vi.advanceTimersByTime(GRID_BAR_DWELL_FLOOR_MS);
    });
    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY + 16);
    });

    expect(shownText(container)).toContain("High priority");
    expect(shownText(container)).not.toContain("Low priority");
  });

  it("never lets a lower-priority newcomer preempt a higher-priority displayed notification, even after dwell", () => {
    addGridBar({ message: "High priority", priority: "high" });
    const { container } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(shownText(container)).toContain("High priority");

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
    expect(shownText(container)).toContain("High priority");
    expect(shownText(container)).not.toContain("Low priority");
  });

  it("picks the winning notification on first mount when multiple grid-bar notifications exist", () => {
    addGridBar({ message: "Low first", priority: "low" });
    addGridBar({ message: "High after", priority: "high" });

    const { container } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });

    // Old behavior (bare .find()) would show "Low first". New contract picks
    // the high-priority winner regardless of insertion order.
    expect(shownText(container)).toContain("High after");
    expect(shownText(container)).not.toContain("Low first");
  });

  it("locks the dwell window even when a higher-priority contender arrives in the same paint cycle", () => {
    const lowId = addGridBar({ message: "Low priority", priority: "low" });
    const { container } = render(<GridNotificationBar />);

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

    expect(shownText(container)).toContain("Low priority");
    expect(shownText(container)).not.toContain("High priority");

    // Cleanup: remove the low one to let the high one come up so afterEach
    // doesn't time out on pending dwell.
    act(() => {
      useNotificationStore.getState().removeNotification(lowId);
    });
    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY + 16);
    });
    expect(shownText(container)).toContain("High priority");
  });

  it("releases promptly when the locked notification is dismissed mid-dwell", () => {
    addGridBar({ message: "Low priority", priority: "low" });
    const { container, getByRole } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(shownText(container)).toContain("Low priority");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // High priority queued behind the dwell lock.
    act(() => {
      addGridBar({ message: "High priority", priority: "high" });
    });
    expect(shownText(container)).not.toContain("High priority");

    // User dismisses the locked low one through the rendered control, ~1s into
    // a 5s floor. Removing it drops it from the candidate set, so the lock
    // releases without waiting out GRID_BAR_DWELL_FLOOR_MS.
    act(() => {
      fireEvent.click(getByRole("button", { name: "Dismiss" }));
    });
    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY + 16);
    });

    expect(shownText(container)).toContain("High priority");
    expect(shownText(container)).not.toContain("Low priority");
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

describe("GridNotificationBar presentation invariants", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubMatchMedia(false);
    useNotificationStore.getState().reset();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("mounts its live region empty even when a notification is already waiting, then announces it", () => {
    addGridBar({ message: "Already here" });
    const { container } = render(<GridNotificationBar />);

    expect(getLiveRegion(container)?.textContent).toBe("");
    expect(shownText(container)).toContain("Already here");

    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY);
    });
    expect(getLiveRegion(container)?.textContent).toContain("Already here");
  });

  it("never draws an empty strip while a replacement waits to be announced", () => {
    const firstId = addGridBar({ message: "First" });
    const { container } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY);
    });

    act(() => {
      useNotificationStore.getState().removeNotification(firstId);
      addGridBar({ message: "Second" });
    });
    for (let t = 0; t <= LIVE_REGION_SWAP_DELAY; t += 10) {
      expect(shownText(container).trim()).not.toBe("");
      act(() => {
        vi.advanceTimersByTime(10);
      });
    }
  });

  it("draws a revised message for the same notification without replaying the announcement gap", () => {
    const id = addGridBar({ message: "Swap is 80% full" });
    const { container } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY);
    });

    act(() => {
      useNotificationStore.getState().updateNotification(id, { message: "Swap is 95% full" });
    });
    expect(shownText(container)).toContain("Swap is 95% full");
    expect(getLiveRegion(container)?.textContent).toContain("Swap is 95% full");
  });

  it("announces a revision that lands during the announcement gap, not the queued copy", () => {
    const id = addGridBar({ message: "Old copy" });
    const { container } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(30);
    });
    act(() => {
      useNotificationStore.getState().updateNotification(id, { message: "Revised copy" });
    });
    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_SWAP_DELAY);
    });
    expect(getLiveRegion(container)?.textContent).toContain("Revised copy");
    expect(getLiveRegion(container)?.textContent).not.toContain("Old copy");
  });

  it("keeps focus off <body> when a same-id revision replaces the focused action", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const id = addGridBar({
      message: "Couldn't reach the server",
      actions: [{ label: "Retry", onClick: vi.fn() }],
    });
    const { getByRole } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    outside.focus();
    act(() => {
      getByRole("button", { name: "Retry" }).focus();
    });

    act(() => {
      useNotificationStore
        .getState()
        .updateNotification(id, { actions: [{ label: "Install", onClick: vi.fn() }] });
    });
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(outside);
  });

  it("keeps severity off the text: only the glyph carries a status colour", () => {
    for (const type of ["info", "warning", "error", "success"] as const) {
      useNotificationStore.getState().reset();
      addGridBar({ type, title: "Something happened", message: "Details" });
      const { container, unmount } = render(<GridNotificationBar />);
      const coloured = Array.from(
        container.querySelectorAll<HTMLElement>("[class*='text-status-']")
      );
      expect(coloured.length).toBeGreaterThan(0);
      for (const el of coloured) expect(el.tagName.toLowerCase()).toBe("svg");
      unmount();
    }
  });

  it("gives the recommended action a different treatment from the alternative", () => {
    addGridBar({
      message: "Pick one",
      actions: [
        { label: "Enable", onClick: vi.fn(), variant: "primary" },
        { label: "Not now", onClick: vi.fn(), variant: "secondary" },
      ],
    });
    const { getByRole } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(getByRole("button", { name: "Enable" }).className).not.toBe(
      getByRole("button", { name: "Not now" }).className
    );
  });

  it("only lets the controls drop beneath the text when there are actions to drop", () => {
    const dismissRow = () =>
      document.querySelector('[aria-label="Dismiss"]')?.parentElement?.className ?? "";

    addGridBar({ message: "Nothing to do" });
    const first = render(<GridNotificationBar />);
    expect(dismissRow()).not.toContain("basis-full");
    first.unmount();

    useNotificationStore.getState().reset();
    addGridBar({ message: "Pick one", actions: [{ label: "Enable", onClick: vi.fn() }] });
    render(<GridNotificationBar />);
    expect(dismissRow()).toContain("basis-full");
  });

  it("hands focus back to where the user was when they dismiss from the keyboard", () => {
    const outside = document.createElement("button");
    outside.textContent = "Terminal";
    document.body.appendChild(outside);
    addGridBar({ message: "Dismiss me" });
    const { getByRole } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });

    outside.focus();
    const dismiss = getByRole("button", { name: "Dismiss" });
    act(() => {
      dismiss.focus();
    });
    expect(document.activeElement).toBe(dismiss);

    act(() => {
      fireEvent.click(dismiss);
    });
    act(() => {
      vi.advanceTimersByTime(BANNER_EXIT_DURATION);
    });
    expect(document.activeElement).toBe(outside);
  });
});
