import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  isPackaged: true,
  getVersion: vi.fn(() => "1.0.0"),
}));

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const netMock = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

const broadcastMock = vi.hoisted(() => vi.fn());

const storeMock = vi.hoisted(() => ({
  get: vi.fn((_key: string): unknown => undefined),
  set: vi.fn(),
  delete: vi.fn(),
}));

const trustedRendererMock = vi.hoisted(() => ({
  isTrustedRendererUrl: vi.fn((url: string) => url.startsWith("app://daintree")),
}));

const distributionMock = vi.hoisted(() => ({
  isWindowsStoreBuild: vi.fn(() => true),
}));

const systemSleepMock = vi.hoisted(() => ({
  onSuspend: vi.fn(() => () => {}),
  onWake: vi.fn(() => () => {}),
}));

vi.mock("electron", () => ({
  app: appMock,
  ipcMain: ipcMainMock,
  net: netMock,
}));

vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: broadcastMock,
}));

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

vi.mock("../../../shared/utils/trustedRenderer.js", () => trustedRendererMock);

vi.mock("../../../shared/config/distribution.js", () => distributionMock);

vi.mock("../SystemSleepService.js", () => ({
  getSystemSleepService: () => systemSleepMock,
}));

import {
  windowsStoreNotifierService,
  buildStoreUrl,
  MS_STORE_FALLBACK_URL,
} from "../WindowsStoreNotifierService.js";
import { CHANNELS } from "../../ipc/channels.js";

function makeResponse(opts: { status?: number; body?: string; etag?: string | null }): {
  status: number;
  ok: boolean;
  headers: { get: (k: string) => string | null };
  text: () => Promise<string>;
} {
  const status = opts.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (k: string) => {
        if (k.toLowerCase() === "etag") return opts.etag ?? null;
        return null;
      },
    },
    text: async () => opts.body ?? "",
  };
}

