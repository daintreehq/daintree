/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const mockPlaySound = vi.hoisted(() => vi.fn());
const mockCancelSound = vi.hoisted(() => vi.fn());
const mockDispose = vi.hoisted(() => vi.fn());

vi.mock("@/services/WebAudioService", () => ({
  playSound: mockPlaySound,
  cancelSound: mockCancelSound,
  dispose: mockDispose,
}));

import { useSoundPlaybackListener } from "../useSoundPlaybackListener";

describe("useSoundPlaybackListener", () => {
  let triggerCallback: ((payload: { soundFile: string; detune?: number }) => void) | null = null;
  let cancelCallback: (() => void) | null = null;
  const cleanupTrigger = vi.fn();
  const cleanupCancel = vi.fn();

  beforeEach(() => {
    triggerCallback = null;
    cancelCallback = null;
    cleanupTrigger.mockClear();
    cleanupCancel.mockClear();
    mockPlaySound.mockClear();
    mockCancelSound.mockClear();
    mockDispose.mockClear();

    window.electron = {
      sound: {
        onTrigger: vi.fn((cb: (payload: { soundFile: string; detune?: number }) => void) => {
          triggerCallback = cb;
          return cleanupTrigger;
        }),
        onCancel: vi.fn((cb: () => void) => {
          cancelCallback = cb;
          return cleanupCancel;
        }),
        getSoundDir: vi.fn().mockResolvedValue("/sounds"),
      },
    } as unknown as typeof window.electron;
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
  });

  it("subscribes to sound events on mount", () => {
    renderHook(() => useSoundPlaybackListener());

    expect(window.electron.sound.onTrigger).toHaveBeenCalledTimes(1);
    expect(window.electron.sound.onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls playSound when trigger event fires", () => {
    renderHook(() => useSoundPlaybackListener());
    triggerCallback!({ soundFile: "chime.wav" });

    expect(mockPlaySound).toHaveBeenCalledWith("chime.wav", undefined);
  });

  it("forwards detune from the trigger payload to playSound", () => {
    renderHook(() => useSoundPlaybackListener());
    triggerCallback!({ soundFile: "pulse.wav", detune: 9 });

    expect(mockPlaySound).toHaveBeenCalledWith("pulse.wav", 9);
  });

  it("forwards explicit detune of 0 (does not coerce to undefined)", () => {
    renderHook(() => useSoundPlaybackListener());
    triggerCallback!({ soundFile: "pulse.wav", detune: 0 });

    expect(mockPlaySound).toHaveBeenCalledWith("pulse.wav", 0);
  });

  it("calls cancelSound when cancel event fires", () => {
    renderHook(() => useSoundPlaybackListener());
    cancelCallback!();

    expect(mockCancelSound).toHaveBeenCalled();
  });

  it("cleans up and disposes on unmount", () => {
    const { unmount } = renderHook(() => useSoundPlaybackListener());
    unmount();

    expect(cleanupTrigger).toHaveBeenCalled();
    expect(cleanupCancel).toHaveBeenCalled();
    expect(mockDispose).toHaveBeenCalled();
  });
});
