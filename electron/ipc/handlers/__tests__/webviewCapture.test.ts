import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockImage {
  isEmpty: () => boolean;
  toPNG: () => Buffer;
  getSize: () => { width: number; height: number };
}

interface MockGuest {
  hostWebContents?: { id: number; isDestroyed: () => boolean };
  isDestroyed: () => boolean;
  getURL: () => string;
  capturePage: () => Promise<MockImage>;
  session?: { resolveHost: (host: string) => Promise<{ endpoints: Array<{ address: string }> }> };
}

const guestRegistry = vi.hoisted(() => new Map<number, MockGuest>());
const dialogService = vi.hoisted(() => ({
  getWebContentsId: vi.fn<(panelId: string) => number | undefined>(),
}));

vi.mock("electron", () => ({
  webContents: {
    fromId: vi.fn((webContentsId: number) => guestRegistry.get(webContentsId)),
  },
}));

vi.mock("../../../services/WebviewDialogService.js", () => ({
  getWebviewDialogService: () => dialogService,
}));

function makeImage(overrides: Partial<MockImage> = {}): MockImage {
  return {
    isEmpty: () => false,
    toPNG: () => Buffer.from("PNGDATA"),
    getSize: () => ({ width: 800, height: 600 }),
    ...overrides,
  };
}

function makeGuest(overrides: Partial<MockGuest> = {}): MockGuest {
  return {
    hostWebContents: { id: SENDER_VIEW, isDestroyed: () => false },
    isDestroyed: () => false,
    getURL: () => "https://example.com",
    capturePage: async () => makeImage(),
    ...overrides,
  };
}

const SENDER_VIEW = 5;

async function getCapture() {
  const { webviewCaptureNamespace } = await import("../webviewCapture.js");
  const handler = webviewCaptureNamespace.ops.captureScreenshot.handler as (
    ctx: { webContentsId: number },
    panelId: string,
    options?: { forHost?: boolean }
  ) => Promise<{ pngBase64: string; width: number; height: number }>;
  return (panelId: string, sender = SENDER_VIEW, options?: { forHost?: boolean }) =>
    handler({ webContentsId: sender }, panelId, options);
}

