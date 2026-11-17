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

  describe("fetch deadline and overlapping checks", () => {
    type FetchInit = { headers: Record<string, string>; signal?: AbortSignal };

    function pendingFetch(): {
      resolve: (value: unknown) => void;
      reject: (err: unknown) => void;
      init: () => FetchInit;
    } {
      let resolve!: (value: unknown) => void;
      let reject!: (err: unknown) => void;
      let captured: FetchInit | undefined;
      netMock.fetch.mockImplementationOnce((_url: string, init: FetchInit) => {
        captured = init;
        return new Promise((res, rej) => {
          resolve = res;
          reject = rej;
        });
      });
      return {
        resolve: (value) => resolve(value),
        reject: (err) => reject(err),
        init: () => {
          if (!captured) throw new Error("fetch was not called");
          return captured;
        },
      };
    }

    function trackSettled(promise: Promise<void>): () => boolean {
      let settled = false;
      void promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      return () => settled;
    }

    it("shares a pending check with a later trigger instead of sending a second request", async () => {
      const fetch = pendingFetch();
      const first = windowsStoreNotifierService._checkNowForTest();
      const second = windowsStoreNotifierService._checkNowForTest();
      expect(netMock.fetch).toHaveBeenCalledTimes(1);

      fetch.resolve(makeResponse({ body: "version: 1.2.0\n", etag: null }));
      await Promise.all([first, second]);
      expect(broadcastMock).toHaveBeenCalledTimes(1);
      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.STORE_UPDATE_AVAILABLE, {
        version: "1.2.0",
        storeUrl: MS_STORE_FALLBACK_URL,
      });
    });

    it("times out a request that never answers and aborts it", async () => {
      const fetch = pendingFetch();
      const settled = trackSettled(windowsStoreNotifierService._checkNowForTest());
      expect(fetch.init().signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled()).toBe(true);
      expect(fetch.init().signal?.aborted).toBe(true);
      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it("times out a stalled response body", async () => {
      netMock.fetch.mockResolvedValueOnce({
        ...makeResponse({ etag: '"stalled"' }),
        text: () => new Promise<string>(() => {}),
      });
      const settled = trackSettled(windowsStoreNotifierService._checkNowForTest());

      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled()).toBe(true);
      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it("treats a body Chromium ends as a plain abort at the deadline as a timeout", async () => {
      netMock.fetch.mockImplementationOnce(async (_url: string, init: FetchInit) => ({
        ...makeResponse({ etag: null }),
        text: () =>
          new Promise<string>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError"))
            );
          }),
      }));
      void windowsStoreNotifierService._checkNowForTest();
      await vi.advanceTimersByTimeAsync(60_000);

      // A timeout is transient, so the retry ladder sends a fresh request.
      netMock.fetch.mockResolvedValueOnce(makeResponse({ status: 304 }));
      await vi.advanceTimersByTimeAsync(40_000);
      expect(netMock.fetch).toHaveBeenCalledTimes(2);
    });

    it("retries after a timeout with a fresh request", async () => {
      const stalled = pendingFetch();
      netMock.fetch.mockResolvedValueOnce(makeResponse({ body: "version: 1.3.0\n", etag: null }));
      void windowsStoreNotifierService._checkNowForTest();

      // The first request never answers, so only the deadline plus the first
      // retry (base 30s, up to 1.2x jitter) can send the second.
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(stalled.init().signal?.aborted).toBe(true);
      expect(netMock.fetch).toHaveBeenCalledTimes(2);
      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.STORE_UPDATE_AVAILABLE, {
        version: "1.3.0",
        storeUrl: MS_STORE_FALLBACK_URL,
      });
    });

    it("dispose cancels a pending check so its late response neither broadcasts nor caches", async () => {
      const fetch = pendingFetch();
      windowsStoreNotifierService.initialize();
      const check = windowsStoreNotifierService._checkNowForTest();

      windowsStoreNotifierService.dispose();
      expect(fetch.init().signal?.aborted).toBe(true);

      // The cancelled check settles without waiting for the request.
      await check;
      expect(vi.getTimerCount()).toBe(0);

      fetch.resolve(makeResponse({ body: "version: 9.9.9\n", etag: '"late"' }));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(broadcastMock).not.toHaveBeenCalled();
      expect(windowsStoreNotifierService.getLastDetectedUpdate()).toBeNull();
      expect(netMock.fetch).toHaveBeenCalledTimes(1);
    });

    it("suspend cancels a pending check and wake sends a fresh request", async () => {
      windowsStoreNotifierService.initialize();
      const onSuspend = (systemSleepMock.onSuspend.mock.calls[0] as unknown[])[0] as () => void;
      const onWake = (systemSleepMock.onWake.mock.calls[0] as unknown[])[0] as () => void;
      const held = pendingFetch();
      const check = windowsStoreNotifierService._checkNowForTest();

      onSuspend();
      expect(held.init().signal?.aborted).toBe(true);
      held.reject(new Error("net::ERR_NETWORK_CHANGED"));
      await check;

      netMock.fetch.mockResolvedValueOnce(makeResponse({ body: "version: 1.6.0\n", etag: null }));
      onWake();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(netMock.fetch).toHaveBeenCalledTimes(2);
      expect(broadcastMock).toHaveBeenCalledTimes(1);
      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.STORE_UPDATE_AVAILABLE, {
        version: "1.6.0",
        storeUrl: MS_STORE_FALLBACK_URL,
      });
    });

    it("turning notifications off cancels a pending check", async () => {
      windowsStoreNotifierService.initialize();
      const setCall = ipcMainMock.handle.mock.calls.find(
        ([ch]) => ch === CHANNELS.STORE_UPDATE_SET_SETTINGS
      );
      const fetch = pendingFetch();
      const check = windowsStoreNotifierService._checkNowForTest();

      setCall![1]({ senderFrame: { url: "app://daintree/index.html" } }, false);
      expect(fetch.init().signal?.aborted).toBe(true);
      fetch.resolve(makeResponse({ body: "version: 9.9.9\n", etag: null }));
      await check;
      expect(broadcastMock).not.toHaveBeenCalled();
      expect(windowsStoreNotifierService.getLastDetectedUpdate()).toBeNull();
    });

    it("a trigger after a channel switch supersedes the pending check for the old feed", async () => {
      let channel = "stable" as "stable" | "nightly";
      storeMock.get.mockImplementation((key: string) => {
        if (key === "updateChannel") return channel;
        return undefined;
      });
      const stable = pendingFetch();
      const stableCheck = windowsStoreNotifierService._checkNowForTest();

      channel = "nightly";
      const nightly = pendingFetch();
      const nightlyCheck = windowsStoreNotifierService._checkNowForTest();
      expect(netMock.fetch).toHaveBeenCalledTimes(2);
      expect(netMock.fetch.mock.calls[1][0]).toContain("/nightly/");
      expect(stable.init().signal?.aborted).toBe(true);
      expect(storeMock.delete).toHaveBeenCalledWith("storeNotifierEtag");

      stable.resolve(makeResponse({ body: "version: 3.0.0\n", etag: '"stable"' }));
      nightly.resolve(makeResponse({ body: "version: 3.1.0-nightly.1\n", etag: null }));
      await Promise.all([stableCheck, nightlyCheck]);
      expect(broadcastMock).toHaveBeenCalledTimes(1);
      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.STORE_UPDATE_AVAILABLE, {
        version: "3.1.0-nightly.1",
        storeUrl: MS_STORE_FALLBACK_URL,
      });
    });

    it("dispose suppresses the retry a late transient failure would schedule", async () => {
      const fetch = pendingFetch();
      const check = windowsStoreNotifierService._checkNowForTest();

      windowsStoreNotifierService.dispose();
      fetch.reject(new Error("net::ERR_NETWORK_CHANGED"));
      await check;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(netMock.fetch).toHaveBeenCalledTimes(1);
      expect(console.error).not.toHaveBeenCalled();
    });

    it("a check after dispose sends its own request and the cancelled one can't release it", async () => {
      const cancelled = pendingFetch();
      const staleCheck = windowsStoreNotifierService._checkNowForTest();
      windowsStoreNotifierService.dispose();

      const current = pendingFetch();
      const freshCheck = windowsStoreNotifierService._checkNowForTest();
      expect(netMock.fetch).toHaveBeenCalledTimes(2);

      cancelled.resolve(makeResponse({ body: "version: 5.0.0\n", etag: null }));
      await staleCheck;
      // The fresh check is still the one in flight, so a new trigger joins it.
      const joined = windowsStoreNotifierService._checkNowForTest();
      expect(netMock.fetch).toHaveBeenCalledTimes(2);

      current.resolve(makeResponse({ body: "version: 1.4.0\n", etag: null }));
      await Promise.all([freshCheck, joined]);
      expect(broadcastMock).toHaveBeenCalledTimes(1);
      expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.STORE_UPDATE_AVAILABLE, {
        version: "1.4.0",
        storeUrl: MS_STORE_FALLBACK_URL,
      });
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
