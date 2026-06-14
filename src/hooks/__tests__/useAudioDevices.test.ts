// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAudioDevices, __resetForTesting, SYSTEM_DEFAULT_VALUE } from "@/hooks/useAudioDevices";

describe("useAudioDevices", () => {
  let enumerateSpy: ReturnType<typeof vi.fn>;
  let addEventListenerSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetForTesting();
    enumerateSpy = vi.fn().mockResolvedValue([]);
    addEventListenerSpy = vi.fn();

    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: enumerateSpy,
        addEventListener: addEventListenerSpy,
        removeEventListener: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns system default as first option", async () => {
    enumerateSpy.mockResolvedValue([
      { deviceId: "mic1", kind: "audioinput", label: "Built-in Mic" },
      { deviceId: "cam1", kind: "videoinput", label: "Camera" },
    ]);

    const { result } = renderHook(() => useAudioDevices());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.devices).toEqual([
      { value: SYSTEM_DEFAULT_VALUE, label: "System default" },
      { value: "mic1", label: "Built-in Mic" },
    ]);
    expect(result.current.error).toBeNull();
  });

  it("filters out non-audioinput devices", async () => {
    enumerateSpy.mockResolvedValue([
      { deviceId: "default", kind: "audioinput", label: "Default" },
      { deviceId: "webcam", kind: "videoinput", label: "Webcam" },
      { deviceId: "speaker", kind: "audiooutput", label: "Speakers" },
    ]);

    const { result } = renderHook(() => useAudioDevices());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.devices).toHaveLength(2);
    expect(result.current.devices[0]).toEqual({
      value: SYSTEM_DEFAULT_VALUE,
      label: "System default",
    });
    expect(result.current.devices[1]).toEqual({ value: "default", label: "Default" });
  });

  it("assigns fallback labels to unlabeled devices", async () => {
    enumerateSpy.mockResolvedValue([
      { deviceId: "a", kind: "audioinput", label: "" },
      { deviceId: "b", kind: "audioinput", label: "" },
    ]);

    const { result } = renderHook(() => useAudioDevices());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.devices).toEqual([
      { value: SYSTEM_DEFAULT_VALUE, label: "System default" },
      { value: "a", label: "Microphone 1" },
      { value: "b", label: "Microphone 2" },
    ]);
  });

  it("handles enumerateDevices rejection gracefully", async () => {
    enumerateSpy.mockRejectedValue(new Error("Not allowed"));

    const { result } = renderHook(() => useAudioDevices());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.devices).toEqual([
      { value: SYSTEM_DEFAULT_VALUE, label: "System default" },
    ]);
    expect(result.current.error).toContain("Could not enumerate audio devices");
  });

  it("handles missing mediaDevices API", async () => {
    vi.stubGlobal("navigator", {});

    const { result } = renderHook(() => useAudioDevices());

    expect(result.current.loading).toBe(false);
    expect(result.current.devices).toEqual([
      { value: SYSTEM_DEFAULT_VALUE, label: "System default" },
    ]);
    expect(result.current.error).toContain("Media devices API not available");
  });

  it("subscribes to devicechange event on mount", async () => {
    enumerateSpy.mockResolvedValue([]);

    renderHook(() => useAudioDevices());

    expect(addEventListenerSpy).toHaveBeenCalledWith("devicechange", expect.any(Function));
    await waitFor(() => expect(enumerateSpy).toHaveBeenCalled());
  });

  it("re-enumerates when devicechange fires", async () => {
    enumerateSpy.mockResolvedValue([{ deviceId: "mic1", kind: "audioinput", label: "Mic 1" }]);

    renderHook(() => useAudioDevices());
    await waitFor(() => expect(enumerateSpy).toHaveBeenCalledTimes(1));

    const deviceChangeHandler = addEventListenerSpy.mock.calls[0]?.[1] as () => void;

    enumerateSpy.mockClear();
    enumerateSpy.mockResolvedValue([
      { deviceId: "mic1", kind: "audioinput", label: "Mic 1" },
      { deviceId: "mic2", kind: "audioinput", label: "USB Mic" },
    ]);

    act(() => {
      deviceChangeHandler();
    });

    await waitFor(() => expect(enumerateSpy).toHaveBeenCalledTimes(1));
  });

  it("does not accumulate devicechange listeners across remount cycles", async () => {
    enumerateSpy.mockResolvedValue([]);

    const first = renderHook(() => useAudioDevices());
    await waitFor(() => expect(enumerateSpy).toHaveBeenCalledTimes(1));
    first.unmount();

    const second = renderHook(() => useAudioDevices());
    expect(addEventListenerSpy).toHaveBeenCalledTimes(1);

    const deviceChangeHandler = addEventListenerSpy.mock.calls[0]?.[1] as () => void;
    enumerateSpy.mockClear();
    act(() => {
      deviceChangeHandler();
    });

    await waitFor(() => expect(enumerateSpy).toHaveBeenCalledTimes(1));
    expect(enumerateSpy).toHaveBeenCalledTimes(1);
    second.unmount();
  });

  it("re-enumerates on manual refresh() call", async () => {
    enumerateSpy.mockResolvedValue([{ deviceId: "mic1", kind: "audioinput", label: "Mic 1" }]);

    const { result } = renderHook(() => useAudioDevices());
    await waitFor(() => expect(result.current.loading).toBe(false));

    enumerateSpy.mockClear();
    enumerateSpy.mockResolvedValue([
      { deviceId: "mic1", kind: "audioinput", label: "Mic 1" },
      { deviceId: "mic2", kind: "audioinput", label: "USB Mic" },
    ]);

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(enumerateSpy).toHaveBeenCalledTimes(1);
    expect(result.current.devices).toHaveLength(3);
  });
});
