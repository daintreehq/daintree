import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

const appListeners = vi.hoisted(() => new Map<string, Listener[]>());
const sessions = vi.hoisted(() => new Map<string, unknown>());
const proxyControl = vi.hoisted(() => ({
  resolve: (() => {}) as () => void,
  reject: (() => {}) as (error: unknown) => void,
}));
const htmlHandler = vi.hoisted(() => () => Promise.resolve(new Response("")));
const cycleAction = vi.hoisted(() => ({ value: undefined as { actionId: string } | undefined }));

function makeSession() {
  const sessionListeners = new Map<string, Listener>();
  return {
    protocol: { handle: vi.fn() },
    webRequest: { onBeforeRequest: vi.fn() },
    on: vi.fn((event: string, listener: Listener) => sessionListeners.set(event, listener)),
    setProxy: vi.fn(
      (_config: Electron.ProxyConfig) =>
        new Promise<void>((resolve, reject) => {
          proxyControl.resolve = resolve;
          proxyControl.reject = reject;
        })
    ),
    sessionListeners,
  };
}

vi.mock("electron", () => ({
  app: {
    on: vi.fn((event: string, listener: Listener) => {
      appListeners.set(event, [...(appListeners.get(event) ?? []), listener]);
    }),
  },
  session: {
    fromPartition: vi.fn((partition: string) => {
      if (!sessions.has(partition)) sessions.set(partition, makeSession());
      return sessions.get(partition);
    }),
  },
}));

vi.mock("../protocols/html.js", () => ({
  createDaintreeHtmlProtocolHandler: () => htmlHandler,
}));

vi.mock("../../services/menuAccelerators.js", () => ({
  findTerminalCycleAction: () => cycleAction.value,
}));

import { HTML_PREVIEW_PARTITION } from "../../../shared/utils/partitionUtils.js";
import { CHANNELS } from "../../ipc/channels.js";
import {
  _resetHtmlPreviewSessionForTesting,
  gateHtmlPreviewWebviewAttach,
  isHtmlPreviewContents,
  setupHtmlPreviewSession,
} from "../htmlPreviewSession.js";

type FakeSession = ReturnType<typeof makeSession>;

function previewSession(): FakeSession {
  return sessions.get(HTML_PREVIEW_PARTITION) as FakeSession;
}

async function setupReady(): Promise<void> {
  const ready = setupHtmlPreviewSession();
  proxyControl.resolve();
  await ready;
}

function makeGuest(session: unknown, url = "daintree-html://tok/index.html") {
  const listeners = new Map<string, Listener>();
  const embedder = { isDestroyed: () => false, send: vi.fn() };
  return {
    session: session as Electron.Session,
    hostWebContents: embedder,
    getURL: vi.fn(() => url),
    setWebRTCIPHandlingPolicy: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn((event: string, listener: Listener) => listeners.set(event, listener)),
    listeners,
    embedder,
  };
}

function createGuest(guest: ReturnType<typeof makeGuest>): void {
  for (const listener of appListeners.get("web-contents-created") ?? []) {
    listener({}, guest);
  }
}

function previewParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    src: "daintree-html://tok/index.html?v=1",
    partition: HTML_PREVIEW_PARTITION,
    ...overrides,
  };
}

function keyDown(input: Partial<Electron.Input>): Electron.Input {
  return {
    type: "keyDown",
    key: "",
    code: "",
    isAutoRepeat: false,
    isComposing: false,
    shift: false,
    control: false,
    alt: false,
    meta: false,
    location: 0,
    modifiers: [],
    ...input,
  } as Electron.Input;
}

