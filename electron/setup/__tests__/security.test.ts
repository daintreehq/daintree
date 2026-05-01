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

const {
  defaultSession,
  browserSession,
  portalSession,
  daintreeAppSession,
  sessionCreatedListeners,
  appMock,
  ipcMainMock,
} = vi.hoisted(() => {
  return {
    defaultSession: createMockSession(),
    browserSession: createMockSession(),
    portalSession: createMockSession(),
    daintreeAppSession: createMockSession(),
    sessionCreatedListeners: [] as Array<
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ses: any) => void
    >,
    appMock: { isPackaged: false } as { isPackaged: boolean; on: ReturnType<typeof vi.fn> },
    ipcMainMock: {
      handle: vi.fn(),
      handleOnce: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
      off: vi.fn(),
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
appMock.on = vi.fn((event: string, listener: (ses: any) => void) => {
  if (event === "session-created") {
    sessionCreatedListeners.push(listener);
  }
});

vi.mock("electron", () => ({
  app: appMock,
  ipcMain: ipcMainMock,
  session: {
    defaultSession,
    fromPartition: vi.fn((partition: string) => {
      if (partition === "persist:browser") return browserSession;
      if (partition === "persist:portal") return portalSession;
      if (partition === "persist:daintree") return daintreeAppSession;
      return createMockSession();
    }),
  },
}));

vi.mock("../../../shared/utils/trustedRenderer.js", () => ({
  isTrustedRendererUrl: vi.fn(() => true),
}));

import {
  setupPermissionLockdown,
  enforceIpcSenderValidation,
  sanitizeErrorForRenderer,
  _resetPermissionLockdownForTesting,
} from "../security.js";
import { assertIpcSecurityReady, _resetIpcGuardForTesting } from "../../ipc/ipcGuard.js";

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

  it("configures handlers on default, browser, portal, and daintree-app sessions", () => {
    setupPermissionLockdown();

    expect(defaultSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(defaultSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    expect(browserSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(browserSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    expect(portalSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(portalSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    expect(daintreeAppSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(daintreeAppSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
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
      expect(handler(mockWebContents, "clipboard-read", "app://daintree", {})).toBe(true);
      expect(handler(mockWebContents, "clipboard-sanitized-write", "app://daintree", {})).toBe(
        true
      );
      expect(handler(mockWebContents, "media", "app://daintree", {})).toBe(true);
    });

    it("check handler denies untrusted permissions", () => {
      setupPermissionLockdown();
      const handler = getCheckHandler(defaultSession);
      expect(handler(mockWebContents, "geolocation", "app://daintree", {})).toBe(false);
      expect(handler(mockWebContents, "midi", "app://daintree", {})).toBe(false);
      expect(handler(mockWebContents, "serial", "app://daintree", {})).toBe(false);
      expect(handler(mockWebContents, "hid", "app://daintree", {})).toBe(false);
    });

    it("check handler works when webContents is null", () => {
      setupPermissionLockdown();
      const handler = getCheckHandler(defaultSession);
      expect(handler(null, "clipboard-read", "app://daintree", {})).toBe(true);
      expect(handler(null, "geolocation", "app://daintree", {})).toBe(false);
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

  describe("portal session", () => {
    it("allows clipboard-sanitized-write", () => {
      setupPermissionLockdown();
      const handler = getRequestHandler(portalSession);
      expect(testPermissionRequest(handler, "clipboard-sanitized-write")).toBe(true);
    });

    it("denies clipboard-read", () => {
      setupPermissionLockdown();
      const handler = getRequestHandler(portalSession);
      expect(testPermissionRequest(handler, "clipboard-read")).toBe(false);
    });

    it("denies media", () => {
      setupPermissionLockdown();
      const handler = getRequestHandler(portalSession);
      expect(testPermissionRequest(handler, "media")).toBe(false);
    });

    it("denies all other permissions", () => {
      setupPermissionLockdown();
      const handler = getRequestHandler(portalSession);
      expect(testPermissionRequest(handler, "geolocation")).toBe(false);
      expect(testPermissionRequest(handler, "notifications")).toBe(false);
      expect(testPermissionRequest(handler, "fileSystem")).toBe(false);
    });

    it("check handler allows only clipboard-sanitized-write", () => {
      setupPermissionLockdown();
      const handler = getCheckHandler(portalSession);
      expect(handler(mockWebContents, "clipboard-sanitized-write", "https://portal.ai", {})).toBe(
        true
      );
      expect(handler(mockWebContents, "clipboard-read", "https://portal.ai", {})).toBe(false);
      expect(handler(mockWebContents, "media", "https://portal.ai", {})).toBe(false);
    });
  });

  describe("daintree-app session (trusted)", () => {
    it("allows clipboard-read, clipboard-sanitized-write, and media", () => {
      setupPermissionLockdown();
      const handler = getRequestHandler(daintreeAppSession);
      expect(testPermissionRequest(handler, "clipboard-read")).toBe(true);
      expect(testPermissionRequest(handler, "clipboard-sanitized-write")).toBe(true);
      expect(testPermissionRequest(handler, "media")).toBe(true);
    });

    it("denies untrusted permissions", () => {
      setupPermissionLockdown();
      const handler = getRequestHandler(daintreeAppSession);
      expect(testPermissionRequest(handler, "geolocation")).toBe(false);
      expect(testPermissionRequest(handler, "notifications")).toBe(false);
      expect(testPermissionRequest(handler, "fileSystem")).toBe(false);
    });

    it("check handler grants trusted and denies untrusted", () => {
      setupPermissionLockdown();
      const handler = getCheckHandler(daintreeAppSession);
      expect(handler(mockWebContents, "clipboard-read", "app://daintree", {})).toBe(true);
      expect(handler(mockWebContents, "media", "app://daintree", {})).toBe(true);
      expect(handler(mockWebContents, "geolocation", "app://daintree", {})).toBe(false);
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

    it("does not double-lock daintree-app partition via session-created (eagerly locked)", () => {
      setupPermissionLockdown();
      const dynamicDaintreeSession = createMockSession();
      Object.defineProperty(dynamicDaintreeSession, "partition", {
        value: "persist:daintree",
      });

      sessionCreatedListeners[0](dynamicDaintreeSession);

      expect(dynamicDaintreeSession.setPermissionRequestHandler).not.toHaveBeenCalled();
      expect(dynamicDaintreeSession.setPermissionCheckHandler).not.toHaveBeenCalled();
    });

    it("default-locks sessions with missing partition property", () => {
      setupPermissionLockdown();
      const noPartitionSession = createMockSession();

      sessionCreatedListeners[0](noPartitionSession);

      expect(noPartitionSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
      expect(noPartitionSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    });

    it("default-locks spied [SECURITY] log for missing partition", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      setupPermissionLockdown();
      const noPartitionSession = createMockSession();
      sessionCreatedListeners[0](noPartitionSession);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("[SECURITY] Default-locked new session partition: (none)")
      );
      logSpy.mockRestore();
    });

    it("default-locks unknown partitions", () => {
      setupPermissionLockdown();
      const unknownSession = createMockSession();
      Object.defineProperty(unknownSession, "partition", { value: "persist:custom" });

      sessionCreatedListeners[0](unknownSession);

      expect(unknownSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
      expect(unknownSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    });

    it("logs [SECURITY] for default-locked unknown partitions", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      setupPermissionLockdown();
      const unknownSession = createMockSession();
      Object.defineProperty(unknownSession, "partition", { value: "persist:plugin-foo" });

      sessionCreatedListeners[0](unknownSession);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[SECURITY] Default-locked new session partition: persist:plugin-foo"
        )
      );
      logSpy.mockRestore();
    });

    it("skips project partitions in session-created", () => {
      setupPermissionLockdown();
      const projectSession = createMockSession();
      Object.defineProperty(projectSession, "partition", {
        value: "persist:project-myfeature",
      });

      sessionCreatedListeners[0](projectSession);

      expect(projectSession.setPermissionRequestHandler).not.toHaveBeenCalled();
      expect(projectSession.setPermissionCheckHandler).not.toHaveBeenCalled();
    });

    it("skips portal partition in session-created", () => {
      setupPermissionLockdown();
      const portalSession = createMockSession();
      Object.defineProperty(portalSession, "partition", {
        value: "persist:portal",
      });

      sessionCreatedListeners[0](portalSession);

      expect(portalSession.setPermissionRequestHandler).not.toHaveBeenCalled();
      expect(portalSession.setPermissionCheckHandler).not.toHaveBeenCalled();
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
      testPermissionRequest(handler, "clipboard-read", "app://daintree");

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("does not log when check permission is granted", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      setupPermissionLockdown();

      const handler = getCheckHandler(defaultSession);
      handler(mockWebContents, "clipboard-read", "app://daintree", {});

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

describe("enforceIpcSenderValidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpcGuardForTesting();
    appMock.isPackaged = false;
    // Reset wrapped handles so each test starts with a fresh vi.fn()
    ipcMainMock.handle = vi.fn();
    ipcMainMock.handleOnce = vi.fn();
    ipcMainMock.on = vi.fn();
    ipcMainMock.removeListener = vi.fn();
    ipcMainMock.removeAllListeners = vi.fn();
    ipcMainMock.off = vi.fn();
  });

  it("marks the IPC guard ready so subsequent registrations pass", () => {
    expect(() => assertIpcSecurityReady("any:channel")).toThrow(/Fix bootstrap order/);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    enforceIpcSenderValidation();
    logSpy.mockRestore();

    expect(() => assertIpcSecurityReady("any:channel")).not.toThrow();
  });

  it("scrubs secrets from serialized.message and serialized.userMessage in packaged builds", async () => {
    appMock.isPackaged = true;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Capture the original vi.fn before enforceIpcSenderValidation reassigns the property
    const originalHandle = ipcMainMock.handle;
    enforceIpcSenderValidation();

    const githubPat = `ghp_${"A".repeat(40)}`;
    const anthropicKey = `sk-ant-${"a".repeat(95)}`;
    const failingHandler = () => {
      const err = new Error(`token leak: ${githubPat}`) as Error & { userMessage?: string };
      err.userMessage = `please rotate ${anthropicKey}`;
      throw err;
    };
    // The reassigned ipcMain.handle is the wrapper; calling it forwards to originalHandle (the vi.fn)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ipcMainMock.handle("test:channel", failingHandler as any);

    const lastCall = originalHandle.mock.calls[originalHandle.mock.calls.length - 1];
    expect(lastCall).toBeDefined();
    const wrappedListener = lastCall[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;
    const fakeEvent = { senderFrame: { url: "http://localhost:3000" } };
    const envelope = (await wrappedListener(fakeEvent)) as {
      ok: false;
      error: { message: string; userMessage?: string };
    };

    expect(envelope.ok).toBe(false);
    expect(envelope.error.message).toContain("[REDACTED]");
    expect(envelope.error.message).not.toContain(githubPat);
    expect(envelope.error.userMessage).toContain("[REDACTED]");
    expect(envelope.error.userMessage).not.toContain(anthropicKey);

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("preserves a clean serialized.userMessage in packaged builds", async () => {
    appMock.isPackaged = true;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const originalHandle = ipcMainMock.handle;
    enforceIpcSenderValidation();

    const failingHandler = () => {
      const err = new Error("plain error") as Error & { userMessage?: string };
      err.userMessage = "Please try again later";
      throw err;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ipcMainMock.handle("test:channel", failingHandler as any);

    const lastCall = originalHandle.mock.calls[originalHandle.mock.calls.length - 1];
    const wrappedListener = lastCall[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;
    const fakeEvent = { senderFrame: { url: "http://localhost:3000" } };
    const envelope = (await wrappedListener(fakeEvent)) as {
      error: { userMessage?: string };
    };

    expect(envelope.error.userMessage).toBe("Please try again later");

    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe("sanitizeErrorForRenderer", () => {
  it("strips POSIX user paths", () => {
    const out = sanitizeErrorForRenderer("ENOENT: no file at /Users/alice/secret/code.ts");
    expect(out).toContain("<path>");
    expect(out).not.toContain("/Users/alice/secret/code.ts");
  });

  it("strips Windows paths", () => {
    const out = sanitizeErrorForRenderer("Cannot open C:\\Users\\bob\\file.ts");
    expect(out).toContain("<path>");
    expect(out).not.toContain("C:\\Users\\bob\\file.ts");
  });

  it("scrubs GitHub personal access tokens", () => {
    const pat = `ghp_${"A".repeat(40)}`;
    const out = sanitizeErrorForRenderer(`bad credential: ${pat}`);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain(pat);
  });

  it("scrubs Anthropic API keys", () => {
    const key = `sk-ant-${"a".repeat(95)}`;
    const out = sanitizeErrorForRenderer(`unauthorized: ${key}`);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain(key);
  });

  it("scrubs Bearer tokens", () => {
    const out = sanitizeErrorForRenderer(`Authorization: Bearer ${"x".repeat(60)}`);
    expect(out).toContain("Bearer [REDACTED]");
    expect(out).not.toMatch(/Bearer x{60}/);
  });

  it("strips paths and tokens in the same message", () => {
    const pat = `ghp_${"B".repeat(40)}`;
    const out = sanitizeErrorForRenderer(`failed at /Users/alice/x.ts using ${pat}`);
    expect(out).toContain("<path>");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("/Users/alice/x.ts");
    expect(out).not.toContain(pat);
  });

  it("passes clean strings through unchanged", () => {
    expect(sanitizeErrorForRenderer("simple error")).toBe("simple error");
  });

  it("handles the empty string", () => {
    expect(sanitizeErrorForRenderer("")).toBe("");
  });
});
