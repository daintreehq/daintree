// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { render, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AppDialog } from "../AppDialog";
import { _resetForTests } from "@/lib/escapeStack";

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));

vi.mock("@/store", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useOverlayState: () => {} };
});

vi.mock("@/lib/scrollbarGutter", () => ({
  SCROLLBAR_GUTTER_VAR: "--app-scrollbar-gutter",
  measureScrollbarGutter: vi.fn(() => 0),
  publishScrollbarGutter: vi.fn(() => 0),
}));

/**
 * The real presence hook sets `shouldRender` from an effect, so the surface
 * mounts on a later render than the one where `isOpen` flips, and it keeps the
 * surface mounted through the exit animation after `isOpen` drops. How long each
 * takes depends on the scheduler; this stand-in makes the entry gap longer than
 * a frame so the ordering is deterministic rather than a race the test sometimes
 * wins.
 */
const SURFACE_DELAY_MS = 50;
const EXIT_MS = 120;

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => {
    const [shouldRender, setShouldRender] = useState(false);
    useEffect(() => {
      const timer = isOpen
        ? setTimeout(() => setShouldRender(true), SURFACE_DELAY_MS)
        : setTimeout(() => setShouldRender(false), EXIT_MS);
      return () => clearTimeout(timer);
    }, [isOpen]);
    return { isVisible: isOpen && shouldRender, shouldRender };
  },
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

describe("AppDialog initial focus when the surface mounts late", () => {
  beforeEach(() => {
    _resetForTests();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  it("moves focus into the dialog once it exists, off the trigger behind it", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    render(
      <AppDialog isOpen={true} onClose={() => {}} data-testid="late-dialog">
        <AppDialog.Body>
          <button type="button">First</button>
        </AppDialog.Body>
      </AppDialog>
    );
    // Once for the surface to mount, once more for the frame queued after it.
    await act(() => vi.runAllTimersAsync());
    await act(() => vi.runAllTimersAsync());

    const dialog = document.querySelector(`[data-testid="late-dialog"]`);
    expect(dialog).not.toBeNull();
    expect(dialog!.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.textContent).toBe("First");
    trigger.remove();
  });

  it("leaves focus where a consumer put it inside the dialog on open", async () => {
    // `autoFocus` lands as the surface commits, which is before the dialog's own
    // initial-focus frame — the same ordering a consumer's own open-time focus has.
    render(
      <AppDialog isOpen={true} onClose={() => {}}>
        <AppDialog.Body>
          <button type="button">First</button>
          <input id="own-field" autoFocus />
        </AppDialog.Body>
      </AppDialog>
    );
    await act(() => vi.runAllTimersAsync());
    await act(() => vi.runAllTimersAsync());

    expect(document.activeElement?.id).toBe("own-field");
  });

  // A queue-driven dialog reopened before its exit finishes still has the last
  // request's button focused; that stale focus must not count as a choice.
  it("replaces focus left inside by the previous opening when it reopens mid-exit", async () => {
    const dialog = (isOpen: boolean) => (
      <AppDialog isOpen={isOpen} onClose={() => {}}>
        <AppDialog.Body>
          <button type="button">First</button>
          <button type="button">Second</button>
        </AppDialog.Body>
      </AppDialog>
    );
    const { rerender, getByText } = render(dialog(true));
    await act(() => vi.runAllTimersAsync());
    await act(() => vi.runAllTimersAsync());
    getByText("Second").focus();

    rerender(dialog(false));
    rerender(dialog(true));
    await act(() => vi.runAllTimersAsync());
    await act(() => vi.runAllTimersAsync());

    expect(document.activeElement?.textContent).toBe("First");
  });
});