describe("WindowsStoreNotifierService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    appMock.isPackaged = true;
    appMock.getVersion.mockReturnValue("1.0.0");
    distributionMock.isWindowsStoreBuild.mockReturnValue(true);
    storeMock.get.mockReset().mockImplementation((_key: string) => undefined);
    storeMock.set.mockReset();
    storeMock.delete.mockReset();
    netMock.fetch.mockReset();
    trustedRendererMock.isTrustedRendererUrl
      .mockReset()
      .mockImplementation((url: string) => url.startsWith("app://daintree"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    windowsStoreNotifierService.dispose();
  });

  afterEach(() => {
    windowsStoreNotifierService.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.DAINTREE_MICROSOFT_STORE_PRODUCT_ID;
  });

  describe("buildStoreUrl", () => {
    it("returns downloadsandupdates URL when product id is unset", () => {
      delete process.env.DAINTREE_MICROSOFT_STORE_PRODUCT_ID;
      expect(buildStoreUrl()).toBe(MS_STORE_FALLBACK_URL);
    });

    it("returns pdp URL with valid product id", () => {
      process.env.DAINTREE_MICROSOFT_STORE_PRODUCT_ID = "9NBLGGH4NNS1";
      expect(buildStoreUrl()).toBe("ms-windows-store://pdp/?ProductId=9NBLGGH4NNS1");
    });

    it("falls back when product id has wrong length or characters", () => {
      process.env.DAINTREE_MICROSOFT_STORE_PRODUCT_ID = "BAD";
      expect(buildStoreUrl()).toBe(MS_STORE_FALLBACK_URL);
      process.env.DAINTREE_MICROSOFT_STORE_PRODUCT_ID = "../../../escape";
      expect(buildStoreUrl()).toBe(MS_STORE_FALLBACK_URL);
    });
  });

  describe("initialize() guards", () => {
    it("registers IPC handlers but does not start polling on non-Store builds", () => {
      distributionMock.isWindowsStoreBuild.mockReturnValue(false);
      windowsStoreNotifierService.initialize();
      // Settings handlers register so the renderer doesn't see undefined.
      expect(ipcMainMock.handle).toHaveBeenCalledWith(
        CHANNELS.STORE_UPDATE_GET_SETTINGS,
        expect.any(Function)
      );
      expect(ipcMainMock.handle).toHaveBeenCalledWith(
        CHANNELS.STORE_UPDATE_GET_LATEST,
        expect.any(Function)
      );
      // No polling — advance well past the startup jitter window.
      vi.advanceTimersByTime(120_000);
      expect(netMock.fetch).not.toHaveBeenCalled();
    });

    it("does not poll when app is not packaged", () => {
      appMock.isPackaged = false;
      windowsStoreNotifierService.initialize();
      vi.advanceTimersByTime(120_000);
      expect(netMock.fetch).not.toHaveBeenCalled();
    });
  });

  describe("polling and broadcast", () => {
    it("broadcasts STORE_UPDATE_AVAILABLE when remote version is newer", async () => {
      netMock.fetch.mockResolvedValueOnce(
        makeResponse({ body: "version: 1.2.0\nfiles:\n  - url: foo\n", etag: '"abc"' })
      );
      windowsStoreNotifierService.initialize();
      await windowsStoreNotifierService._checkNowForTest();
      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.STORE_UPDATE_AVAILABLE, {
        version: "1.2.0",
        storeUrl: MS_STORE_FALLBACK_URL,
      });
      // Critical: ETag must NOT be persisted on the 200-OK path — only after
      // the renderer confirms via DISMISS. A mid-flight crash before dismiss
      // would otherwise let the next launch's 304 suppress the version forever.
      expect(storeMock.set).not.toHaveBeenCalledWith("storeNotifierEtag", '"abc"');
    });

    it("does not broadcast when the toggle flips off during the fetch", async () => {
      let enabled = true;
      storeMock.get.mockImplementation((key: string) => {
        if (key === "storeUpdateNotificationsEnabled") return enabled;
        return undefined;
      });
      netMock.fetch.mockImplementation(async () => {
        enabled = false;
        return makeResponse({ body: "version: 9.9.9\n", etag: null });
      });
      windowsStoreNotifierService.initialize();
      await windowsStoreNotifierService._checkNowForTest();
      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it("does not broadcast when remote version is equal or older", async () => {
      appMock.getVersion.mockReturnValue("2.0.0");
      netMock.fetch.mockResolvedValueOnce(makeResponse({ body: "version: 1.0.0\n", etag: null }));
      windowsStoreNotifierService.initialize();
      await windowsStoreNotifierService._checkNowForTest();
      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it.each([
      ["1.2.3-nightly.1", "1.2.3-nightly.2", true],
      ["1.2.3-nightly.1", "1.2.3", true],
      ["1.2.3", "1.2.3-nightly.2", false],
      ["1.2.3-nightly.2", "1.2.3-nightly.1", false],
      ["1.2.3-nightly.2", "1.2.3-nightly.2", false],
    ])("installed %s vs offered %s notifies=%s", async (installed, offered, notifies) => {
      appMock.getVersion.mockReturnValue(installed);
      netMock.fetch.mockResolvedValueOnce(
        makeResponse({ body: `version: ${offered}\n`, etag: null })
      );
      windowsStoreNotifierService.initialize();
      await windowsStoreNotifierService._checkNowForTest();
      expect(broadcastMock.mock.calls.length > 0).toBe(notifies);
    });

    it("suppresses re-broadcast when version equals lastNotifiedStoreVersion", async () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "lastNotifiedStoreVersion") return "1.5.0";
        return undefined;
      });
      netMock.fetch.mockResolvedValueOnce(makeResponse({ body: "version: 1.5.0\n", etag: null }));
      windowsStoreNotifierService.initialize();
      await windowsStoreNotifierService._checkNowForTest();
      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it("skips polling when storeUpdateNotificationsEnabled is false", async () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "storeUpdateNotificationsEnabled") return false;
        return undefined;
      });
      windowsStoreNotifierService.initialize();
      await windowsStoreNotifierService._checkNowForTest();
      expect(netMock.fetch).not.toHaveBeenCalled();
      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it("sends If-None-Match when an ETag is stored and skips broadcast on 304", async () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "storeNotifierEtag") return '"prev"';
        return undefined;
      });
      netMock.fetch.mockResolvedValueOnce(makeResponse({ status: 304 }));
      windowsStoreNotifierService.initialize();
      await windowsStoreNotifierService._checkNowForTest();
      const [, options] = netMock.fetch.mock.calls[0];
      expect(options.headers["If-None-Match"]).toBe('"prev"');
      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it("drops stored ETag when the channel switches", async () => {
      let channel = "stable" as "stable" | "nightly";
      storeMock.get.mockImplementation((key: string) => {
        if (key === "updateChannel") return channel;
        if (key === "storeNotifierEtag") return '"stale"';
        return undefined;
      });
      netMock.fetch.mockResolvedValue(makeResponse({ body: "version: 1.0.0\n", etag: null }));
      windowsStoreNotifierService.initialize();
      await windowsStoreNotifierService._checkNowForTest();
      expect(storeMock.delete).not.toHaveBeenCalledWith("storeNotifierEtag");
      channel = "nightly";
      await windowsStoreNotifierService._checkNowForTest();
      expect(storeMock.delete).toHaveBeenCalledWith("storeNotifierEtag");
    });

    it("ignores malformed version strings in the YAML payload", async () => {
      netMock.fetch.mockResolvedValueOnce(
        makeResponse({ body: "version: '../../etc/passwd'\n", etag: null })
      );
      windowsStoreNotifierService.initialize();
      await windowsStoreNotifierService._checkNowForTest();
      expect(broadcastMock).not.toHaveBeenCalled();
    });
  });

  describe("dismiss handler", () => {
    it("persists lastNotifiedStoreVersion for a valid semver from a trusted sender", () => {
      windowsStoreNotifierService.initialize();
      const dismissCall = ipcMainMock.handle.mock.calls.find(
        ([ch]) => ch === CHANNELS.STORE_UPDATE_DISMISS
      );
      expect(dismissCall).toBeDefined();
      const handler = dismissCall![1];
      handler({ senderFrame: { url: "app://daintree/index.html" } }, "1.2.3");
      expect(storeMock.set).toHaveBeenCalledWith("lastNotifiedStoreVersion", "1.2.3");
    });

    it("commits the pending ETag together with lastNotifiedStoreVersion", async () => {
      netMock.fetch.mockResolvedValueOnce(
        makeResponse({ body: "version: 1.2.0\n", etag: '"v1.2.0-etag"' })
      );
      windowsStoreNotifierService.initialize();
      await windowsStoreNotifierService._checkNowForTest();
      // ETag isn't persisted yet — pre-dismiss.
      expect(storeMock.set).not.toHaveBeenCalledWith("storeNotifierEtag", expect.any(String));
      const dismissCall = ipcMainMock.handle.mock.calls.find(
        ([ch]) => ch === CHANNELS.STORE_UPDATE_DISMISS
      );
      const handler = dismissCall![1];
      handler({ senderFrame: { url: "app://daintree/index.html" } }, "1.2.0");
      expect(storeMock.set).toHaveBeenCalledWith("lastNotifiedStoreVersion", "1.2.0");
      expect(storeMock.set).toHaveBeenCalledWith("storeNotifierEtag", '"v1.2.0-etag"');
    });

    it("does not commit a pending ETag when dismiss is for a different version", async () => {
      netMock.fetch.mockResolvedValueOnce(
        makeResponse({ body: "version: 1.2.0\n", etag: '"v1.2.0-etag"' })
      );
      windowsStoreNotifierService.initialize();
      await windowsStoreNotifierService._checkNowForTest();
      const dismissCall = ipcMainMock.handle.mock.calls.find(
        ([ch]) => ch === CHANNELS.STORE_UPDATE_DISMISS
      );
      const handler = dismissCall![1];
      handler({ senderFrame: { url: "app://daintree/index.html" } }, "9.9.9");
      expect(storeMock.set).toHaveBeenCalledWith("lastNotifiedStoreVersion", "9.9.9");
      expect(storeMock.set).not.toHaveBeenCalledWith("storeNotifierEtag", expect.any(String));
    });

    it("rejects untrusted senders", () => {
      windowsStoreNotifierService.initialize();
      const dismissCall = ipcMainMock.handle.mock.calls.find(
        ([ch]) => ch === CHANNELS.STORE_UPDATE_DISMISS
      );
      const handler = dismissCall![1];
      handler({ senderFrame: { url: "https://evil.example.com" } }, "1.2.3");
      expect(storeMock.set).not.toHaveBeenCalledWith("lastNotifiedStoreVersion", "1.2.3");
    });

    it("rejects malformed version strings", () => {
      windowsStoreNotifierService.initialize();
      const dismissCall = ipcMainMock.handle.mock.calls.find(
        ([ch]) => ch === CHANNELS.STORE_UPDATE_DISMISS
      );
      const handler = dismissCall![1];
      handler({ senderFrame: { url: "app://daintree/index.html" } }, "../../../evil");
      handler({ senderFrame: { url: "app://daintree/index.html" } }, "v1.2.3");
      handler({ senderFrame: { url: "app://daintree/index.html" } }, "a".repeat(200));
      expect(storeMock.set).not.toHaveBeenCalledWith(
        "lastNotifiedStoreVersion",
        expect.any(String)
      );
    });
  });

  describe("settings handlers", () => {
    it("defaults enabled to true when the key is absent", () => {
      windowsStoreNotifierService.initialize();
      const getCall = ipcMainMock.handle.mock.calls.find(
        ([ch]) => ch === CHANNELS.STORE_UPDATE_GET_SETTINGS
      );
      const result = getCall![1]({});
      expect(result).toEqual({ enabled: true });
    });

    it("persists the toggle when a trusted sender invokes set", () => {
      windowsStoreNotifierService.initialize();
      const setCall = ipcMainMock.handle.mock.calls.find(
        ([ch]) => ch === CHANNELS.STORE_UPDATE_SET_SETTINGS
      );
      const handler = setCall![1];
      const result = handler({ senderFrame: { url: "app://daintree/index.html" } }, false);
      expect(storeMock.set).toHaveBeenCalledWith("storeUpdateNotificationsEnabled", false);
      expect(result).toEqual({ enabled: false });
    });
  });

  describe("getLatest", () => {
    it("returns the cached detection so the renderer can hydrate after the broadcast", async () => {
      netMock.fetch.mockResolvedValueOnce(makeResponse({ body: "version: 2.0.0\n", etag: null }));
      windowsStoreNotifierService.initialize();
      await windowsStoreNotifierService._checkNowForTest();
      const getLatestCall = ipcMainMock.handle.mock.calls.find(
        ([ch]) => ch === CHANNELS.STORE_UPDATE_GET_LATEST
      );
      const cached = getLatestCall![1]({});
      expect(cached).toEqual({ version: "2.0.0", storeUrl: MS_STORE_FALLBACK_URL });
    });
  });
});
