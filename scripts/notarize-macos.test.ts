import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import path from "path";
import Module from "module";

const mockExecFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockRenameSync = vi.fn();
const mockMkdtempSync = vi.fn();
const mockRmSync = vi.fn();
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
    mkdtempSync: mockMkdtempSync,
    rmSync: mockRmSync,
  };
}

function mockOs() {
  return { tmpdir: () => "/tmp" };
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
    mockMkdtempSync.mockReturnValue("/tmp/daintree-notarize-xxxx");

    const originalRequire = Module.prototype.require;

    Module.prototype.require = function (id: string) {
      if (id === "fs") return mockFs();
      if (id === "os") return mockOs();
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
  });

  it("should skip when credentials are missing", async () => {
    clearAppleCredentials();
    mockExistsSync.mockReturnValue(true);
    await afterSign(createContext());
    expect(mockExecFileSync).not.toHaveBeenCalled();
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

    it("should zip, submit, wait, and staple", async () => {
      mockExecFileSync
        .mockReturnValueOnce("") // ditto zip
        .mockReturnValueOnce(JSON.stringify({ id: "sub-123", status: "In Progress" }))
        .mockReturnValueOnce(JSON.stringify({ id: "sub-123", status: "Accepted" }))
        .mockReturnValueOnce("stapled");

      await afterSign(createContext());

      expect(mockExecFileSync).toHaveBeenCalledTimes(4);

      // ditto zip
      const dittoCall = mockExecFileSync.mock.calls[0];
      expect(dittoCall[0]).toBe("ditto");
      expect(dittoCall[1]).toContain("-c");
      expect(dittoCall[1]).toContain("-k");

      // submit
      const submitCall = mockExecFileSync.mock.calls[1];
      expect(submitCall[0]).toBe("xcrun");
      expect(submitCall[1]).toContain("submit");

      // wait
      const waitCall = mockExecFileSync.mock.calls[2];
      expect(waitCall[1]).toContain("wait");
      expect(waitCall[1]).toContain("sub-123");
      expect(waitCall[1]).toContain("--timeout");

      // staple
      const stapleCall = mockExecFileSync.mock.calls[3];
      expect(stapleCall[1]).toContain("stapler");
      expect(stapleCall[1]).toContain("staple");

      // Cleanup
      expect(mockRmSync).toHaveBeenCalledWith("/tmp/daintree-notarize-xxxx", {
        recursive: true,
        force: true,
      });
    });

    it("should submit the zip, not the .app", async () => {
      mockExecFileSync
        .mockReturnValueOnce("") // ditto
        .mockReturnValueOnce(JSON.stringify({ id: "sub-zip", status: "In Progress" }))
        .mockReturnValueOnce(JSON.stringify({ id: "sub-zip", status: "Accepted" }))
        .mockReturnValueOnce("stapled");

      await afterSign(createContext());

      const submitArgs = mockExecFileSync.mock.calls[1][1];
      const submitPath = submitArgs[submitArgs.indexOf("submit") + 1];
      expect(submitPath).toContain(".zip");
      expect(submitPath).not.toContain(".app");
    });

    it("should persist state immediately after submit, before wait", async () => {
      mockExecFileSync
        .mockReturnValueOnce("") // ditto
        .mockReturnValueOnce(JSON.stringify({ id: "sub-456", status: "In Progress" }))
        .mockReturnValueOnce(JSON.stringify({ id: "sub-456", status: "Accepted" }))
        .mockReturnValueOnce("stapled");

      await afterSign(createContext());

      // Find the submission state persist (after submit, before wait)
      const tmpWrites = mockWriteFileSync.mock.calls.filter((c: any[]) => c[0].endsWith(".tmp"));
      const statuses = tmpWrites.map((c: any[]) => JSON.parse(c[1])["3"].status);
      expect(statuses).toContain("submitted");
    });

    it("should throw when ditto zip fails", async () => {
      const err = new Error("zip error");
      (err as any).stderr = "No space left on device";
      mockExecFileSync.mockImplementationOnce(() => {
        throw err;
      });

      await expect(afterSign(createContext())).rejects.toThrow(/Failed to zip app bundle/);
    });

    it("should throw when submit fails", async () => {
      mockExecFileSync.mockReturnValueOnce(""); // ditto
      const err = new Error("submit error");
      (err as any).stderr = "Network error";
      mockExecFileSync.mockImplementationOnce(() => {
        throw err;
      });

      await expect(afterSign(createContext())).rejects.toThrow(/Submission failed/);
    });

    it("should cleanup temp dir even when submit fails", async () => {
      mockExecFileSync.mockReturnValueOnce(""); // ditto
      const err = new Error("submit error");
      (err as any).stderr = "Network error";
      mockExecFileSync.mockImplementationOnce(() => {
        throw err;
      });

      await expect(afterSign(createContext())).rejects.toThrow();
      expect(mockRmSync).toHaveBeenCalled();
    });

    it("should throw when submit returns non-JSON", async () => {
      mockExecFileSync
        .mockReturnValueOnce("") // ditto
        .mockReturnValueOnce("not json {{{");

      await expect(afterSign(createContext())).rejects.toThrow(/Submission failed/);
    });

    it("should throw when submit returns no id", async () => {
      mockExecFileSync
        .mockReturnValueOnce("") // ditto
        .mockReturnValueOnce(JSON.stringify({ status: "error" }));

      await expect(afterSign(createContext())).rejects.toThrow(/No submission ID/);
    });

    it("should throw when wait times out (exit 124)", async () => {
      mockExecFileSync
        .mockReturnValueOnce("") // ditto
        .mockReturnValueOnce(JSON.stringify({ id: "sub-789", status: "In Progress" }));

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
        .mockReturnValueOnce("") // ditto
        .mockReturnValueOnce(JSON.stringify({ id: "sub-000", status: "In Progress" }))
        .mockReturnValueOnce(JSON.stringify({ id: "sub-000", status: "Invalid" }));

      await expect(afterSign(createContext())).rejects.toThrow(/Notarization not accepted/);
    });

    it("should throw when staple fails", async () => {
      mockExecFileSync
        .mockReturnValueOnce("") // ditto
        .mockReturnValueOnce(JSON.stringify({ id: "sub-111", status: "In Progress" }))
        .mockReturnValueOnce(JSON.stringify({ id: "sub-111", status: "Accepted" }));

      const err = new Error("staple error");
      (err as any).stderr = "staple failed";
      mockExecFileSync.mockImplementationOnce(() => {
        throw err;
      });

      await expect(afterSign(createContext())).rejects.toThrow(/Stapling failed/);

      // State should be left as "accepted" so recovery can staple-only
      const tmpWrites = mockWriteFileSync.mock.calls.filter((c: any[]) => c[0].endsWith(".tmp"));
      const lastWrite = JSON.parse(tmpWrites[tmpWrites.length - 1][1]);
      expect(lastWrite["3"].status).toBe("accepted");
    });
  });

  describe("reattach from submitted state", () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
    });

    it("should reattach via wait instead of resubmitting", async () => {
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
      expect(mockExecFileSync.mock.calls.flat().join(" ")).not.toContain("submit");
      expect(mockExecFileSync.mock.calls.flat().join(" ")).not.toContain("ditto");
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
  });

  describe("staple-only from accepted state", () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
    });

    it("should staple directly without submit or wait", async () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          "3": { submissionId: "sub-accepted", status: "accepted", timestamp: "2026-01-01" },
        })
      );
      mockExecFileSync.mockReturnValueOnce("stapled");

      await afterSign(createContext());

      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      const stapleCall = mockExecFileSync.mock.calls[0];
      expect(stapleCall[1]).toContain("stapler");
      expect(stapleCall[1]).toContain("staple");
    });

    it("should throw when staple fails in recovery", async () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          "3": { submissionId: "sub-accepted", status: "accepted", timestamp: "2026-01-01" },
        })
      );

      const err = new Error("staple error");
      (err as any).stderr = "staple failed";
      mockExecFileSync.mockImplementationOnce(() => {
        throw err;
      });

      await expect(afterSign(createContext())).rejects.toThrow(/Stapling failed/);

      // State should remain "accepted" for retry
      const tmpWrites = mockWriteFileSync.mock.calls.filter((c: any[]) => c[0].endsWith(".tmp"));
      expect(tmpWrites.length).toBe(0);
    });
  });

  describe("corrupted state file", () => {
    it("should warn and start fresh when state is unparseable", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("{{{ not json");

      mockExecFileSync
        .mockReturnValueOnce("") // ditto
        .mockReturnValueOnce(JSON.stringify({ id: "sub-fresh", status: "In Progress" }))
        .mockReturnValueOnce(JSON.stringify({ id: "sub-fresh", status: "Accepted" }))
        .mockReturnValueOnce("stapled");

      await afterSign(createContext());

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "[notarize-macos] Could not parse notarization state file — starting fresh"
      );
      // Should do a fresh submit (ditto + submit + wait + staple)
      expect(mockExecFileSync.mock.calls[1][1]).toContain("submit");
    });
  });

  describe("arch isolation", () => {
    it("should use context.arch as state key", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExecFileSync
        .mockReturnValueOnce("") // ditto
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
        .mockReturnValueOnce("") // ditto
        .mockReturnValueOnce(JSON.stringify({ id: "sub-arm64", status: "In Progress" }))
        .mockReturnValueOnce(JSON.stringify({ id: "sub-arm64", status: "Accepted" }))
        .mockReturnValueOnce("stapled");

      await afterSign(createContext({ arch: 3 }));

      // Should submit (not wait), because arch 3 !== 1
      expect(mockExecFileSync.mock.calls[1][1]).toContain("submit");
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
        .mockReturnValueOnce("") // ditto
        .mockReturnValueOnce(JSON.stringify({ id: "sub-cred", status: "In Progress" }))
        .mockReturnValueOnce(JSON.stringify({ id: "sub-cred", status: "Accepted" }))
        .mockReturnValueOnce("stapled");

      await afterSign(createContext());

      const submitArgs = mockExecFileSync.mock.calls[1][1];
      expect(submitArgs).toContain("--key");
      expect(submitArgs).toContain("/tmp/key.p8");
      expect(submitArgs).toContain("--key-id");
      expect(submitArgs).toContain("ABC123");
      expect(submitArgs).toContain("--issuer");
      expect(submitArgs).toContain("abc-123-456");
    });
  });
});
