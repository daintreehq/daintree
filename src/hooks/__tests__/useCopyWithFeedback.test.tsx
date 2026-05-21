// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCopyWithFeedback } from "../useCopyWithFeedback";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { UI_ACTION_SUCCESS_DWELL_MS } from "@/lib/animationUtils";

describe("useCopyWithFeedback", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets copied=true and announces 'Copied' once on success", async () => {
    const { result } = renderHook(() => useCopyWithFeedback());
    await act(async () => {
      await result.current.copy("hello");
    });
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(result.current.copied).toBe(true);
    const polite = useAnnouncerStore.getState().polite;
    expect(polite?.msg).toBe("Copied");
  });

  it("resets copied=false after the dwell window", async () => {
    const { result } = renderHook(() => useCopyWithFeedback());
    await act(async () => {
      await result.current.copy("x");
    });
    expect(result.current.copied).toBe(true);
    act(() => {
      vi.advanceTimersByTime(UI_ACTION_SUCCESS_DWELL_MS);
    });
    expect(result.current.copied).toBe(false);
  });

  it("does not update state after unmount", async () => {
    const { result, unmount } = renderHook(() => useCopyWithFeedback());
    await act(async () => {
      await result.current.copy("x");
    });
    unmount();
    // No assertion error from setState-on-unmounted is the implicit pass.
    act(() => {
      vi.advanceTimersByTime(UI_ACTION_SUCCESS_DWELL_MS + 1000);
    });
  });

  it("restarts the dwell on a second click within the window", async () => {
    const { result } = renderHook(() => useCopyWithFeedback());
    await act(async () => {
      await result.current.copy("a");
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.copied).toBe(true);
    await act(async () => {
      await result.current.copy("b");
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    // 1500ms after second click → still inside fresh dwell.
    expect(result.current.copied).toBe(true);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current.copied).toBe(false);
  });

  it("returns false and stays silent when clipboard rejects", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    const { result } = renderHook(() => useCopyWithFeedback());
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.copy("x");
    });
    expect(ok).toBe(false);
    expect(result.current.copied).toBe(false);
    expect(useAnnouncerStore.getState().polite).toBeNull();
  });

  it("uses a custom announcement string when provided", async () => {
    const { result } = renderHook(() => useCopyWithFeedback({ announcement: "Path copied" }));
    await act(async () => {
      await result.current.copy("/home/foo");
    });
    expect(useAnnouncerStore.getState().polite?.msg).toBe("Path copied");
  });

  // Regression guard: the hook is a general-purpose clipboard primitive shared
  // by crash-report and stack-trace copy paths. Paste-jacking sanitization
  // belongs at the install-command boundary (CopyableCommand), not here —
  // stripping newlines from a multi-line crash report would mangle it.
  it("preserves newlines and tabs in multi-line content (does not sanitize)", async () => {
    const { result } = renderHook(() => useCopyWithFeedback());
    const crashReport = "## Crash Report\nDaintree 1.0.0\n\tstack:\n\t  at foo";
    await act(async () => {
      await result.current.copy(crashReport);
    });
    expect(writeText).toHaveBeenCalledWith(crashReport);
  });
});
