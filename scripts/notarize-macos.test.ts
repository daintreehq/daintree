import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import path from "path";
import Module from "module";

const mockExecFileSync = vi.fn();
const mockSpawnSync = vi.fn();
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

const BUNDLE_CDHASH = "887831fb4cf162bf70182271b4b571a62ff7d7da";
const REBUILT_CDHASH = "0b1d2c3e4f5061728394a5b6c7d8e9f001122334";
const X64_CDHASH = "5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081";
const BUNDLE_ID = `arm64=${BUNDLE_CDHASH}`;
const APP_PATH = "/build/mac-arm64/Daintree.app";

function codesignDisplay(cdhash: string) {
  return {
    status: 0,
    stdout: "",
    stderr: [
      "Executable=/build/mac-arm64/Daintree.app/Contents/MacOS/Daintree",
      "Identifier=org.daintree.app",
      "Hash type=sha256 size=32",
      `CandidateCDHash sha256=${cdhash}`,
      `CDHash=${cdhash}`,
      "TeamIdentifier=D9674SJ8J4",
      "",
    ].join("\n"),
  };
}

function stateWrites(): any[] {
  return mockWriteFileSync.mock.calls
    .filter((c: any[]) => c[0].endsWith(".tmp"))
    .map((c: any[]) => JSON.parse(c[1]));
}

