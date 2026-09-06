import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyDevPreviewEmulation, buildEmulationParams } from "../viewportEmulation";

describe("buildEmulationParams", () => {
  it("returns null when no preset is active", () => {
    expect(buildEmulationParams(undefined, false, 1)).toBeNull();
  });

  it("builds iPhone portrait params", () => {
    const params = buildEmulationParams("iphone", false, 2);
    expect(params).not.toBeNull();
    expect(params!.screenPosition).toBe("mobile");
    expect(params!.screenSize).toEqual({ width: 393, height: 852 });
    expect(params!.viewSize).toEqual({ width: 393, height: 852 });
    expect(params!.viewPosition).toEqual({ x: 0, y: 0 });
    expect(params!.deviceScaleFactor).toBe(2);
    expect(params!.scale).toBe(1);
  });

  it("builds iPhone landscape params with rotated=true", () => {
    const params = buildEmulationParams("iphone", true, 3);
    expect(params!.screenSize).toEqual({ width: 852, height: 393 });
    expect(params!.viewSize).toEqual({ width: 852, height: 393 });
    expect(params!.deviceScaleFactor).toBe(3);
  });

  it("builds Galaxy S26 portrait params", () => {
    const params = buildEmulationParams("galaxy", false, 1);
    expect(params!.screenSize).toEqual({ width: 360, height: 780 });
    expect(params!.viewSize).toEqual({ width: 360, height: 780 });
  });

  it('builds iPad Air 11" params', () => {
    const params = buildEmulationParams("ipad", false, 1);
    expect(params!.screenSize).toEqual({ width: 820, height: 1180 });
  });
});

describe("applyDevPreviewEmulation", () => {
  const setDeviceEmulation = vi.fn<(payload: unknown) => Promise<void>>(() => Promise.resolve());

  function makeWebview(webContentsId = 42): Electron.WebviewTag {
    return {
      getWebContentsId: vi.fn(() => webContentsId),
    } as unknown as Electron.WebviewTag;
  }

  beforeEach(() => {
    setDeviceEmulation.mockClear();
    (globalThis as unknown as { window: { electron: unknown } }).window = {
      electron: { webview: { setDeviceEmulation } },
    } as never;
  });

  it("sends the preset metrics, spoofed UA and touch flag keyed by guest id", async () => {
    await applyDevPreviewEmulation(makeWebview(7), "panel-1", "pixel", false, 2);

    expect(setDeviceEmulation).toHaveBeenCalledWith({
      webContentsId: 7,
      panelId: "panel-1",
      emulation: {
        params: {
          screenPosition: "mobile",
          screenSize: { width: 412, height: 923 },
          viewPosition: { x: 0, y: 0 },
          deviceScaleFactor: 2,
          viewSize: { width: 412, height: 923 },
          scale: 1,
        },
        userAgent: expect.stringContaining("Pixel 10"),
        touch: true,
      },
    });
  });

  it("sends a null payload to restore desktop", async () => {
    await applyDevPreviewEmulation(makeWebview(7), "panel-1", undefined, false, 1);

    expect(setDeviceEmulation).toHaveBeenCalledWith({
      webContentsId: 7,
      panelId: "panel-1",
      emulation: null,
    });
  });

  it("propagates a detached webview synchronously instead of invoking IPC", () => {
    const detached = {
      getWebContentsId: vi.fn(() => {
        throw new Error("The WebView must be attached to the DOM");
      }),
    } as unknown as Electron.WebviewTag;

    expect(() => applyDevPreviewEmulation(detached, "panel-1", "iphone", false, 1)).toThrow();
    expect(setDeviceEmulation).not.toHaveBeenCalled();
  });
});
