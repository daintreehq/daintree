// @vitest-environment jsdom
// Issue #8942 — the announcer cleared its live region then set the new text on
// a setTimeout(0). Chromium 146 can coalesce both DOM writes into one frame,
// dropping the intermediate empty state the screen reader needs to detect a
// change. The fix sets the new text inside requestAnimationFrame (a pre-paint
// boundary) so the cleared state commits first.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
import { VoiceRecordingAnnouncer } from "../VoiceRecordingAnnouncer";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

// Controllable rAF: callbacks queue by id; flushFrame() runs and clears them.
let rafCallbacks: Map<number, FrameRequestCallback>;
let nextRafId: number;

function flushFrame() {
  const pending = Array.from(rafCallbacks.entries());
  rafCallbacks = new Map();
  act(() => {
    for (const [, cb] of pending) cb(performance.now());
  });
}

const liveRegion = () => document.querySelector('[role="status"]') as HTMLElement | null;

describe("VoiceRecordingAnnouncer rAF clear-then-set — issue #8942", () => {
  beforeEach(() => {
    rafCallbacks = new Map();
    nextRafId = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      rafCallbacks.delete(id);
    });
    useVoiceRecordingStore.setState({ announcement: null });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useVoiceRecordingStore.setState({ announcement: null });
  });

  it("clears synchronously and defers the new text to the next animation frame", () => {
    render(<VoiceRecordingAnnouncer />);

    act(() => {
      useVoiceRecordingStore.getState().announce("Recording started");
    });

    // Before the frame fires, the region is cleared, not yet set.
    expect(liveRegion()?.textContent).toBe("");
    expect(rafCallbacks.size).toBe(1);

    flushFrame();
    expect(liveRegion()?.textContent).toBe("Recording started");
  });

  it("cancels a stale frame so only the latest announcement lands", () => {
    render(<VoiceRecordingAnnouncer />);

    act(() => {
      useVoiceRecordingStore.getState().announce("First");
    });
    act(() => {
      useVoiceRecordingStore.getState().announce("Second");
    });

    flushFrame();
    expect(liveRegion()?.textContent).toBe("Second");
  });

  it("does not mutate after unmount when the frame was pending", () => {
    const { unmount } = render(<VoiceRecordingAnnouncer />);

    act(() => {
      useVoiceRecordingStore.getState().announce("Pending");
    });
    expect(rafCallbacks.size).toBe(1);

    unmount();
    // Cleanup must have cancelled the pending frame.
    expect(rafCallbacks.size).toBe(0);
  });

  it("clears the region without scheduling a frame when announcement is empty", () => {
    render(<VoiceRecordingAnnouncer />);

    act(() => {
      useVoiceRecordingStore.getState().announce("Something");
    });
    flushFrame();
    expect(liveRegion()?.textContent).toBe("Something");

    act(() => {
      useVoiceRecordingStore.setState({ announcement: null });
    });
    expect(liveRegion()?.textContent).toBe("");
    expect(rafCallbacks.size).toBe(0);
  });
});
