import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import Module from "module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mockExecFileSync = vi.fn();
const mockSpawnSync = vi.fn();
const mockExistsSync = vi.fn();
const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

const originalPlatform = process.platform;
const originalCscLink = process.env.CSC_LINK;

afterAll(() => {
  consoleLogSpy.mockRestore();
  Object.defineProperty(process, "platform", { value: originalPlatform });
  if (originalCscLink === undefined) delete process.env.CSC_LINK;
  else process.env.CSC_LINK = originalCscLink;
});

function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", { value: platform });
}

function createContext(overrides: Record<string, any> = {}) {
  return {
    appOutDir: APP_OUT_DIR,
    packager: { appInfo: { productFilename: "Daintree" } },
    ...overrides,
  };
}

function mockFs() {
  return { existsSync: mockExistsSync };
}

const APP_OUT_DIR = join("/build", "mac-arm64");
const APP_PATH = join(APP_OUT_DIR, "Daintree.app");
const SPAWN_HELPER = join(
  APP_PATH,
  "Contents",
  "Resources",
  "app.asar.unpacked",
  "node_modules",
  "node-pty",
  "build",
  "Release",
  "spawn-helper"
);
const SUPERVISOR = join(
  APP_PATH,
  "Contents",
  "Resources",
  "app.asar.unpacked",
  "node_modules",
  "posix-pty-reaper",
  "build",
  "Release",
  "daintree_pty_supervisor"
);

/** The vendored Go assistant engine — spawned like any other helper. */
const ASSISTANT_ENGINE = join(APP_PATH, "Contents", "Resources", "assistant", "daintree-assistant");

const IDENTITY = "Developer ID Application: Greg Priday (ABCDE12345)";

function mockIdentity(value = IDENTITY) {
  mockSpawnSync.mockReturnValue({
    status: 0,
    stdout: "",
    stderr: `Executable=...\nAuthority=${value}\nAuthority=Developer ID Certification Authority\n`,
  });
}

describe("resign-helpers-macos", () => {
  let resignHelpers: (context: any) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy.mockImplementation(() => {});
    setPlatform("darwin");
    process.env.CSC_LINK = "/tmp/cert.p12";
    mockExistsSync.mockReturnValue(true);

    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (id: string) {
      if (id === "fs") return mockFs();
      if (id === "child_process")
        return { execFileSync: mockExecFileSync, spawnSync: mockSpawnSync };
      return originalRequire.apply(this, [id]);
    };

    try {
      delete require.cache[require.resolve("./resign-helpers-macos.cjs")];
      resignHelpers = require("./resign-helpers-macos.cjs").resignHelpers;
    } finally {
      Module.prototype.require = originalRequire;
    }
  });

  it("returns early on non-macOS", async () => {
    setPlatform("linux");
    await resignHelpers(createContext());
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("returns early when CSC_LINK is unset (unsigned dev build)", async () => {
    delete process.env.CSC_LINK;
    await resignHelpers(createContext());
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("throws when the .app bundle is missing", async () => {
    mockExistsSync.mockImplementation((p: string) => p !== APP_PATH);
    await expect(resignHelpers(createContext())).rejects.toThrow(/App bundle not found/);
  });

  it("throws when a helper executable is missing", async () => {
    mockExistsSync.mockImplementation((p: string) => p !== SPAWN_HELPER);
    await expect(resignHelpers(createContext())).rejects.toThrow(/Helper executable not found/);
  });

  it("throws when no Developer ID Application identity is found", async () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "Authority=Apple Development: someone\n",
    });
    await expect(resignHelpers(createContext())).rejects.toThrow(/Developer ID Application/);
  });

  it("surfaces codesign stderr when inspection exits non-zero (unsigned app)", async () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "code object is not signed at all",
      error: undefined,
    });
    await expect(resignHelpers(createContext())).rejects.toThrow(
      /codesign -dvv exited 1.*not signed/
    );
    // No signing attempted when the identity could not be read.
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("does not attempt the bundle reseal when a helper re-sign fails", async () => {
    mockIdentity();
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("codesign: helper sign failed");
    });
    await expect(resignHelpers(createContext())).rejects.toThrow(/helper sign failed/);
    // Only the first helper sign was attempted; the second helper and the
    // reseal must not run on a half-signed bundle.
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("re-signs every helper then repairs the bundle seal, in order", async () => {
    mockIdentity();
    await resignHelpers(createContext());

    // The assistant engine is a spawned helper like the other two: signed through
    // mac.binaries it inherits the app's restricted audio-input entitlement, and
    // Tahoe's amfid kills a spawned executable claiming one. Missing it would ship an
    // app that signs, notarizes and launches — with an assistant that never starts.
    expect(mockExecFileSync).toHaveBeenCalledTimes(4);
    const targets = mockExecFileSync.mock.calls.map((c: any[]) => c[1][c[1].length - 1]);
    expect(targets).toEqual([SPAWN_HELPER, SUPERVISOR, ASSISTANT_ENGINE, APP_PATH]);
    // Every codesign invocation is the codesign binary.
    for (const call of mockExecFileSync.mock.calls) {
      expect(call[0]).toBe("codesign");
    }
  });

  it("signs each helper with empty entitlements and hardened runtime", async () => {
    mockIdentity();
    await resignHelpers(createContext());

    for (const helper of [SPAWN_HELPER, SUPERVISOR, ASSISTANT_ENGINE]) {
      const call = mockExecFileSync.mock.calls.find((c: any[]) => c[1][c[1].length - 1] === helper);
      expect(call).toBeDefined();
      const args: string[] = call![1];
      expect(args).toContain("--force");
      expect(args).toContain("--options");
      expect(args[args.indexOf("--options") + 1]).toBe("runtime");
      expect(args).toContain("--entitlements");
      expect(args[args.indexOf("--entitlements") + 1]).toMatch(
        /build[/\\]entitlements\.helpers\.plist$/
      );
      expect(args).toContain("--sign");
      expect(args[args.indexOf("--sign") + 1]).toBe(IDENTITY);
    }
  });

  it("preserves identifier, entitlements, and flags on the bundle reseal", async () => {
    mockIdentity();
    await resignHelpers(createContext());

    const sealCall = mockExecFileSync.mock.calls.find(
      (c: any[]) => c[1][c[1].length - 1] === APP_PATH
    );
    expect(sealCall).toBeDefined();
    const args: string[] = sealCall![1];
    expect(args).toContain("--preserve-metadata=identifier,entitlements,flags");
    // The seal reseal must NOT pass --entitlements (it would override the app's own).
    expect(args).not.toContain("--entitlements");
  });

  it("ships a helpers entitlements plist with zero entitlement keys", () => {
    // Guards against the plist silently accruing entitlements — the whole point
    // is that the helpers carry none, or amfid kills them again on macOS 26.
    const plist = readFileSync(
      join(__dirname, "..", "build", "entitlements.helpers.plist"),
      "utf-8"
    );
    expect(plist).not.toMatch(/<key>/);
  });

  it("keeps helper entitlements comments XML-compatible for codesign", () => {
    const plist = readFileSync(
      join(__dirname, "..", "build", "entitlements.helpers.plist"),
      "utf-8"
    );
    const comments = plist.match(/<!--[\s\S]*?-->/g) ?? [];
    expect(comments.length).toBeGreaterThan(0);
    for (const comment of comments) {
      expect(comment.slice(4, -3)).not.toContain("--");
    }
  });
});
