import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockImage {
  isEmpty: () => boolean;
  toPNG: () => Buffer;
  getSize: () => { width: number; height: number };
}

interface MockGuest {
  isDestroyed: () => boolean;
  getURL: () => string;
  capturePage: () => Promise<MockImage>;
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
    isDestroyed: () => false,
    getURL: () => "https://example.com",
    capturePage: async () => makeImage(),
    ...overrides,
  };
}

async function getCapture() {
  const { webviewCaptureNamespace } = await import("../webviewCapture.js");
  return webviewCaptureNamespace.ops.captureScreenshot.handler as (
    panelId: string
  ) => Promise<{ pngBase64: string; width: number; height: number }>;
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
});
