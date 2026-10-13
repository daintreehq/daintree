import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  getPendingDaintreeUrls: vi.fn<() => string[]>(() => []),
  clearPendingDaintreeUrls: vi.fn(),
  setDaintreeUrlConsumer: vi.fn<(c: ((url: string) => void) | null) => void>(),
}));

const registryMock = vi.hoisted(() => ({
  getAppWebContents: vi.fn(),
}));

vi.mock("../deepLinkUrlQueue.js", () => envMock);
vi.mock("../../window/webContentsRegistry.js", () => registryMock);
vi.mock("../../ipc/channels.js", () => ({
  CHANNELS: { EVENTS_PUSH: "events:push" },
}));
vi.mock("../../schemas/plugin.js", () => ({
  // Mirror the real pattern so id validation is exercised without pulling the
  // zod-backed schema module into the unit test.
  SCOPED_PLUGIN_NAME_PATTERN: /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/,
}));

type FakeWebContents = {
  id: number;
  send: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  isCrashed: ReturnType<typeof vi.fn>;
  isLoading: ReturnType<typeof vi.fn>;
};

function makeWebContents(id: number): FakeWebContents {
  return {
    id,
    send: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    isDestroyed: () => false,
    isCrashed: vi.fn(() => false),
    isLoading: vi.fn(() => false),
  };
}

// Settling a cancelled navigation is decided a turn after did-stop-loading.
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

// The registry resolves the primary window to whichever webContents
// `getAppWebContents` is mocked to return.
function makeRegistry(primary: boolean) {
  return {
    getPrimary: () => (primary ? { browserWindow: { isDestroyed: () => false } } : undefined),
  };
}

describe("parseDaintreeUrl", () => {
  it("parses a valid install link", async () => {
    const { parseDaintreeUrl } = await import("../deepLinkInstall.js");
    expect(
      parseDaintreeUrl("daintree://plugin/install?url=https%3A%2F%2Fexample.com%2Fp.dntr")
    ).toEqual({ action: "install", url: "https://example.com/p.dntr" });
  });

  it("parses a plaintext http install link (gate enforced downstream)", async () => {
    const { parseDaintreeUrl } = await import("../deepLinkInstall.js");
    expect(parseDaintreeUrl("daintree://plugin/install?url=http://example.com/p.dntr")).toEqual({
      action: "install",
      url: "http://example.com/p.dntr",
    });
  });

  it("parses a valid open link", async () => {
    const { parseDaintreeUrl } = await import("../deepLinkInstall.js");
    expect(parseDaintreeUrl("daintree://plugin/open?id=acme.notes")).toEqual({
      action: "open",
      pluginId: "acme.notes",
    });
  });

  it("rejects a javascript: install url", async () => {
    const { parseDaintreeUrl } = await import("../deepLinkInstall.js");
    expect(parseDaintreeUrl("daintree://plugin/install?url=javascript:alert(1)")).toBeNull();
  });

  it("rejects a file: install url", async () => {
    const { parseDaintreeUrl } = await import("../deepLinkInstall.js");
    expect(parseDaintreeUrl("daintree://plugin/install?url=file:///etc/passwd")).toBeNull();
  });

  it("rejects a nested daintree: install url", async () => {
    const { parseDaintreeUrl } = await import("../deepLinkInstall.js");
    expect(parseDaintreeUrl("daintree://plugin/install?url=daintree://plugin/install")).toBeNull();
  });

  it("rejects an install link with no url param", async () => {
    const { parseDaintreeUrl } = await import("../deepLinkInstall.js");
    expect(parseDaintreeUrl("daintree://plugin/install")).toBeNull();
  });

  it("rejects an open link with a malformed id", async () => {
    const { parseDaintreeUrl } = await import("../deepLinkInstall.js");
    expect(parseDaintreeUrl("daintree://plugin/open?id=Not Valid")).toBeNull();
  });

  it("rejects an unknown host", async () => {
    const { parseDaintreeUrl } = await import("../deepLinkInstall.js");
    expect(parseDaintreeUrl("daintree://settings/open?id=x")).toBeNull();
  });

  it("rejects an unknown path", async () => {
    const { parseDaintreeUrl } = await import("../deepLinkInstall.js");
    expect(parseDaintreeUrl("daintree://plugin/uninstall?id=acme.notes")).toBeNull();
  });

  it("rejects a non-daintree scheme", async () => {
    const { parseDaintreeUrl } = await import("../deepLinkInstall.js");
    expect(parseDaintreeUrl("https://example.com/install")).toBeNull();
    expect(parseDaintreeUrl("not a url at all")).toBeNull();
  });
});

