// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationStore } from "@/store/notificationStore";
import { BANNER_ENTER_DURATION, BANNER_EXIT_DURATION } from "@/lib/animationUtils";
import { GridNotificationBar } from "../GridNotificationBar";

vi.stubGlobal("requestAnimationFrame", ((cb: FrameRequestCallback): number => {
  const timeoutId = setTimeout(() => cb(0), 0);
  return timeoutId as unknown as number;
}) satisfies typeof requestAnimationFrame);
vi.stubGlobal("cancelAnimationFrame", (id: number) =>
  clearTimeout(id as unknown as NodeJS.Timeout)
);

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

describe("GridNotificationBar animation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useNotificationStore.getState().reset();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders nothing when no grid-bar notification is present", () => {
    const { container } = render(<GridNotificationBar />);
    expect(container.firstChild).toBeNull();
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

  it("collapses and unmounts content after the exit window", () => {
    addGridBar({ message: "Goodbye" });
    const { container } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(getWrapper(container)?.className).toContain("h-auto");

    act(() => {
      useNotificationStore.getState().reset();
    });

    // Mid-exit: still mounted, collapsed, exit easing applied.
    const exiting = getWrapper(container);
    expect(exiting).not.toBeNull();
    const exitingEl = exiting!;
    expect(exitingEl.className).toContain("h-0");
    expect(exitingEl.className).toContain("opacity-0");
    expect(exitingEl.className).toContain("ease-[var(--ease-exit)]");
    expect(exitingEl.style.transitionDuration).toBe(`${BANNER_EXIT_DURATION}ms`);

    // After exit window: fully unmounted.
    act(() => {
      vi.advanceTimersByTime(BANNER_EXIT_DURATION);
    });
    expect(container.firstChild).toBeNull();
  });

  it("interrupts a pending exit when a replacement notification arrives", () => {
    addGridBar({ message: "First" });
    const { container, getByText } = render(<GridNotificationBar />);
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
    act(() => {
      vi.advanceTimersByTime(16);
    });

    // Advance past the *original* exit timer's deadline. If it weren't
    // cancelled, displayedNotification would be cleared and Second would
    // disappear from the DOM.
    act(() => {
      vi.advanceTimersByTime(BANNER_EXIT_DURATION);
    });

    const wrapper = getWrapper(container);
    expect(wrapper).not.toBeNull();
    expect(getByText("Second")).toBeTruthy();
    expect(wrapper?.className).toContain("h-auto");
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

    // Exit window completes, content unmounts.
    act(() => {
      vi.advanceTimersByTime(BANNER_EXIT_DURATION);
    });
    expect(container.firstChild).toBeNull();
  });

  it("renders aria-live status region on the wrapper for screen readers", () => {
    addGridBar({ message: "Announce me" });
    const { container } = render(<GridNotificationBar />);
    act(() => {
      vi.advanceTimersByTime(16);
    });

    const wrapper = getWrapper(container);
    expect(wrapper?.getAttribute("role")).toBe("status");
    expect(wrapper?.getAttribute("aria-live")).toBe("polite");
    // Wrapper must NOT be inert — that would suppress live-region announcements.
    expect(wrapper?.hasAttribute("inert")).toBe(false);
  });

  it("blocks focus and screen readers on action buttons while collapsed", () => {
    const onClick = vi.fn();
    addGridBar({
      message: "Pick one",
      action: { label: "Confirm", onClick },
    });
    const { container } = render(<GridNotificationBar />);

    // Pre-rAF (collapsed): button is non-tabbable and aria-hidden.
    const earlyBtn = container.querySelector("button");
    expect(earlyBtn).not.toBeNull();
    expect(earlyBtn?.getAttribute("tabindex")).toBe("-1");
    expect(earlyBtn?.getAttribute("aria-hidden")).toBe("true");

    act(() => {
      vi.advanceTimersByTime(16);
    });

    // Visible: focusable and exposed to AT.
    const liveBtn = container.querySelector("button");
    expect(liveBtn?.hasAttribute("tabindex")).toBe(false);
    expect(liveBtn?.hasAttribute("aria-hidden")).toBe(false);
  });

  it("animates in when a notification is added after mount", () => {
    const { container, getByText } = render(<GridNotificationBar />);
    expect(container.firstChild).toBeNull();

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
});