describe("webviewCapture handler", () => {
  beforeEach(() => {
    vi.resetModules();
    guestRegistry.clear();
    dialogService.getWebContentsId.mockReset();
  });

  it("returns base64 PNG bytes and dimensions for a live panel", async () => {
    dialogService.getWebContentsId.mockReturnValue(7);
    guestRegistry.set(7, makeGuest());

    const capture = await getCapture();
    const result = await capture("panel-a");

    expect(result).toEqual({
      pngBase64: Buffer.from("PNGDATA").toString("base64"),
      width: 800,
      height: 600,
    });
  });

  it("refuses a panel another view embeds, without capturing it", async () => {
    const capturePage = vi.fn(async () => makeImage());
    dialogService.getWebContentsId.mockReturnValue(7);
    guestRegistry.set(7, makeGuest({ capturePage }));

    const capture = await getCapture();
    await expect(capture("panel-a", SENDER_VIEW + 1)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    guestRegistry.set(7, makeGuest({ capturePage, hostWebContents: undefined }));
    await expect(capture("panel-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(capturePage).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND when no panel resolves to a webContents", async () => {
    dialogService.getWebContentsId.mockReturnValue(undefined);

    const capture = await getCapture();
    await expect(capture("panel-missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws NOT_FOUND when the resolved webContents is destroyed", async () => {
    dialogService.getWebContentsId.mockReturnValue(7);
    guestRegistry.set(7, makeGuest({ isDestroyed: () => true }));

    const capture = await getCapture();
    await expect(capture("panel-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws UNSUPPORTED when the page is about:blank", async () => {
    dialogService.getWebContentsId.mockReturnValue(7);
    guestRegistry.set(7, makeGuest({ getURL: () => "about:blank" }));

    const capture = await getCapture();
    await expect(capture("panel-a")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("throws INTERNAL when capturePage returns an empty image", async () => {
    dialogService.getWebContentsId.mockReturnValue(7);
    guestRegistry.set(
      7,
      makeGuest({ capturePage: async () => makeImage({ isEmpty: () => true }) })
    );

    const capture = await getCapture();
    await expect(capture("panel-a")).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("normalizes a capturePage rejection (TOCTOU teardown) to NOT_FOUND", async () => {
    dialogService.getWebContentsId.mockReturnValue(7);
    guestRegistry.set(
      7,
      makeGuest({
        capturePage: async () => {
          throw new Error("Object has been destroyed");
        },
      })
    );

    const capture = await getCapture();
    await expect(capture("panel-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("never hands a host a capture of a page on this computer's own network, or one that loaded from it", async () => {
    const gate = await import("../../../window/webviewSrcGate.js");
    const dispose = gate.setRemoteWebviewSrcGate(
      (view, src) => (view === SENDER_VIEW ? src.startsWith("http://localhost:5173/") : null),
      (view) => view === SENDER_VIEW
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let listener: ((details: unknown, cb: (r: { cancel?: boolean }) => void) => void) | null =
        null;
      const resolveHost = async (host: string) => ({
        endpoints: [{ address: host === "router.lan" ? "192.168.1.1" : "93.184.216.34" }],
      });
      const session = {
        resolveHost,
        webRequest: { onBeforeRequest: (_f: unknown, next: typeof listener) => (listener = next) },
      };
      gate.guardRemoteGuestRequests(SENDER_VIEW, { session: session as never });
      let url = "";
      /** The guest goes somewhere, or loads something, through its guarded session. */
      const load = (target: string, resourceType = "mainFrame", frameUrl?: string) =>
        new Promise<void>((done) =>
          listener!(
            {
              url: target,
              resourceType,
              webContentsId: 7,
              webContents: {
                id: 7,
                hostWebContents: { id: SENDER_VIEW },
                once: () => {},
                removeListener: () => {},
              },
              frame: frameUrl ? { url: frameUrl } : null,
            },
            (r) => {
              if (resourceType === "mainFrame" && r.cancel !== true) url = target;
              done();
            }
          )
        );
      let duringCapture: (() => Promise<void>) | null = null;
      const capturePage = vi.fn(async () => {
        await duringCapture?.();
        return makeImage();
      });
      dialogService.getWebContentsId.mockReturnValue(7);
      guestRegistry.set(7, makeGuest({ capturePage, getURL: () => url, session }));
      const capture = await getCapture();
      const forHost = () => capture("panel-a", SENDER_VIEW, { forHost: true });

      await load("http://localhost:5173/");
      await expect(forHost()).resolves.toBeDefined();
      await load("https://example.com/");
      await expect(forHost()).resolves.toBeDefined();

      // A page that navigates while the pixels are taken is never what's handed over.
      duringCapture = () => load("https://example.com/next");
      await expect(forHost()).rejects.toMatchObject({ code: "PERMISSION" });
      duringCapture = null;

      // Once it has shown anything from this computer's network, never again for this guest.
      await load("http://router.lan/admin");
      await expect(forHost()).rejects.toMatchObject({ code: "PERMISSION" });
      await load("https://example.com/");
      await expect(forHost()).rejects.toMatchObject({ code: "PERMISSION" });

      // The person's own capture is as before.
      await expect(capture("panel-a")).resolves.toBeDefined();
    } finally {
      warn.mockRestore();
      dispose();
    }
  });

  it("refuses a host's capture of a guest whose page no guarded session recorded", async () => {
    const gate = await import("../../../window/webviewSrcGate.js");
    const dispose = gate.setRemoteWebviewSrcGate(
      () => null,
      (view) => view === SENDER_VIEW
    );
    try {
      const capturePage = vi.fn(async () => makeImage());
      dialogService.getWebContentsId.mockReturnValue(8);
      guestRegistry.set(8, makeGuest({ capturePage, getURL: () => "https://example.com/" }));
      const capture = await getCapture();
      await expect(capture("panel-b", SENDER_VIEW, { forHost: true })).rejects.toMatchObject({
        code: "PERMISSION",
      });
      expect(capturePage).not.toHaveBeenCalled();
      // In a window on this machine, forHost changes nothing.
      dispose();
      await expect(capture("panel-b", SENDER_VIEW, { forHost: true })).resolves.toBeDefined();
    } finally {
      dispose();
    }
  });
});
