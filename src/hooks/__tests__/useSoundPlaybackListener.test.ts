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

  it.each([9, 0])("forwards detune %s from the trigger payload to playSound", (detune) => {
    renderHook(() => useSoundPlaybackListener());
    triggerCallback!({ soundFile: "pulse.wav", detune });

    expect(mockPlaySound).toHaveBeenCalledWith("pulse.wav", detune);
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
