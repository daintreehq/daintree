import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_PANEL_CAPTURE_MAX_PNG_BYTES } from "../../../../shared/types/pluginPanelCapture.js";

const consoleBuffer = vi.hoisted(() => ({ entries: [] as unknown[] }));

vi.mock("../../../window/rendererConsoleCapture.js", () => ({
  getRecentPluginConsoleMessages: () => consoleBuffer.entries,
}));

interface MockImage {
  isEmpty: () => boolean;
  toPNG: () => Buffer;
}

function makeImage(png = Buffer.from("PNGDATA")): MockImage {
  return { isEmpty: () => false, toPNG: () => png };
}

function makeSender(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    isDestroyed: () => false,
    getZoomFactor: () => 1,
    capturePage: vi.fn(async (_rect: Electron.Rectangle) => makeImage()),
    ...overrides,
  };
}

type Sender = ReturnType<typeof makeSender>;

function makeRegistry(options: {
  sender: Sender;
  activeId?: number;
  bridged?: boolean;
  minimized?: boolean;
  visible?: boolean;
  viewBounds?: { width: number; height: number };
  noPvm?: boolean;
}) {
  const win = {
    isDestroyed: () => false,
    isMinimized: () => options.minimized === true,
    isVisible: () => options.visible !== false,
  };
  const activeView = {
    webContents: { id: options.activeId ?? options.sender.id },
    getBounds: () => ({ x: 0, y: 0, ...(options.viewBounds ?? { width: 1200, height: 800 }) }),
  };
  const projectViewManager = options.noPvm
    ? undefined
    : { getActiveView: () => activeView, isSwitchBridged: () => options.bridged === true };
  return {
    getByWebContentsId: (id: number) =>
      id === options.sender.id
        ? { browserWindow: win, services: { projectViewManager } }
        : undefined,
  };
}

async function setup(registry: ReturnType<typeof makeRegistry> | undefined) {
  vi.resetModules();
  const mod = await import("../pluginPanelCapture.js");
  // Registration stores the registry the handler resolves windows through.
  const register = vi.spyOn(mod.pluginPanelCaptureNamespace, "register").mockReturnValue(() => {});
  mod.registerPluginPanelCaptureHandlers({ windowRegistry: registry } as never);
  register.mockRestore();
  const handler = mod.pluginPanelCaptureNamespace.ops.capturePanel.handler as (
    ctx: unknown,
    rect: unknown
  ) => Promise<{ pngBase64: string; consoleMessages: unknown[] }>;
  return (sender: Sender | null, rect: unknown) =>
    handler({ event: sender ? { sender } : null, webContentsId: sender?.id ?? -1 }, rect);
}

const RECT = { x: 10.4, y: 20.6, width: 300.2, height: 200 };

describe("plugin:capture-panel", () => {
  beforeEach(() => {
    consoleBuffer.entries = [];
  });

  it("captures the asking view at the panel's rect, pulled in to whole pixels", async () => {
    const sender = makeSender(5);
    consoleBuffer.entries = [{ level: "error", message: "boom" }];
    const capture = await setup(makeRegistry({ sender }));

    const result = await capture(sender, RECT);

    expect(sender.capturePage).toHaveBeenCalledWith({ x: 11, y: 21, width: 299, height: 199 });
    expect(result).toEqual({
      pngBase64: Buffer.from("PNGDATA").toString("base64"),
      consoleMessages: [{ level: "error", message: "boom" }],
    });
  });

  it("scales by the view's zoom and stays inside the view", async () => {
    const sender = makeSender(5, { getZoomFactor: () => 2 });
    const capture = await setup(makeRegistry({ sender, viewBounds: { width: 500, height: 300 } }));

    await capture(sender, { x: 100, y: 50, width: 400, height: 400 });

    expect(sender.capturePage).toHaveBeenCalledWith({ x: 200, y: 100, width: 300, height: 200 });
  });

  it("refuses a call with no local sender", async () => {
    const sender = makeSender(5);
    const capture = await setup(makeRegistry({ sender }));
    await expect(capture(null, RECT)).rejects.toThrow(/local window/);
  });

  it.each([
    ["a cached project view", { activeId: 9 }, /not the one on screen/],
    ["a switch in flight", { bridged: true }, /not the one on screen/],
    ["a minimized window", { minimized: true }, /hidden/],
    ["a hidden window", { visible: false }, /hidden/],
  ])("refuses %s without capturing", async (_label, options, message) => {
    const sender = makeSender(5);
    const capture = await setup(makeRegistry({ sender, ...options }));

    await expect(capture(sender, RECT)).rejects.toThrow(message);
    expect(sender.capturePage).not.toHaveBeenCalled();
  });

  it("refuses a sender no window owns", async () => {
    const sender = makeSender(5);
    const other = makeSender(6);
    const capture = await setup(makeRegistry({ sender }));
    await expect(capture(other, RECT)).rejects.toThrow(/window is not available/);
  });

  it.each([
    ["non-finite bounds", { x: Number.NaN, y: 0, width: 10, height: 10 }, /Invalid/],
    ["a missing rect", undefined, /Invalid/],
    ["an empty rect", { x: 0, y: 0, width: 0, height: 10 }, /no visible area/],
    ["a rect past the view", { x: 5000, y: 0, width: 10, height: 10 }, /no visible area/],
  ])("refuses %s", async (_label, rect, message) => {
    const sender = makeSender(5);
    const capture = await setup(makeRegistry({ sender }));
    await expect(capture(sender, rect)).rejects.toThrow(message);
    expect(sender.capturePage).not.toHaveBeenCalled();
  });

  it("refuses an empty image and one over the size cap", async () => {
    const empty = makeSender(5, {
      capturePage: vi.fn(async () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) })),
    });
    let capture = await setup(makeRegistry({ sender: empty }));
    await expect(capture(empty, RECT)).rejects.toThrow(/empty image/);

    const huge = makeSender(5, {
      capturePage: vi.fn(async () =>
        makeImage(Buffer.alloc(PLUGIN_PANEL_CAPTURE_MAX_PNG_BYTES + 1))
      ),
    });
    capture = await setup(makeRegistry({ sender: huge }));
    await expect(capture(huge, RECT)).rejects.toThrow(/too large/);
  });

  it("normalizes a capture that fails mid-flight", async () => {
    const sender = makeSender(5, {
      capturePage: vi.fn(async () => {
        throw new Error("Object has been destroyed");
      }),
    });
    const capture = await setup(makeRegistry({ sender }));
    await expect(capture(sender, RECT)).rejects.toThrow(/became unavailable/);
  });

  it("captures without a view manager, inside the rect alone", async () => {
    const sender = makeSender(5);
    const capture = await setup(makeRegistry({ sender, noPvm: true }));
    await capture(sender, { x: 0, y: 0, width: 50, height: 40 });
    expect(sender.capturePage).toHaveBeenCalledWith({ x: 0, y: 0, width: 50, height: 40 });
  });
});