describe("htmlPreviewSession", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    appListeners.clear();
    sessions.clear();
    cycleAction.value = undefined;
    _resetHtmlPreviewSessionForTesting();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.restoreAllMocks();
  });

  describe("session setup", () => {
    it("serves only daintree-html on the in-memory preview partition", () => {
      setupHtmlPreviewSession();

      const ses = previewSession();
      expect(ses.protocol.handle).toHaveBeenCalledTimes(1);
      expect(ses.protocol.handle).toHaveBeenCalledWith("daintree-html", htmlHandler);
      expect(HTML_PREVIEW_PARTITION.startsWith("persist:")).toBe(false);
    });

    it("routes every connection to a loopback proxy with no direct fallback or loopback bypass", () => {
      setupHtmlPreviewSession();

      const config = previewSession().setProxy.mock.calls[0]![0];
      expect(config.mode).toBe("fixed_servers");
      // A fixed list without DIRECT fails rather than falling back to a direct dial.
      expect(config.proxyRules?.toLowerCase()).not.toContain("direct");
      expect(new URL(config.proxyRules ?? "").hostname).toBe("127.0.0.1");
      // Chromium bypasses the proxy for loopback unless told not to, which would
      // let a TURN server on 127.0.0.1 be dialled directly.
      expect(config.proxyBypassRules).toContain("<-loopback>");
    });

    it("cancels network-scheme requests and downloads", () => {
      setupHtmlPreviewSession();
      const ses = previewSession();

      const [filter, listener] = ses.webRequest.onBeforeRequest.mock.calls[0] as unknown as [
        { urls: string[] },
        (details: unknown, callback: (response: { cancel?: boolean }) => void) => void,
      ];
      for (const scheme of ["http", "https", "ws", "wss"]) {
        expect(filter.urls.some((pattern) => pattern.startsWith(`${scheme}://`))).toBe(true);
      }
      expect(filter.urls.some((pattern) => pattern.startsWith("daintree-html:"))).toBe(false);
      const callback = vi.fn();
      listener({ url: "https://example.com/" }, callback);
      expect(callback).toHaveBeenCalledWith({ cancel: true });

      const preventDefault = vi.fn();
      ses.sessionListeners.get("will-download")?.({ preventDefault });
      expect(preventDefault).toHaveBeenCalled();
    });

    it("configures the session once", () => {
      const first = setupHtmlPreviewSession();
      expect(setupHtmlPreviewSession()).toBe(first);

      expect(previewSession().protocol.handle).toHaveBeenCalledTimes(1);
      expect(previewSession().setProxy).toHaveBeenCalledTimes(1);
      expect(appListeners.get("web-contents-created")).toHaveLength(1);
    });
  });

  describe("gateHtmlPreviewWebviewAttach", () => {
    it("hands every non-preview attach back to the host's own gate", async () => {
      await setupReady();

      const prefs: Electron.WebPreferences = { preload: "/x.js" };
      const verdict = gateHtmlPreviewWebviewAttach(prefs, {
        src: "http://localhost:3000/",
        partition: "persist:browser-default",
      });

      expect(verdict).toBe("not-preview");
      expect(prefs.preload).toBe("/x.js");
    });

    it("refuses a preview src outside the preview partition", async () => {
      await setupReady();

      for (const partition of ["persist:browser-default", "persist:daintree", ""]) {
        expect(gateHtmlPreviewWebviewAttach({}, previewParams({ partition }))).toBe("refused");
      }
    });

    it("refuses anything but a preview src in the preview partition", async () => {
      await setupReady();

      for (const src of ["https://example.com/", "daintree-file://load?path=/etc/passwd", ""]) {
        expect(gateHtmlPreviewWebviewAttach({}, previewParams({ src }))).toBe("refused");
      }
    });

    it("refuses previews until the proxy is confirmed, which the setup promise marks", async () => {
      const ready = setupHtmlPreviewSession();
      expect(gateHtmlPreviewWebviewAttach({}, previewParams())).toBe("refused");

      proxyControl.resolve();
      await ready;
      expect(gateHtmlPreviewWebviewAttach({}, previewParams())).toBe("allowed");
    });

    it("keeps previews refused when the proxy can't be applied, without failing startup", async () => {
      const ready = setupHtmlPreviewSession();
      proxyControl.reject(new Error("network service gone"));

      await expect(ready).resolves.toBeUndefined();
      expect(gateHtmlPreviewWebviewAttach({}, previewParams())).toBe("refused");
    });

    it("overrides hostile preferences on an allowed attach", async () => {
      await setupReady();

      const prefs: Electron.WebPreferences = {
        preload: "/evil.js",
        nodeIntegration: true,
        nodeIntegrationInSubFrames: true,
        contextIsolation: false,
        sandbox: false,
        webviewTag: true,
        partition: "persist:daintree",
      };
      expect(gateHtmlPreviewWebviewAttach(prefs, previewParams())).toBe("allowed");

      expect(prefs.preload).toBeUndefined();
      expect(prefs.nodeIntegration).toBe(false);
      expect(prefs.nodeIntegrationInSubFrames).toBe(false);
      expect(prefs.contextIsolation).toBe(true);
      expect(prefs.sandbox).toBe(true);
      expect(prefs.webviewTag).toBe(false);
      expect(prefs.partition).toBe(HTML_PREVIEW_PARTITION);
    });
  });

  describe("preview guests", () => {
    it("gets the no-UDP WebRTC policy at creation, before any navigation", async () => {
      await setupReady();
      // Nothing has loaded yet: the session alone must identify the guest.
      const guest = makeGuest(previewSession(), "");

      createGuest(guest);

      expect(guest.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith("disable_non_proxied_udp");
      expect(isHtmlPreviewContents(guest)).toBe(true);
    });

    it("leaves contents in other sessions alone", async () => {
      await setupReady();
      const other = makeGuest({});

      createGuest(other);

      expect(other.setWebRTCIPHandlingPolicy).not.toHaveBeenCalled();
      expect(other.on).not.toHaveBeenCalled();
      expect(isHtmlPreviewContents(other)).toBe(false);
    });

    it("denies every popup", async () => {
      await setupReady();
      const guest = makeGuest(previewSession());
      createGuest(guest);

      const handler = guest.setWindowOpenHandler.mock.calls[0]?.[0] as (details: {
        url: string;
      }) => { action: string };
      expect(handler({ url: "https://example.com/" }).action).toBe("deny");
      expect(handler({ url: "daintree-html://tok/other.html" }).action).toBe("deny");
    });

    it("follows the page's own relative links and refuses every other navigation", async () => {
      await setupReady();
      const guest = makeGuest(previewSession(), "daintree-html://tok/index.html?v=1");
      createGuest(guest);

      for (const event of ["will-navigate", "will-redirect"]) {
        const navigate = (url: string) => {
          const preventDefault = vi.fn();
          guest.listeners.get(event)?.({ preventDefault }, url);
          return preventDefault.mock.calls.length > 0;
        };
        expect(navigate("daintree-html://tok/sub/page.html")).toBe(false);
        expect(navigate("daintree-html://other-token/index.html")).toBe(true);
        expect(navigate("https://example.com/?leak=1")).toBe(true);
        expect(navigate("http://127.0.0.1:3000/")).toBe(true);
        expect(navigate("not a url")).toBe(true);
      }
    });

    it("refuses nested webviews", async () => {
      await setupReady();
      const guest = makeGuest(previewSession());
      createGuest(guest);

      const preventDefault = vi.fn();
      guest.listeners.get("will-attach-webview")?.({ preventDefault });
      expect(preventDefault).toHaveBeenCalled();
    });

    it.each([
      ["darwin", { meta: true }],
      ["linux", { control: true }],
      ["win32", { control: true }],
    ] as const)(
      "claims the close chord on %s so it can't close the window",
      async (platform, mods) => {
        Object.defineProperty(process, "platform", { value: platform });
        await setupReady();
        const guest = makeGuest(previewSession());
        createGuest(guest);

        const preventDefault = vi.fn();
        guest.listeners.get("before-input-event")?.(
          { preventDefault },
          keyDown({ key: "w", ...mods })
        );
        expect(preventDefault).toHaveBeenCalled();

        const plain = vi.fn();
        guest.listeners.get("before-input-event")?.(
          { preventDefault: plain },
          keyDown({ key: "w" })
        );
        expect(plain).not.toHaveBeenCalled();
      }
    );

    it("hands the terminal cycle chord to the embedder", async () => {
      await setupReady();
      const guest = makeGuest(previewSession());
      createGuest(guest);
      cycleAction.value = { actionId: "terminal.focusNext" };

      const preventDefault = vi.fn();
      guest.listeners.get("before-input-event")?.(
        { preventDefault },
        keyDown({ key: "Tab", control: true })
      );

      expect(preventDefault).toHaveBeenCalled();
      expect(guest.embedder.send).toHaveBeenCalledWith(CHANNELS.MENU_ACTION, cycleAction.value);
    });

    it("leaves ordinary typing to the page", async () => {
      await setupReady();
      const guest = makeGuest(previewSession());
      createGuest(guest);

      const preventDefault = vi.fn();
      guest.listeners.get("before-input-event")?.({ preventDefault }, keyDown({ key: "a" }));
      guest.listeners.get("before-input-event")?.(
        { preventDefault },
        keyDown({ type: "keyUp", key: "w", meta: true, control: true })
      );

      expect(preventDefault).not.toHaveBeenCalled();
      expect(guest.embedder.send).not.toHaveBeenCalled();
    });
  });
});