function execOrder(): string[] {
  return mockExecFileSync.mock.calls.map((c: any[]) =>
    c[0] === "ditto" ? "ditto" : c[1].slice(0, 3).join(" ")
  );
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
    // Staple-failure tests install a persistent throwing implementation.
    mockExecFileSync.mockReset();
    mockSpawnSync.mockReset();
    mockSpawnSync.mockReturnValue(codesignDisplay(BUNDLE_CDHASH));
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
      if (id === "path") return path.posix;
      if (id === "child_process")
        return { execFileSync: mockExecFileSync, spawnSync: mockSpawnSync };
      // Helper re-signing (#9775) is exercised by its own test; no-op it here so
      // these assertions stay focused on notarization codesign call counts.
      if (id === "./resign-helpers-macos.cjs") return { resignHelpers: async () => {} };
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
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("should return early when DAINTREE_SKIP_NOTARIZATION is set", async () => {
    process.env.DAINTREE_SKIP_NOTARIZATION = "true";
    mockExistsSync.mockReturnValue(true);
    await afterSign(createContext());
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("should skip when credentials are missing", async () => {
    clearAppleCredentials();
    mockExistsSync.mockReturnValue(true);
    await afterSign(createContext());
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
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

      expect(mockSpawnSync).toHaveBeenCalledWith(
        "codesign",
        ["-dvvv", "--arch", "arm64", APP_PATH],
        expect.anything()
      );
      expect(stateWrites().map((w) => [w["3"].status, w["3"].cdhash])).toEqual([
        ["submitted", BUNDLE_ID],
        ["accepted", BUNDLE_ID],
        ["stapled", BUNDLE_ID],
      ]);
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

      const rejection = afterSign(createContext());
      await expect(rejection).rejects.toThrow(/Notarization wait timed out.*sub-789/);
      await expect(rejection).rejects.toThrow(/xcrun notarytool info sub-789/);
      await expect(rejection).rejects.toThrow(/fresh CI runner rebuilds and submits again/);
      await expect(rejection).rejects.not.toThrow(/Re-run the workflow to reattach/);

      // State was persisted with submission ID and bundle identity before the wait
      const lastWrite = stateWrites().at(-1);
      expect(lastWrite["3"].submissionId).toBe("sub-789");
      expect(lastWrite["3"].status).toBe("submitted");
      expect(lastWrite["3"].cdhash).toBe(BUNDLE_ID);
    });

    it("should throw when notarization is rejected", async () => {
      mockExecFileSync
        .mockReturnValueOnce("") // ditto
        .mockReturnValueOnce(JSON.stringify({ id: "sub-000", status: "In Progress" }))
        .mockReturnValueOnce(JSON.stringify({ id: "sub-000", status: "Invalid" }));

      await expect(afterSign(createContext())).rejects.toThrow(/Notarization not accepted/);
    });

    it("should throw when staple keeps failing", async () => {
      vi.useFakeTimers();
      try {
        mockExecFileSync
          .mockReturnValueOnce("") // ditto
          .mockReturnValueOnce(JSON.stringify({ id: "sub-111", status: "In Progress" }))
          .mockReturnValueOnce(JSON.stringify({ id: "sub-111", status: "Accepted" }));

        const err = new Error("staple error");
        (err as any).stdout = "CloudKit query failed";
        mockExecFileSync.mockImplementation(() => {
          throw err;
        });

        const rejected = expect(afterSign(createContext())).rejects.toThrow(
          /Stapling failed[\s\S]*CloudKit query failed/
        );
        await vi.runAllTimersAsync();
        await rejected;

        expect(
          mockExecFileSync.mock.calls.filter((c: any[]) => c[1].includes("stapler")).length
        ).toBeGreaterThan(1);

        // State should be left as "accepted" so a run with the same bundle can staple-only
        const lastWrite = stateWrites().at(-1);
        expect(lastWrite["3"].status).toBe("accepted");
        expect(lastWrite["3"].cdhash).toBe(BUNDLE_ID);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should staple after a transient stapler failure", async () => {
      vi.useFakeTimers();
      try {
        mockExecFileSync
          .mockReturnValueOnce("") // ditto
          .mockReturnValueOnce(JSON.stringify({ id: "sub-222", status: "In Progress" }))
          .mockReturnValueOnce(JSON.stringify({ id: "sub-222", status: "Accepted" }))
          .mockImplementationOnce(() => {
            throw Object.assign(new Error("staple error"), {
              stdout: "The network connection was lost.",
            });
          })
          .mockReturnValueOnce("stapled");

        const stapleCalls = () =>
          mockExecFileSync.mock.calls.filter((c: any[]) => c[1].includes("stapler")).length;
        const done = afterSign(createContext());
        await vi.advanceTimersByTimeAsync(0);
        // The retry waits on a timer rather than firing straight away.
        expect(stapleCalls()).toBe(1);
        await Promise.all([done, vi.runAllTimersAsync()]);

        expect(stapleCalls()).toBe(2);
        const tmpWrites = mockWriteFileSync.mock.calls.filter((c: any[]) => c[0].endsWith(".tmp"));
        const lastWrite = JSON.parse(tmpWrites[tmpWrites.length - 1][1]);
        expect(lastWrite["3"].status).toBe("stapled");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("reattach from submitted state", () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
    });

    it("should reattach via wait instead of resubmitting", async () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          "3": {
            submissionId: "sub-existing",
            status: "submitted",
            cdhash: BUNDLE_ID,
            timestamp: "2026-01-01",
          },
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
      expect(stateWrites().map((w) => [w["3"].status, w["3"].cdhash])).toEqual([
        ["accepted", BUNDLE_ID],
        ["stapled", BUNDLE_ID],
      ]);
    });

    it("should throw on reattach timeout with submission ID", async () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          "3": {
            submissionId: "sub-existing",
            status: "submitted",
            cdhash: BUNDLE_ID,
            timestamp: "2026-01-01",
          },
        })
      );

      const err = new Error("timed out");
      (err as any).status = 124;
      mockExecFileSync.mockImplementationOnce(() => {
        throw err;
      });

      const rejection = afterSign(createContext());
      await expect(rejection).rejects.toThrow(/Notarization wait timed out.*sub-existing/);
      await expect(rejection).rejects.toThrow(/xcrun notarytool info sub-existing/);
      await expect(rejection).rejects.toThrow(/fresh CI runner rebuilds and submits again/);
    });
  });

  describe("staple-only from accepted state", () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
    });

    it("should staple directly without submit or wait", async () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          "3": {
            submissionId: "sub-accepted",
            status: "accepted",
            cdhash: BUNDLE_ID,
            timestamp: "2026-01-01",
          },
        })
      );
      mockExecFileSync.mockReturnValueOnce("stapled");

      await afterSign(createContext());

      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      const stapleCall = mockExecFileSync.mock.calls[0];
      expect(stapleCall[1]).toContain("stapler");
      expect(stapleCall[1]).toContain("staple");
      expect(stateWrites().map((w) => [w["3"].status, w["3"].cdhash])).toEqual([
        ["stapled", BUNDLE_ID],
      ]);
    });

    it("should throw when staple fails in recovery", async () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          "3": {
            submissionId: "sub-accepted",
            status: "accepted",
            cdhash: BUNDLE_ID,
            timestamp: "2026-01-01",
          },
        })
      );

      vi.useFakeTimers();
      try {
        const err = new Error("staple error");
        (err as any).stderr = "staple failed";
        mockExecFileSync.mockImplementation(() => {
          throw err;
        });

        const rejected = expect(afterSign(createContext())).rejects.toThrow(/Stapling failed/);
        await vi.runAllTimersAsync();
        await rejected;

        expect(
          mockExecFileSync.mock.calls.filter((c: any[]) => c[1].includes("stapler")).length
        ).toBeGreaterThan(1);

        // State should remain "accepted" for retry
        const tmpWrites = mockWriteFileSync.mock.calls.filter((c: any[]) => c[0].endsWith(".tmp"));
        expect(tmpWrites.length).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("rebuilt bundle", () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockSpawnSync.mockReturnValue(codesignDisplay(REBUILT_CDHASH));
    });

    it.each(["accepted", "submitted"])(
      "submits fresh instead of resuming a %s submission for another bundle",
      async (status) => {
        mockReadFileSync.mockReturnValue(
          JSON.stringify({
            "3": { submissionId: "sub-old", status, cdhash: BUNDLE_ID, timestamp: "2026-01-01" },
          })
        );
        mockExecFileSync
          .mockReturnValueOnce("") // ditto
          .mockReturnValueOnce(JSON.stringify({ id: "sub-new", status: "In Progress" }))
          .mockReturnValueOnce(JSON.stringify({ id: "sub-new", status: "Accepted" }))
          .mockReturnValueOnce("stapled");

        await afterSign(createContext());

        expect(execOrder()).toEqual([
          "ditto",
          "notarytool submit /tmp/daintree-notarize-xxxx/Daintree.zip",
          "notarytool wait sub-new",
          "stapler staple /build/mac-arm64/Daintree.app",
        ]);
        expect(mockExecFileSync.mock.calls.flat().join(" ")).not.toContain("sub-old");
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringMatching(/Not resuming.*sub-old/));
        expect(
          stateWrites().map((w) => [w["3"].submissionId, w["3"].status, w["3"].cdhash])
        ).toEqual([
          ["sub-new", "submitted", `arm64=${REBUILT_CDHASH}`],
          ["sub-new", "accepted", `arm64=${REBUILT_CDHASH}`],
          ["sub-new", "stapled", `arm64=${REBUILT_CDHASH}`],
        ]);
      }
    );
  });

  describe("legacy and malformed state entries", () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync
        .mockReturnValueOnce("") // ditto
        .mockReturnValueOnce(JSON.stringify({ id: "sub-fresh", status: "In Progress" }))
        .mockReturnValueOnce(JSON.stringify({ id: "sub-fresh", status: "Accepted" }))
        .mockReturnValueOnce("stapled");
    });

    it.each(["accepted", "submitted"])(
      "submits fresh for a %s entry with no recorded bundle identity",
      async (status) => {
        mockReadFileSync.mockReturnValue(
          JSON.stringify({ "3": { submissionId: "sub-legacy", status, timestamp: "2026-01-01" } })
        );

        await afterSign(createContext());

        expect(execOrder()[0]).toBe("ditto");
        expect(execOrder()[1]).toMatch(/^notarytool submit/);
        expect(mockExecFileSync.mock.calls.flat().join(" ")).not.toContain("sub-legacy");
        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringMatching(/Not resuming.*sub-legacy.*CDHash none/)
        );
      }
    );

    it("submits fresh when the entry's submission ID is not a string", async () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ "3": { submissionId: 42, status: "accepted", cdhash: BUNDLE_ID } })
      );

      await afterSign(createContext());

      expect(execOrder()[1]).toMatch(/^notarytool submit/);
    });

    it.each(["[]", "5", '"state"', "null", "true"])(
      "warns and submits fresh when the state file holds %s",
      async (raw) => {
        mockReadFileSync.mockReturnValue(raw);

        await afterSign(createContext());

        expect(consoleWarnSpy).toHaveBeenCalledWith(
          "[notarize-macos] Notarization state file is not an object — starting fresh"
        );
        expect(execOrder()[1]).toMatch(/^notarytool submit/);
        expect(stateWrites()[0]).toEqual({ "3": expect.objectContaining({ status: "submitted" }) });
      }
    );
  });

  describe("unreadable bundle identity", () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          "3": { submissionId: "sub-old", status: "accepted", cdhash: BUNDLE_ID },
        })
      );
      mockExecFileSync
        .mockReturnValueOnce("") // ditto
        .mockReturnValueOnce(JSON.stringify({ id: "sub-new", status: "In Progress" }))
        .mockReturnValueOnce(JSON.stringify({ id: "sub-new", status: "Accepted" }))
        .mockReturnValueOnce("stapled");
    });

    // The first two rows still print the recorded CDHash, so only the exit
    // status and spawn-error checks keep them from matching.
    it.each([
      ["codesign exits non-zero", { ...codesignDisplay(BUNDLE_CDHASH), status: 1 }],
      [
        "codesign reports a spawn error",
        { ...codesignDisplay(BUNDLE_CDHASH), error: new Error("spawnSync codesign ETIMEDOUT") },
      ],
      ["no CDHash line", { status: 0, stdout: "", stderr: "Identifier=org.daintree.app\n" }],
    ])("submits fresh without resuming when %s", async (_label, result) => {
      mockSpawnSync.mockReturnValue(result);

      await afterSign(createContext());

      expect(execOrder()[0]).toBe("ditto");
      expect(mockExecFileSync.mock.calls.flat().join(" ")).not.toContain("sub-old");
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Could not read the code signature")
      );
      expect(stateWrites().map((w) => w["3"].cdhash)).toEqual([null, null, null]);
    });

    it.each(["accepted", "submitted"])(
      "submits fresh for a %s entry recorded without an identity when it still can't be read",
      async (status) => {
        mockReadFileSync.mockReturnValue(
          JSON.stringify({ "3": { submissionId: "sub-old", status, cdhash: null } })
        );
        mockSpawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "not signed at all" });

        await afterSign(createContext());

        expect(execOrder()[0]).toBe("ditto");
        expect(mockExecFileSync.mock.calls.flat().join(" ")).not.toContain("sub-old");
      }
    );
  });

  describe("universal bundle", () => {
    const UNIVERSAL_ID = `arm64=${BUNDLE_CDHASH},x86_64=${X64_CDHASH}`;

    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          "4": { submissionId: "sub-universal", status: "accepted", cdhash: UNIVERSAL_ID },
        })
      );
    });

    it("reads every slice and resumes when all of them match", async () => {
      mockSpawnSync.mockImplementation((_cmd: string, args: string[]) =>
        codesignDisplay(args.includes("x86_64") ? X64_CDHASH : BUNDLE_CDHASH)
      );
      mockExecFileSync.mockReturnValueOnce("stapled");

      await afterSign(createContext({ arch: 4 }));

      expect(mockSpawnSync.mock.calls.map((c: any[]) => c[1].slice(0, 3))).toEqual([
        ["-dvvv", "--arch", "arm64"],
        ["-dvvv", "--arch", "x86_64"],
      ]);
      expect(execOrder()).toEqual(["stapler staple /build/mac-arm64/Daintree.app"]);
    });

    it("submits fresh when only the x86_64 slice changed", async () => {
      mockSpawnSync.mockImplementation((_cmd: string, args: string[]) =>
        codesignDisplay(args.includes("x86_64") ? REBUILT_CDHASH : BUNDLE_CDHASH)
      );
      mockExecFileSync
        .mockReturnValueOnce("") // ditto
        .mockReturnValueOnce(JSON.stringify({ id: "sub-new", status: "In Progress" }))
        .mockReturnValueOnce(JSON.stringify({ id: "sub-new", status: "Accepted" }))
        .mockReturnValueOnce("stapled");

      await afterSign(createContext({ arch: 4 }));

      expect(execOrder()[1]).toMatch(/^notarytool submit/);
      expect(stateWrites().at(-1)["4"].cdhash).toBe(
        `arm64=${BUNDLE_CDHASH},x86_64=${REBUILT_CDHASH}`
      );
    });

    it("submits fresh when one slice cannot be read", async () => {
      mockSpawnSync.mockImplementation((_cmd: string, args: string[]) =>
        args.includes("x86_64")
          ? { status: 1, stdout: "", stderr: "object file format unrecognized" }
          : codesignDisplay(BUNDLE_CDHASH)
      );
      mockExecFileSync
        .mockReturnValueOnce("") // ditto
        .mockReturnValueOnce(JSON.stringify({ id: "sub-new", status: "In Progress" }))
        .mockReturnValueOnce(JSON.stringify({ id: "sub-new", status: "Accepted" }))
        .mockReturnValueOnce("stapled");

      await afterSign(createContext({ arch: 4 }));

      expect(execOrder()[1]).toMatch(/^notarytool submit/);
      expect(stateWrites().at(-1)["4"].cdhash).toBeNull();
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
      mockExistsSync.mockReturnValue(true);
      // The x64 entry carries the current bundle's identity, so only the arch
      // key keeps it from being resumed.
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          "1": {
            submissionId: "sub-x64",
            status: "submitted",
            cdhash: BUNDLE_ID,
            timestamp: "2026-01-01",
          },
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
      expect(stateWrites().at(-1)["1"]).toEqual(
        expect.objectContaining({ submissionId: "sub-x64", status: "submitted" })
      );
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
