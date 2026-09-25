import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp"), isPackaged: false, on: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  ipcMain: { on: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  shell: { openExternal: vi.fn() },
  dialog: {},
  session: {},
}));

import { isWebviewSrcAllowed, setRemoteWebviewSrcGate } from "../ProjectViewHandlers.js";
import {
  guardRemoteGuestRequests,
  isGuestPopupAllowed,
  isGuestRequestAllowed,
} from "../webviewSrcGate.js";

describe("webview src gate", () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it("keeps today's rule with no remote gate installed", () => {
    expect(isWebviewSrcAllowed(7, "http://localhost:3000/")).toBe(true);
    expect(isWebviewSrcAllowed(7, "http://dp-a-b.localhost:43000/")).toBe(true);
    expect(isWebviewSrcAllowed(7, "https://example.com/")).toBe(false);
  });

  it("lets a remote-bound view load only what its gate allows, and local views keep the local rule", () => {
    dispose = setRemoteWebviewSrcGate((webContentsId, src) =>
      webContentsId === 9 ? src === "http://localhost:5173/" : null
    );
    expect(isWebviewSrcAllowed(9, "http://localhost:5173/")).toBe(true);
    expect(isWebviewSrcAllowed(9, "http://localhost:3000/")).toBe(false);
    expect(isWebviewSrcAllowed(7, "http://localhost:3000/")).toBe(true);
  });

  it("stops applying a gate once it is disposed", () => {
    setRemoteWebviewSrcGate(() => false)();
    expect(isWebviewSrcAllowed(9, "http://localhost:3000/")).toBe(true);
  });
});

describe("remote guest requests", () => {
  const REMOTE = 9;
  const LOCAL = 7;
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    // The host's forward holds 127.0.0.1:5173 and [::1]:5173.
    dispose = setRemoteWebviewSrcGate(
      (webContentsId, src) =>
        webContentsId === REMOTE
          ? /^(https?|wss?):\/\/(localhost|127\.0\.0\.1|\[::1\]):5173\//.test(src)
          : null,
      (webContentsId) => webContentsId === REMOTE
    );
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  function fakeSession() {
    let listener: ((details: unknown, cb: (r: { cancel?: boolean }) => void) => void) | null = null;
    const onBeforeRequest = vi.fn((_filter: unknown, next: typeof listener) => {
      listener = next;
    });
    return {
      session: { webRequest: { onBeforeRequest } } as never,
      onBeforeRequest,
      request(url: string, embedder?: number): boolean {
        let cancelled = false;
        listener!(
          {
            url,
            webContents: embedder === undefined ? undefined : { hostWebContents: { id: embedder } },
          },
          (r) => (cancelled = r.cancel === true)
        );
        return !cancelled;
      },
    };
  }

  it("checks fetch, img, frame and WebSocket requests of a remote view's guest, not only navigations", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeSession();
    guardRemoteGuestRequests(REMOTE, { session: fake.session });
    expect(fake.onBeforeRequest).toHaveBeenCalledTimes(1);

    expect(fake.request("http://localhost:5173/api", REMOTE)).toBe(true);
    expect(fake.request("ws://127.0.0.1:5173/hmr", REMOTE)).toBe(true);
    expect(fake.request("https://cdn.example.com/lib.js", REMOTE)).toBe(true);
    expect(fake.request("http://localhost:6379/", REMOTE)).toBe(false);
    expect(fake.request("ws://127.0.0.1:9222/devtools", REMOTE)).toBe(false);
    expect(fake.request("http://127.0.0.2:5173/", REMOTE)).toBe(false);
    expect(fake.request("http://[::ffff:127.0.0.1]:8080/", REMOTE)).toBe(false);
    expect(fake.request("http://admin.localhost:8080/", REMOTE)).toBe(false);
    expect(fake.request("http://0.0.0.0:8080/", REMOTE)).toBe(false);
    // A request no guest owns (a service worker) follows the remote views the session served.
    expect(fake.request("http://localhost:5173/sw", undefined)).toBe(true);
    expect(fake.request("http://localhost:8080/sw", undefined)).toBe(false);
    // A local view sharing the partition keeps today's rules.
    expect(fake.request("http://localhost:8080/", LOCAL)).toBe(true);
    warn.mockRestore();
  });

  it("installs nothing on a session only local views use", () => {
    const fake = fakeSession();
    guardRemoteGuestRequests(LOCAL, { session: fake.session });
    expect(fake.onBeforeRequest).not.toHaveBeenCalled();
  });

  it("installs one listener per session however many guests use it", () => {
    const fake = fakeSession();
    guardRemoteGuestRequests(REMOTE, { session: fake.session });
    guardRemoteGuestRequests(REMOTE, { session: fake.session });
    expect(fake.onBeforeRequest).toHaveBeenCalledTimes(1);
  });

  it("refuses a request no guest owns once no remote view is left", () => {
    const fake = fakeSession();
    guardRemoteGuestRequests(REMOTE, { session: fake.session });
    dispose?.();
    dispose = setRemoteWebviewSrcGate(
      () => null,
      () => false
    );
    expect(fake.request("http://localhost:5173/sw", undefined)).toBe(false);
    expect(isGuestRequestAllowed(new Set(), { url: "https://example.com/" })).toBe(true);
  });

  it("keeps a remote view's popups off this machine's localhost", () => {
    expect(isGuestPopupAllowed(REMOTE, "http://localhost:8080/admin")).toBe(false);
    expect(isGuestPopupAllowed(REMOTE, "http://localhost:5173/")).toBe(true);
    expect(isGuestPopupAllowed(REMOTE, "https://github.com/login")).toBe(true);
    expect(isGuestPopupAllowed(LOCAL, "http://localhost:8080/admin")).toBe(true);
  });
});
