import { describe, it, expect, vi, beforeEach } from "vitest";

type PermissionRequestHandler = (
  wc: Electron.WebContents,
  permission: string,
  callback: (granted: boolean) => void,
  details: { requestingUrl?: string }
) => void;

type PermissionCheckHandler = (
  wc: Electron.WebContents | null,
  permission: string,
  requestingOrigin: string,
  details: Record<string, unknown>
) => boolean;

function createMockSession() {
  return {
    setPermissionRequestHandler: vi.fn<(handler: PermissionRequestHandler | null) => void>(),
    setPermissionCheckHandler: vi.fn<(handler: PermissionCheckHandler | null) => void>(),
  };
}

const { defaultSession, browserSession, sidecarSession, sessionCreatedListeners } = vi.hoisted(
  () => {
    return {
      defaultSession: createMockSession(),
      browserSession: createMockSession(),
      sidecarSession: createMockSession(),
      sessionCreatedListeners: [] as Array<
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ses: any) => void
      >,
    };
  }
);

vi.mock("electron", () => ({
  app: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on: vi.fn((event: string, listener: (ses: any) => void) => {
      if (event === "session-created") {
        sessionCreatedListeners.push(listener);
      }
    }),
  },
  ipcMain: {
    handle: vi.fn(),
    handleOnce: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    off: vi.fn(),
  },
  session: {
    defaultSession,
    fromPartition: vi.fn((partition: string) => {
      if (partition === "persist:browser") return browserSession;
      if (partition === "persist:sidecar") return sidecarSession;
      return createMockSession();
    }),
  },
}));

vi.mock("../../../shared/utils/trustedRenderer.js", () => ({
  isTrustedRendererUrl: vi.fn(() => true),
}));

import { setupPermissionLockdown, _resetPermissionLockdownForTesting } from "../security.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockWebContents = {} as any;

function getRequestHandler(mock: ReturnType<typeof createMockSession>): PermissionRequestHandler {
  const calls = mock.setPermissionRequestHandler.mock.calls;
  return calls[calls.length - 1][0] as PermissionRequestHandler;
}

function getCheckHandler(mock: ReturnType<typeof createMockSession>): PermissionCheckHandler {
  const calls = mock.setPermissionCheckHandler.mock.calls;
  return calls[calls.length - 1][0] as PermissionCheckHandler;
}

function testPermissionRequest(
  handler: PermissionRequestHandler,
  permission: string,
  url = "http://localhost:3000"
): boolean {
  const callback = vi.fn<(granted: boolean) => void>();
  handler(mockWebContents, permission, callback, { requestingUrl: url });
  expect(callback).toHaveBeenCalledTimes(1);
  return callback.mock.calls[0][0];
}

