import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import path from "path";
import Module from "module";

const mockExecFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockRenameSync = vi.fn();
const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

const originalPlatform = process.platform;

afterAll(() => {
  consoleLogSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", { value: platform });
}

function createContext(overrides: Record<string, any> = {}) {
  return {
    appOutDir: "/build/mac-arm64",
    outDir: "/build/release",
    packager: { appInfo: { productFilename: "Daintree" } },
    arch: 3,
    ...overrides,
  };
}

function mockFs() {
  return {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    renameSync: mockRenameSync,
  };
}

function setAppleCredentials() {
  process.env.APPLE_API_KEY = "/tmp/key.p8";
  process.env.APPLE_API_KEY_ID = "ABC123";
  process.env.APPLE_API_ISSUER = "abc-123-456";
}

function clearAppleCredentials() {
  delete process.env.APPLE_API_KEY;
  delete process.env.APPLE_API_KEY_ID;
  delete process.env.APPLE_API_ISSUER;
}

describe("notarize-macos", () => {
  let afterSign: (context: any) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy.mockImplementation(() => {});
    consoleWarnSpy.mockImplementation(() => {});
    delete process.env.DAINTREE_SKIP_NOTARIZATION;
    setAppleCredentials();
    setPlatform("darwin");

    const originalRequire = Module.prototype.require;

    Module.prototype.require = function (id: string) {
      if (id === "fs") return mockFs();
      if (id === "child_process") return { execFileSync: mockExecFileSync };
      return originalRequire.apply(this, [id]);
    };

    try {
      delete require.cache[require.resolve("./notarize-macos.cjs")];
      const module = require("./notarize-macos.cjs");
      afterSign = module.default;
    } finally {
      Module.prototype.require = originalRequire;
    }
  });

  it("should return early on non-macOS", async () => {
    setPlatform("linux");
    await afterSign(createContext());
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("should return early when DAINTREE_SKIP_NOTARIZATION is set", async () => {
    process.env.DAINTREE_SKIP_NOTARIZATION = "true";
    mockExistsSync.mockReturnValue(true);
    await afterSign(createContext());
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[notarize-macos] Skipping notarization (DAINTREE_SKIP_NOTARIZATION=true)"
    );
  });

  it("should skip when credentials are missing", async () => {
    clearAppleCredentials();
    mockExistsSync.mockReturnValue(true);
    await afterSign(createContext());
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[notarize-macos] Apple API credentials not set — skipping notarization"
    );
  });

  it("should throw when .app bundle is missing", async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(afterSign(createContext())).rejects.toThrow(/App bundle not found/);
  });

  describe("fresh submission", () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
    });

    it("should submit, wait, and staple", async () => {
      mockExecFileSync
        .mockReturnValueOnce(JSON.stringify({ id: "sub-123", status: "In Progress" }))
        .mockReturnValueOnce(JSON.stringify({ id: "sub-123", status: "Accepted" }))
        .mockReturnValueOnce("stapled");

      await afterSign(createContext());

      expect(mockExecFileSync).toHaveBeenCalledTimes(3);

      const submitCall = mockExecFileSync.mock.calls[0];
      expect(submitCall[0]).toBe("xcrun");
      expect(submitCall[1]).toContain("notarytool");
      expect(submitCall[1]).toContain("submit");

      const waitCall = mockExecFileSync.mock.calls[1];
      expect(waitCall[1]).toContain("wait");
      expect(waitCall[1]).toContain("sub-123");
      expect(waitCall[1]).toContain("--timeout");

      const stapleCall = mockExecFileSync.mock.calls[2];
      expect(stapleCall[1]).toContain("stapler");
      expect(stapleCall[1]).toContain("staple");

      expect(mockWriteFileSync).toHaveBeenCalled();
      expect(mockRenameSync).toHaveBeenCalled();
    });

    it("should persist state immediately after submit, before wait", async () => {
      mockExecFileSync
        .mockReturnValueOnce(JSON.stringify({ id: "sub-456", status: "In Progress" }))
        .mockReturnValueOnce(JSON.stringify({ id: "sub-456", status: "Accepted" }))
        .mockReturnValueOnce("stapled");

      await afterSign(createContext());

      const tmpCallIndex = mockWriteFileSync.mock.calls.findIndex((c: any[]) =>
        c[0].endsWith(".tmp")
      );
      expect(tmpCallIndex).toBeGreaterThan(-1);

      const firstWrite = JSON.parse(mockWriteFileSync.mock.calls[tmpCallIndex][1]);
      expect(firstWrite["3"].status).toBe("submitted");
    });

    it("should throw when submit fails", async () => {
      const err = new Error("submit error");
      (err as any).stderr = "Network error";
      mockExecFileSync.mockImplementationOnce(() => {
        throw err;
      });

      await expect(afterSign(createContext())).rejects.toThrow(/Submission failed/);
    });

    it("should throw when submit returns non-JSON", async () => {
      mockExecFileSync.mockReturnValueOnce("not json {{{");

      await expect(afterSign(createContext())).rejects.toThrow(/Submission failed/);
    });

    it("should throw when submit returns no id", async () => {
      mockExecFileSync.mockReturnValueOnce(JSON.stringify({ status: "error" }));

      await expect(afterSign(createContext())).rejects.toThrow(/No submission ID/);
    });

    it("should throw when wait times out (exit 124)", async () => {
      mockExecFileSync.mockReturnValueOnce(
        JSON.stringify({ id: "sub-789", status: "In Progress" })
      );

      const err = new Error("timed out");
      (err as any).status = 124;
      mockExecFileSync.mockImplementationOnce(() => {
        throw err;
      });

      await expect(afterSign(createContext())).rejects.toThrow(
        /Notarization wait timed out.*sub-789/
      );

      // State was persisted with submission ID before the wait
      const tmpWrites = mockWriteFileSync.mock.calls.filter((c: any[]) => c[0].endsWith(".tmp"));
      const lastWrite = JSON.parse(tmpWrites[tmpWrites.length - 1][1]);
      expect(lastWrite["3"].submissionId).toBe("sub-789");
      expect(lastWrite["3"].status).toBe("submitted");
    });

    it("should throw when notarization is rejected", async () => {
      mockExecFileSync
        .mockReturnValueOnce(JSON.stringify({ id: "sub-000", status: "In Progress" }))
        .mockReturnValueOnce(JSON.stringify({ id: "sub-000", status: "Invalid" }));

      await expect(afterSign(createContext())).rejects.toThrow(/Notarization not accepted/);
    });

    it("should throw when staple fails", async () => {
      mockExecFileSync
        .mockReturnValueOnce(JSON.stringify({ id: "sub-111", status: "In Progress" }))
        .mockReturnValueOnce(JSON.stringify({ id: "sub-111", status: "Accepted" }));

      const err = new Error("staple error");
      (err as any).stderr = "staple failed";
      mockExecFileSync.mockImplementationOnce(() => {
        throw err;
      });

      await expect(afterSign(createContext())).rejects.toThrow(/Stapling failed/);
    });
  });

  describe("reattach from prior state", () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
    });

    it("should reattach instead of resubmitting", async () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          "3": { submissionId: "sub-existing", status: "submitted", timestamp: "2026-01-01" },
        })
      );
      mockExecFileSync
        .mockReturnValueOnce(JSON.stringify({ id: "sub-existing", status: "Accepted" }))
        .mockReturnValueOnce("stapled");

      await afterSign(createContext());

      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
      expect(mockExecFileSync.mock.calls[0][1]).toContain("wait");
      expect(mockExecFileSync.mock.calls[0][1]).toContain("sub-existing");
      expect(mockExecFileSync.mock.calls[1][1]).toContain("staple");
    });

    it("should throw on reattach timeout with submission ID", async () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          "3": { submissionId: "sub-existing", status: "submitted", timestamp: "2026-01-01" },
        })
      );

      const err = new Error("timed out");
      (err as any).status = 124;
      mockExecFileSync.mockImplementationOnce(() => {
        throw err;
      });

      await expect(afterSign(createContext())).rejects.toThrow(
        /Notarization wait timed out.*sub-existing/
      );
    });

    it("should throw when reattached wait returns not accepted", async () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          "3": { submissionId: "sub-existing", status: "submitted", timestamp: "2026-01-01" },
        })
      );
      mockExecFileSync.mockReturnValueOnce(
        JSON.stringify({ id: "sub-existing", status: "Invalid" })
      );

      await expect(afterSign(createContext())).rejects.toThrow(/Notarization not accepted/);
    });
  });

  describe("arch isolation", () => {
    it("should use context.arch as state key", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExecFileSync
        .mockReturnValueOnce(JSON.stringify({ id: "sub-x64", status: "In Progress" }))
        .mockReturnValueOnce(JSON.stringify({ id: "sub-x64", status: "Accepted" }))
        .mockReturnValueOnce("stapled");

      await afterSign(createContext({ arch: 1 }));

      const tmpWrites = mockWriteFileSync.mock.calls.filter((c: any[]) => c[0].endsWith(".tmp"));
      const stateWrite = JSON.parse(tmpWrites[0][1]);
      expect(stateWrite["1"]).toBeDefined();
      expect(stateWrite["1"].submissionId).toBe("sub-x64");
    });

    it("should not reattach when state has different arch", async () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          "1": { submissionId: "sub-x64", status: "submitted", timestamp: "2026-01-01" },
        })
      );
      mockExecFileSync
        .mockReturnValueOnce(JSON.stringify({ id: "sub-arm64", status: "In Progress" }))
        .mockReturnValueOnce(JSON.stringify({ id: "sub-arm64", status: "Accepted" }))
        .mockReturnValueOnce("stapled");

      await afterSign(createContext({ arch: 3 }));

      // First call should be submit (not wait), because arch 3 != 1
      expect(mockExecFileSync.mock.calls[0][1]).toContain("submit");
    });
  });

  describe("credential injection", () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
    });

    it("should pass Apple API credentials to notarytool", async () => {
      mockExecFileSync
        .mockReturnValueOnce(JSON.stringify({ id: "sub-cred", status: "In Progress" }))
        .mockReturnValueOnce(JSON.stringify({ id: "sub-cred", status: "Accepted" }))
        .mockReturnValueOnce("stapled");

      await afterSign(createContext());

      const submitArgs = mockExecFileSync.mock.calls[0][1];
      expect(submitArgs).toContain("--key");
      expect(submitArgs).toContain("/tmp/key.p8");
      expect(submitArgs).toContain("--key-id");
      expect(submitArgs).toContain("ABC123");
      expect(submitArgs).toContain("--issuer");
      expect(submitArgs).toContain("abc-123-456");
    });
  });
});