describe("extractDaintreeUrl", () => {
  it("returns the first daintree:// argv entry", async () => {
    const { extractDaintreeUrl } = await import("../deepLinkInstall.js");
    expect(
      extractDaintreeUrl(["/path/to/app", "--flag", "daintree://plugin/open?id=acme.notes"])
    ).toBe("daintree://plugin/open?id=acme.notes");
  });

  it("returns null when no deep link is present", async () => {
    const { extractDaintreeUrl } = await import("../deepLinkInstall.js");
    expect(extractDaintreeUrl(["/path/to/app", "--cli-path", "/repo"])).toBeNull();
  });
});

describe("handleDaintreeUrl / notifyAppViewPainted", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    envMock.getPendingDaintreeUrls.mockReturnValue([]);
  });

  it("delivers immediately when the primary view has already painted (warm)", async () => {
    const mod = await import("../deepLinkInstall.js");
    mod._resetDeepLinkStateForTest();
    const wc = makeWebContents(7);
    registryMock.getAppWebContents.mockReturnValue(wc);
    mod.activateDeepLinkHandler(makeRegistry(true) as never);

    // Paint first (warm), then the deep link arrives.
    mod.notifyAppViewPainted(wc as never);
    mod.handleDaintreeUrl("daintree://plugin/open?id=acme.notes");

    expect(wc.send).toHaveBeenCalledWith("events:push", {
      name: "plugin:deep-link",
      payload: { action: "open", pluginId: "acme.notes" },
    });
  });

  it("holds the intent until the view paints (cold), then flushes once", async () => {
    const mod = await import("../deepLinkInstall.js");
    mod._resetDeepLinkStateForTest();
    const wc = makeWebContents(9);
    registryMock.getAppWebContents.mockReturnValue(wc);
    mod.activateDeepLinkHandler(makeRegistry(true) as never);

    // Deep link arrives before paint — nothing delivered yet.
    mod.handleDaintreeUrl("daintree://plugin/install?url=https://example.com/p.dntr");
    expect(wc.send).not.toHaveBeenCalled();

    // Paint flushes it exactly once.
    mod.notifyAppViewPainted(wc as never);
    expect(wc.send).toHaveBeenCalledTimes(1);
    expect(wc.send).toHaveBeenCalledWith("events:push", {
      name: "plugin:deep-link",
      payload: { action: "install", url: "https://example.com/p.dntr" },
    });

    // A second paint does not re-deliver the consumed intent.
    mod.notifyAppViewPainted(wc as never);
    expect(wc.send).toHaveBeenCalledTimes(1);
  });

  it("ignores an invalid deep link without delivering", async () => {
    const mod = await import("../deepLinkInstall.js");
    mod._resetDeepLinkStateForTest();
    const wc = makeWebContents(11);
    registryMock.getAppWebContents.mockReturnValue(wc);
    mod.activateDeepLinkHandler(makeRegistry(true) as never);
    mod.notifyAppViewPainted(wc as never);

    mod.handleDaintreeUrl("daintree://plugin/install?url=javascript:alert(1)");
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("drains macOS pending open-url URLs on activation", async () => {
    envMock.getPendingDaintreeUrls.mockReturnValue(["daintree://plugin/open?id=acme.notes"]);
    const mod = await import("../deepLinkInstall.js");
    mod._resetDeepLinkStateForTest();
    const wc = makeWebContents(13);
    registryMock.getAppWebContents.mockReturnValue(wc);

    mod.activateDeepLinkHandler(makeRegistry(true) as never);
    expect(envMock.clearPendingDaintreeUrls).toHaveBeenCalledOnce();

    // Held until paint, then delivered.
    mod.notifyAppViewPainted(wc as never);
    expect(wc.send).toHaveBeenCalledWith("events:push", {
      name: "plugin:deep-link",
      payload: { action: "open", pluginId: "acme.notes" },
    });
  });

  it("does not deliver to a non-primary view that paints first (lesson #9533)", async () => {
    const mod = await import("../deepLinkInstall.js");
    mod._resetDeepLinkStateForTest();
    const primary = makeWebContents(1);
    const secondary = makeWebContents(2);
    registryMock.getAppWebContents.mockReturnValue(primary);
    mod.activateDeepLinkHandler(makeRegistry(true) as never);

    mod.handleDaintreeUrl("daintree://plugin/open?id=acme.notes");
    // A non-primary view paints first — the intent stays queued for the primary.
    mod.notifyAppViewPainted(secondary as never);
    expect(secondary.send).not.toHaveBeenCalled();
    expect(primary.send).not.toHaveBeenCalled();

    // The primary paints — now it delivers, to the primary only.
    mod.notifyAppViewPainted(primary as never);
    expect(primary.send).toHaveBeenCalledTimes(1);
    expect(secondary.send).not.toHaveBeenCalled();
  });

  it("keeps delivering after a subframe or same-document navigation in a painted view", async () => {
    const mod = await import("../deepLinkInstall.js");
    mod._resetDeepLinkStateForTest();
    const wc = makeWebContents(6);
    registryMock.getAppWebContents.mockReturnValue(wc);
    mod.activateDeepLinkHandler(makeRegistry(true) as never);

    mod.notifyAppViewPainted(wc as never);
    const didStartNavigation = wc.on.mock.calls.find(
      ([evt]) => evt === "did-start-navigation"
    )?.[1] as (details: { isMainFrame: boolean; isSameDocument: boolean }) => void;

    // A browser panel's <webview> or an iframe loading, then an in-page route
    // change: the page and its listener are still there.
    didStartNavigation({ isMainFrame: false, isSameDocument: false });
    didStartNavigation({ isMainFrame: true, isSameDocument: true });

    mod.handleDaintreeUrl("daintree://plugin/open?id=acme.notes");
    expect(wc.send).toHaveBeenCalledTimes(1);
  });

  function handlerFor(wc: FakeWebContents, event: string) {
    return wc.on.mock.calls.find(([evt]) => evt === event)?.[1] as (...args: unknown[]) => void;
  }

  it("delivers again once a cancelled navigation stops loading with the page still there", async () => {
    const mod = await import("../deepLinkInstall.js");
    mod._resetDeepLinkStateForTest();
    const wc = makeWebContents(7);
    registryMock.getAppWebContents.mockReturnValue(wc);
    mod.activateDeepLinkHandler(makeRegistry(true) as never);
    const flushed = vi.fn();
    mod.registerPaintedFlushListener(flushed);
    mod.notifyAppViewPainted(wc as never);
    flushed.mockClear();

    // A file dropped on the window: the navigation starts, the guard cancels it,
    // and Electron 42 reports nothing but the loading stopping.
    handlerFor(wc, "did-start-navigation")({ isMainFrame: true, isSameDocument: false });
    mod.handleDaintreeUrl("daintree://plugin/open?id=acme.notes");
    expect(wc.send).not.toHaveBeenCalled();

    handlerFor(wc, "did-stop-loading")();
    await nextTurn();
    expect(wc.send).toHaveBeenCalledTimes(1);
    // The .dntr queue shares the painted bookkeeping and is flushed too.
    expect(flushed).toHaveBeenCalledTimes(1);
  });

  it("waits for a fresh paint after a navigation commits", async () => {
    const mod = await import("../deepLinkInstall.js");
    mod._resetDeepLinkStateForTest();
    const wc = makeWebContents(8);
    registryMock.getAppWebContents.mockReturnValue(wc);
    mod.activateDeepLinkHandler(makeRegistry(true) as never);
    mod.notifyAppViewPainted(wc as never);

    const start = handlerFor(wc, "did-start-navigation");
    start({ isMainFrame: true, isSameDocument: false });
    start({ isMainFrame: true, isSameDocument: false });
    mod.handleDaintreeUrl("daintree://plugin/open?id=acme.notes");
    handlerFor(wc, "did-navigate")({}, "app://daintree/index.html");
    handlerFor(wc, "did-stop-loading")();
    await nextTurn();
    expect(wc.send).not.toHaveBeenCalled();

    mod.notifyAppViewPainted(wc as never);
    expect(wc.send).toHaveBeenCalledTimes(1);
  });

  it("treats a committed error page as a replacement, not a cancelled navigation", async () => {
    const mod = await import("../deepLinkInstall.js");
    mod._resetDeepLinkStateForTest();
    const wc = makeWebContents(10);
    registryMock.getAppWebContents.mockReturnValue(wc);
    mod.activateDeepLinkHandler(makeRegistry(true) as never);
    mod.notifyAppViewPainted(wc as never);

    handlerFor(wc, "did-start-navigation")({ isMainFrame: true, isSameDocument: false });
    mod.handleDaintreeUrl("daintree://plugin/open?id=acme.notes");
    // Electron 42 emits this only for an error page that committed; no did-navigate.
    handlerFor(wc, "did-fail-provisional-load")(
      {},
      -102,
      "ERR_CONNECTION_REFUSED",
      "http://localhost:5173/",
      true
    );
    handlerFor(wc, "did-stop-loading")();
    await nextTurn();
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("does not settle into a renderer that died while its navigation was cancelled", async () => {
    const mod = await import("../deepLinkInstall.js");
    mod._resetDeepLinkStateForTest();
    const wc = makeWebContents(11);
    registryMock.getAppWebContents.mockReturnValue(wc);
    mod.activateDeepLinkHandler(makeRegistry(true) as never);
    mod.notifyAppViewPainted(wc as never);

    handlerFor(wc, "did-start-navigation")({ isMainFrame: true, isSameDocument: false });
    mod.handleDaintreeUrl("daintree://plugin/open?id=acme.notes");
    // Teardown stops loading before Electron's render-process-gone arrives.
    wc.isCrashed.mockReturnValue(true);
    handlerFor(wc, "did-stop-loading")();
    await nextTurn();
    handlerFor(wc, "render-process-gone")({}, { reason: "crashed", exitCode: 139 });
    expect(wc.send).not.toHaveBeenCalled();

    wc.isCrashed.mockReturnValue(false);
    mod.notifyAppViewPainted(wc as never);
    expect(wc.send).toHaveBeenCalledTimes(1);
  });

  it("keeps holding when a newer load has started by the time loading settles", async () => {
    const mod = await import("../deepLinkInstall.js");
    mod._resetDeepLinkStateForTest();
    const wc = makeWebContents(12);
    registryMock.getAppWebContents.mockReturnValue(wc);
    mod.activateDeepLinkHandler(makeRegistry(true) as never);
    mod.notifyAppViewPainted(wc as never);

    handlerFor(wc, "did-start-navigation")({ isMainFrame: true, isSameDocument: false });
    mod.handleDaintreeUrl("daintree://plugin/open?id=acme.notes");
    handlerFor(wc, "did-stop-loading")();
    wc.isLoading.mockReturnValue(true);
    await nextTurn();
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("holds intents from a renderer crash until the reloaded page paints", async () => {
    const mod = await import("../deepLinkInstall.js");
    mod._resetDeepLinkStateForTest();
    const wc = makeWebContents(9);
    registryMock.getAppWebContents.mockReturnValue(wc);
    mod.activateDeepLinkHandler(makeRegistry(true) as never);
    mod.notifyAppViewPainted(wc as never);

    handlerFor(wc, "render-process-gone")({}, { reason: "crashed", exitCode: 139 });
    mod.handleDaintreeUrl("daintree://plugin/open?id=acme.notes");
    handlerFor(wc, "did-stop-loading")();
    expect(wc.send).not.toHaveBeenCalled();

    mod.notifyAppViewPainted(wc as never);
    expect(wc.send).toHaveBeenCalledTimes(1);
  });
});