describe("setupPermissionLockdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionCreatedListeners.length = 0;
    _resetPermissionLockdownForTesting();
  });

  it("configures handlers on default, browser, and sidecar sessions", () => {
    setupPermissionLockdown();

    expect(defaultSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(defaultSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    expect(browserSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(browserSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    expect(sidecarSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(sidecarSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
  });

  describe("default session (trusted)", () => {
    it("allows clipboard-sanitized-write", () => {
      setupPermissionLockdown();
      const handler = getRequestHandler(defaultSession);
      expect(testPermissionRequest(handler, "clipboard-sanitized-write")).toBe(true);
    });

    it("allows clipboard-read", () => {
      setupPermissionLockdown();
      const handler = getRequestHandler(defaultSession);
      expect(testPermissionRequest(handler, "clipboard-read")).toBe(true);
    });

    it("allows media", () => {
      setupPermissionLockdown();
      const handler = getRequestHandler(defaultSession);
      expect(testPermissionRequest(handler, "media")).toBe(true);
    });

    it("denies geolocation", () => {
      setupPermissionLockdown();
      const handler = getRequestHandler(defaultSession);
      expect(testPermissionRequest(handler, "geolocation")).toBe(false);
    });

    it("denies notifications", () => {
      setupPermissionLockdown();
      const handler = getRequestHandler(defaultSession);
      expect(testPermissionRequest(handler, "notifications")).toBe(false);
    });

    it("denies fileSystem", () => {
      setupPermissionLockdown();
      const handler = getRequestHandler(defaultSession);
      expect(testPermissionRequest(handler, "fileSystem")).toBe(false);
    });

    it("denies unknown permission types", () => {
      setupPermissionLockdown();
      const handler = getRequestHandler(defaultSession);
      expect(testPermissionRequest(handler, "unknown")).toBe(false);
    });

    it("check handler allows trusted permissions", () => {
      setupPermissionLockdown();
      const handler = getCheckHandler(defaultSession);
      expect(handler(mockWebContents, "clipboard-read", "app://canopy", {})).toBe(true);
      expect(handler(mockWebContents, "clipboard-sanitized-write", "app://canopy", {})).toBe(true);
      expect(handler(mockWebContents, "media", "app://canopy", {})).toBe(true);
    });

    it("check handler denies untrusted permissions", () => {
      setupPermissionLockdown();
      const handler = getCheckHandler(defaultSession);
      expect(handler(mockWebContents, "geolocation", "app://canopy", {})).toBe(false);
      expect(handler(mockWebContents, "midi", "app://canopy", {})).toBe(false);
      expect(handler(mockWebContents, "serial", "app://canopy", {})).toBe(false);
      expect(handler(mockWebContents, "hid", "app://canopy", {})).toBe(false);
    });

    it("check handler works when webContents is null", () => {
      setupPermissionLockdown();
      const handler = getCheckHandler(defaultSession);
      expect(handler(null, "clipboard-read", "app://canopy", {})).toBe(true);
      expect(handler(null, "geolocation", "app://canopy", {})).toBe(false);
    });
  });

  describe("browser session (untrusted)", () => {
    it("denies all permissions via request handler", () => {
      setupPermissionLockdown();
      const handler = getRequestHandler(browserSession);
      expect(testPermissionRequest(handler, "clipboard-read")).toBe(false);
      expect(testPermissionRequest(handler, "clipboard-sanitized-write")).toBe(false);
      expect(testPermissionRequest(handler, "media")).toBe(false);
      expect(testPermissionRequest(handler, "geolocation")).toBe(false);
      expect(testPermissionRequest(handler, "notifications")).toBe(false);
    });

    it("denies all permissions via check handler", () => {
      setupPermissionLockdown();
      const handler = getCheckHandler(browserSession);
      expect(handler(mockWebContents, "clipboard-read", "http://localhost:3000", {})).toBe(false);
      expect(handler(mockWebContents, "media", "http://localhost:3000", {})).toBe(false);
    });
  });

  describe("sidecar session", () => {
    it("allows clipboard-sanitized-write", () => {
      setupPermissionLockdown();
      const handler = getRequestHandler(sidecarSession);
      expect(testPermissionRequest(handler, "clipboard-sanitized-write")).toBe(true);
    });

    it("denies clipboard-read", () => {
      setupPermissionLockdown();
      const handler = getRequestHandler(sidecarSession);
      expect(testPermissionRequest(handler, "clipboard-read")).toBe(false);
    });

    it("denies media", () => {
      setupPermissionLockdown();
      const handler = getRequestHandler(sidecarSession);
      expect(testPermissionRequest(handler, "media")).toBe(false);
    });

    it("denies all other permissions", () => {
      setupPermissionLockdown();
      const handler = getRequestHandler(sidecarSession);
      expect(testPermissionRequest(handler, "geolocation")).toBe(false);
      expect(testPermissionRequest(handler, "notifications")).toBe(false);
      expect(testPermissionRequest(handler, "fileSystem")).toBe(false);
    });

    it("check handler allows only clipboard-sanitized-write", () => {
      setupPermissionLockdown();
      const handler = getCheckHandler(sidecarSession);
      expect(handler(mockWebContents, "clipboard-sanitized-write", "https://sidecar.ai", {})).toBe(
        true
      );
      expect(handler(mockWebContents, "clipboard-read", "https://sidecar.ai", {})).toBe(false);
      expect(handler(mockWebContents, "media", "https://sidecar.ai", {})).toBe(false);
    });
  });

  describe("dynamic session-created handler", () => {
    it("registers session-created listener", () => {
      setupPermissionLockdown();
      expect(sessionCreatedListeners).toHaveLength(1);
    });

    it("locks down dev-preview partitions", () => {
      setupPermissionLockdown();
      const devPreviewSession = createMockSession();
      Object.defineProperty(devPreviewSession, "partition", {
        value: "persist:dev-preview-myproject",
      });

      sessionCreatedListeners[0](devPreviewSession);

      expect(devPreviewSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
      expect(devPreviewSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1);

      const handler = getRequestHandler(devPreviewSession);
      expect(testPermissionRequest(handler, "clipboard-read")).toBe(false);
      expect(testPermissionRequest(handler, "media")).toBe(false);
    });

    it("locks down dynamically created browser partitions", () => {
      setupPermissionLockdown();
      const dynamicBrowserSession = createMockSession();
      Object.defineProperty(dynamicBrowserSession, "partition", {
        value: "persist:browser",
      });

      sessionCreatedListeners[0](dynamicBrowserSession);

      expect(dynamicBrowserSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
      expect(dynamicBrowserSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1);

      const handler = getRequestHandler(dynamicBrowserSession);
      expect(testPermissionRequest(handler, "clipboard-read")).toBe(false);
    });

    it("handles sessions with missing partition property", () => {
      setupPermissionLockdown();
      const noPartitionSession = createMockSession();

      sessionCreatedListeners[0](noPartitionSession);

      expect(noPartitionSession.setPermissionRequestHandler).not.toHaveBeenCalled();
      expect(noPartitionSession.setPermissionCheckHandler).not.toHaveBeenCalled();
    });

    it("does not lock down unknown partitions", () => {
      setupPermissionLockdown();
      const unknownSession = createMockSession();
      Object.defineProperty(unknownSession, "partition", { value: "persist:custom" });

      sessionCreatedListeners[0](unknownSession);

      expect(unknownSession.setPermissionRequestHandler).not.toHaveBeenCalled();
      expect(unknownSession.setPermissionCheckHandler).not.toHaveBeenCalled();
    });
  });

  describe("idempotency", () => {
    it("does not register duplicate session-created listeners on repeated calls", () => {
      setupPermissionLockdown();
      setupPermissionLockdown();

      expect(sessionCreatedListeners).toHaveLength(1);
    });

    it("re-registers after reset for testing", () => {
      setupPermissionLockdown();
      _resetPermissionLockdownForTesting();
      setupPermissionLockdown();

      expect(sessionCreatedListeners).toHaveLength(2);
    });
  });

  describe("denial logging", () => {
    it("logs denied permission requests with context", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      setupPermissionLockdown();

      const handler = getRequestHandler(defaultSession);
      testPermissionRequest(handler, "geolocation", "http://localhost:3000");

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[SECURITY] Permission denied: geolocation")
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("session=default"));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("url=http://localhost:3000"));
      warnSpy.mockRestore();
    });

    it("logs denied permission checks with origin", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      setupPermissionLockdown();

      const handler = getCheckHandler(defaultSession);
      handler(mockWebContents, "geolocation", "http://localhost:3000", {});

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[SECURITY] Permission denied: geolocation")
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("handler=check"));
      warnSpy.mockRestore();
    });

    it("does not log when request permission is granted", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      setupPermissionLockdown();

      const handler = getRequestHandler(defaultSession);
      testPermissionRequest(handler, "clipboard-read", "app://canopy");

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("does not log when check permission is granted", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      setupPermissionLockdown();

      const handler = getCheckHandler(defaultSession);
      handler(mockWebContents, "clipboard-read", "app://canopy", {});

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("logs denials on untrusted sessions", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      setupPermissionLockdown();

      const handler = getRequestHandler(browserSession);
      testPermissionRequest(handler, "media", "http://example.com");

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[SECURITY] Permission denied: media")
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("session=browser"));
      warnSpy.mockRestore();
    });

    it("handles missing requestingUrl gracefully", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      setupPermissionLockdown();

      const handler = getRequestHandler(defaultSession);
      handler(mockWebContents, "geolocation", (granted) => granted, {});

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("url=unknown"));
      warnSpy.mockRestore();
    });
  });
});
