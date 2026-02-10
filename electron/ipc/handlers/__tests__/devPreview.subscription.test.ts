import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

const scanOutputMock = vi.fn();

vi.mock("../../../services/UrlDetector.js", () => ({
  UrlDetector: class MockUrlDetector {
    scanOutput = scanOutputMock;
  },
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { registerDevPreviewHandlers } from "../devPreview.js";
import type { HandlerDependencies } from "../../types.js";

type DataListener = (id: string, data: string | Uint8Array) => void;

function createMockPtyClient() {
  const listeners = new Set<DataListener>();
  return {
    on: vi.fn((event: string, callback: DataListener) => {
      if (event === "data") {
        listeners.add(callback);
      }
    }),
    off: vi.fn((event: string, callback: DataListener) => {
      if (event === "data") {
        listeners.delete(callback);
      }
    }),
    setIpcDataMirror: vi.fn(),
    emitData: (id: string, data: string) => {
      for (const listener of listeners) {
        listener(id, data);
      }
    },
  };
}

describe("dev preview subscription handlers", () => {
  let cleanup: () => void = () => {};
  let ptyClient: ReturnType<typeof createMockPtyClient>;
  let send: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    scanOutputMock.mockReset();

    ptyClient = createMockPtyClient();
    send = vi.fn();

    const deps = {
      ptyClient: ptyClient as unknown as HandlerDependencies["ptyClient"],
      mainWindow: {
        webContents: {
          isDestroyed: () => false,
          send,
        },
        isDestroyed: () => false,
      },
    } as unknown as HandlerDependencies;

    cleanup = registerDevPreviewHandlers(deps);
  });

  afterEach(() => {
    cleanup();
  });

  function getRegisteredHandle(
    channel: string
  ): ((...args: unknown[]) => Promise<void>) | undefined {
    const calls = (ipcMain.handle as Mock).mock.calls;
    const call = calls.find(([ch]) => ch === channel);
    return call?.[1] as ((...args: unknown[]) => Promise<void>) | undefined;
  }

  it("re-subscribe resets dedupe state and re-emits same URL", async () => {
    const subscribeHandler = getRegisteredHandle(CHANNELS.DEV_PREVIEW_SUBSCRIBE);
    expect(subscribeHandler).toBeDefined();

    scanOutputMock.mockReturnValue({ buffer: "", url: "http://localhost:5173/", error: null });

    await subscribeHandler!({} as Electron.IpcMainInvokeEvent, "dev-preview-1");
    ptyClient.emitData("dev-preview-1", "first");

    await subscribeHandler!({} as Electron.IpcMainInvokeEvent, "dev-preview-1");
    ptyClient.emitData("dev-preview-1", "second");

    expect(send).toHaveBeenNthCalledWith(1, CHANNELS.DEV_PREVIEW_URL_DETECTED, {
      terminalId: "dev-preview-1",
      url: "http://localhost:5173/",
      worktreeId: undefined,
    });
    expect(send).toHaveBeenNthCalledWith(2, CHANNELS.DEV_PREVIEW_URL_DETECTED, {
      terminalId: "dev-preview-1",
      url: "http://localhost:5173/",
      worktreeId: undefined,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe is idempotent and disables IPC mirroring for unknown IDs", async () => {
    const unsubscribeHandler = getRegisteredHandle(CHANNELS.DEV_PREVIEW_UNSUBSCRIBE);
    expect(unsubscribeHandler).toBeDefined();

    await unsubscribeHandler!({} as Electron.IpcMainInvokeEvent, "missing-terminal");

    expect(ptyClient.setIpcDataMirror).toHaveBeenCalledWith("missing-terminal", false);
  });
});
