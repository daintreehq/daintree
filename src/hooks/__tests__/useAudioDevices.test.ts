// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAudioDevices, __resetForTesting, SYSTEM_DEFAULT_VALUE } from "@/hooks/useAudioDevices";

const SYSTEM_DEFAULT = { value: SYSTEM_DEFAULT_VALUE, label: "System default" };

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

  it("filters out non-audioinput devices", async () => {
    enumerateSpy.mockResolvedValue([
      { deviceId: "usb", kind: "audioinput", label: "USB Mic" },
      { deviceId: "webcam", kind: "videoinput", label: "Webcam" },
      { deviceId: "speaker", kind: "audiooutput", label: "Speakers" },
    ]);

    const { result } = renderHook(() => useAudioDevices());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.devices).toHaveLength(2);
    expect(result.current.devices[0]).toMatchObject(SYSTEM_DEFAULT);
    expect(result.current.devices[1]).toEqual({ value: "usb", label: "USB Mic" });
  });

  it("says System default follows the system input", async () => {
    const { result } = renderHook(() => useAudioDevices());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.devices[0]!.description).toMatch(/system input/);
  });

  it("drops Chromium's alias entries but keeps every real mic", async () => {
    enumerateSpy.mockResolvedValue([
      { deviceId: "default", kind: "audioinput", label: "Default - MacBook Pro Microphone" },
      { deviceId: "communications", kind: "audioinput", label: "Communications - Headset" },
      { deviceId: "builtin", kind: "audioinput", label: "MacBook Pro Microphone" },
      { deviceId: "virtual-1", kind: "audioinput", label: "Loopback Audio" },
      { deviceId: "virtual-2", kind: "audioinput", label: "Loopback Audio" },
    ]);

    const { result } = renderHook(() => useAudioDevices());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.devices.map((device) => device.value)).toEqual([
      SYSTEM_DEFAULT_VALUE,
      "builtin",
      "virtual-1",
      "virtual-2",
    ]);
    expect(result.current.complete).toBe(true);
  });

  it("isn't complete while devices come back unnamed, before permission", async () => {
    enumerateSpy.mockResolvedValue([
      { deviceId: "", kind: "audioinput", label: "" },
      { deviceId: "", kind: "audioinput", label: "" },
    ]);

    const { result } = renderHook(() => useAudioDevices());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.devices).toEqual([expect.objectContaining(SYSTEM_DEFAULT)]);
    expect(result.current.complete).toBe(false);
  });

  it("assigns fallback labels to unlabeled devices", async () => {
    enumerateSpy.mockResolvedValue([
      { deviceId: "a", kind: "audioinput", label: "" },
      { deviceId: "b", kind: "audioinput", label: "" },
    ]);

    const { result } = renderHook(() => useAudioDevices());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.devices).toEqual([
      expect.objectContaining(SYSTEM_DEFAULT),
      { value: "a", label: "Microphone 1" },
      { value: "b", label: "Microphone 2" },
    ]);
  });

  it("handles enumerateDevices rejection gracefully", async () => {
    enumerateSpy.mockRejectedValue(new Error("Not allowed"));

    const { result } = renderHook(() => useAudioDevices());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.devices).toEqual([expect.objectContaining(SYSTEM_DEFAULT)]);
    expect(result.current.error).toContain("Could not enumerate audio devices");
    expect(result.current.complete).toBe(false);
  });

  it("handles missing mediaDevices API", async () => {
    vi.stubGlobal("navigator", {});

    const { result } = renderHook(() => useAudioDevices());

    expect(result.current.loading).toBe(false);
    expect(result.current.devices).toEqual([expect.objectContaining(SYSTEM_DEFAULT)]);
    expect(result.current.error).toContain("Media devices API not available");
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
