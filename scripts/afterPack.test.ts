import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import path from "path";
import Module from "module";
import { Arch } from "electron-builder";
import { APP_ASAR_ROOT_ENTRIES, MAX_APP_ASAR_BYTES } from "./afterPack.cjs";

const mockExistsSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockCopyFileSync = vi.fn();
const mockStatSync = vi.fn();
const mockSpawnSync = vi.fn();
const mockGetRawHeader = vi.fn();
const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

// Headers are built from the guard's own contract rather than a second copy of
// it, so a policy change lands in one place. The tests below assert behaviour
// against that contract, never its literal value.
const asarHeader = (roots: readonly string[] = APP_ASAR_ROOT_ENTRIES) => ({
  header: { files: Object.fromEntries(roots.map((r) => [r, {}])) },
});

const originalDlopen = process.dlopen;

afterAll(() => {
  consoleSpy.mockRestore();
  warnSpy.mockRestore();
  process.dlopen = originalDlopen;
});

function createContext(platform: string, appOutDir: string, appName = "Daintree", arch?: number) {
  return {
    appOutDir,
    electronPlatformName: platform,
    arch,
    packager: { appInfo: { productFilename: appName } },
  };
}

describe("afterPack", () => {
  let afterPack: (context: any) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy.mockImplementation(() => {});
    warnSpy.mockImplementation(() => {});

    // Default: posix-pty-reaper supervisor execs cleanly (status 0, no error).
    mockSpawnSync.mockReturnValue({
      status: 0,
      error: null,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });

    // Default: a well-formed app.asar of a plausible size. The guard reads it
    // through statSync (never existsSync), so the call-order chains the tests
    // below drive mockExistsSync with stay aligned.
    mockStatSync.mockReturnValue({ size: 40 * 1024 * 1024 });
    mockGetRawHeader.mockReturnValue(asarHeader());

    // Both load probes (win-job-object and better-sqlite3's packaged prebuild)
    // are N-API addons — ABI-stable, so a successful dlopen under Node is the
    // passing case. Default: everything loads cleanly.
    process.dlopen = (() => {}) as typeof process.dlopen;

    const originalRequire = Module.prototype.require;

    Module.prototype.require = function (id: string) {
      if (id === "fs") {
        return {
          existsSync: mockExistsSync,
          readdirSync: mockReaddirSync,
          mkdirSync: mockMkdirSync,
          copyFileSync: mockCopyFileSync,
          statSync: mockStatSync,
        };
      }
      if (id === "child_process" || id === "node:child_process") {
        return { spawnSync: mockSpawnSync };
      }
      if (id === "@electron/asar") {
        return { getRawHeader: mockGetRawHeader };
      }
      return originalRequire.apply(this, [id]);
    };

    try {
      delete require.cache[require.resolve("./afterPack.cjs")];
      const module = require("./afterPack.cjs");
      afterPack = module.default;
    } finally {
      Module.prototype.require = originalRequire;
    }
  });

  describe("macOS", () => {
    const unpackedBase = "/build/mac/Daintree.app/Contents/Resources/app.asar.unpacked";

    it("should succeed when node-pty and better-sqlite3 exist", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac"));

      expect(mockExistsSync).toHaveBeenCalledWith(path.join(unpackedBase, "node_modules/node-pty"));
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/node-pty/build/Release/pty.node")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/better-sqlite3")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, `node_modules/better-sqlite3/prebuilds/darwin-${process.arch}.node`)
      );
    });

    it("should use productFilename in path construction", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac", "MyApp"));

      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(
          "/build/mac/MyApp.app/Contents/Resources/app.asar.unpacked",
          "node_modules/node-pty"
        )
      );
    });

    it("should log signing message on macOS", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac"));

      expect(consoleSpy).toHaveBeenCalledWith(
        "[afterPack] Native modules will be signed during code signing phase"
      );
    });

    it("should throw when node-pty directory is missing", async () => {
      mockExistsSync.mockReturnValue(false);

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /node-pty not found/
      );
    });

    it("should throw when pty.node binary is missing", async () => {
      mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /native binary not found/
      );
    });

    it("should throw when better-sqlite3 directory is missing", async () => {
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(true) // pty.node
        .mockReturnValueOnce(true) // posix-pty-reaper supervisor
        .mockReturnValueOnce(false) // Assets.car (macOS icon injection)
        .mockReturnValueOnce(false); // better-sqlite3 dir

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /better-sqlite3 not found/
      );
    });

    it("should throw when the better-sqlite3 prebuild is missing", async () => {
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(true) // pty.node
        .mockReturnValueOnce(true) // posix-pty-reaper supervisor
        .mockReturnValueOnce(false) // Assets.car (macOS icon injection)
        .mockReturnValueOnce(true) // better-sqlite3 dir
        .mockReturnValueOnce(false); // prebuilds/darwin-<arch>.node

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /better-sqlite3 prebuild not found/
      );
    });

    it("should throw when posix-pty-reaper supervisor binary is missing", async () => {
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(true) // pty.node
        .mockReturnValueOnce(false); // posix-pty-reaper supervisor

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /posix-pty-reaper supervisor binary not found/
      );
    });

    it("should verify the posix-pty-reaper supervisor binary path", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac"));

      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(
          unpackedBase,
          "node_modules/posix-pty-reaper/build/Release/daintree_pty_supervisor"
        )
      );
    });
  });

  describe("Windows", () => {
    const unpackedBase = "/build/win/resources/app.asar.unpacked";

    it("should succeed when compiled binaries and conpty exist", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("win32", "/build/win"));

      expect(mockExistsSync).toHaveBeenCalledWith(path.join(unpackedBase, "node_modules/node-pty"));
      // Compiled binaries in build/Release
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/node-pty/build/Release/conpty.node")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/node-pty/build/Release/conpty_console_list.node")
      );
      // Post-install conpty binaries
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/node-pty/build/Release/conpty/conpty.dll")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/node-pty/build/Release/conpty/OpenConsole.exe")
      );
    });

    it("should throw when compiled binary is missing", async () => {
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(false); // conpty.node missing

      await expect(afterPack(createContext("win32", "/build/win"))).rejects.toThrow(
        /Windows node-pty compiled binary not found/
      );
    });

    it("should copy conpty from third_party when missing from build/Release", async () => {
      const nodePtyPath = path.join(unpackedBase, "node_modules/node-pty");
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(true) // conpty.node
        .mockReturnValueOnce(true) // conpty_console_list.node
        .mockReturnValueOnce(false) // conpty/conpty.dll missing (triggers fallback)
        .mockReturnValueOnce(true) // third_party/conpty exists
        .mockReturnValueOnce(true) // sourceDir exists
        .mockReturnValue(true); // final validation passes

      mockReaddirSync.mockReturnValue(["1.25.260303002"]);

      await afterPack(createContext("win32", "/build/win"));

      expect(mockMkdirSync).toHaveBeenCalledWith(path.join(nodePtyPath, "build/Release/conpty"), {
        recursive: true,
      });
      expect(mockCopyFileSync).toHaveBeenCalledTimes(2);
    });

    it("should throw when third_party/conpty is missing for fallback", async () => {
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(true) // conpty.node
        .mockReturnValueOnce(true) // conpty_console_list.node
        .mockReturnValueOnce(false) // conpty/conpty.dll missing
        .mockReturnValueOnce(false); // third_party/conpty missing

      await expect(afterPack(createContext("win32", "/build/win"))).rejects.toThrow(
        /third_party\/conpty not found/
      );
    });

    it("should not log signing message on Windows", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("win32", "/build/win"));

      expect(consoleSpy).not.toHaveBeenCalledWith(
        "[afterPack] Native modules will be signed during code signing phase"
      );
    });

    it("should throw when node-pty directory is missing", async () => {
      mockExistsSync.mockReturnValue(false);

      await expect(afterPack(createContext("win32", "/build/win"))).rejects.toThrow(
        /node-pty not found/
      );
    });
  });

  describe("Linux", () => {
    const unpackedBase = "/build/linux/resources/app.asar.unpacked";

    it("should succeed with Linux resource path", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("linux", "/build/linux"));

      expect(mockExistsSync).toHaveBeenCalledWith(path.join(unpackedBase, "node_modules/node-pty"));
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/node-pty/build/Release/pty.node")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/better-sqlite3")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, `node_modules/better-sqlite3/prebuilds/linux-${process.arch}.node`)
      );
    });

    it("should not log signing message on Linux", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("linux", "/build/linux"));

      expect(consoleSpy).not.toHaveBeenCalledWith(
        "[afterPack] Native modules will be signed during code signing phase"
      );
    });

    it("should throw when node-pty directory is missing", async () => {
      mockExistsSync.mockReturnValue(false);

      await expect(afterPack(createContext("linux", "/build/linux"))).rejects.toThrow(
        /node-pty not found/
      );
    });

    it("should throw when pty.node binary is missing", async () => {
      mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);

      await expect(afterPack(createContext("linux", "/build/linux"))).rejects.toThrow(
        /native binary not found/
      );
    });

    it("should throw when posix-pty-reaper supervisor binary is missing", async () => {
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(true) // pty.node
        .mockReturnValueOnce(false); // posix-pty-reaper supervisor

      await expect(afterPack(createContext("linux", "/build/linux"))).rejects.toThrow(
        /posix-pty-reaper supervisor binary not found/
      );
    });

    it("should verify the posix-pty-reaper supervisor binary path", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("linux", "/build/linux"));

      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(
          unpackedBase,
          "node_modules/posix-pty-reaper/build/Release/daintree_pty_supervisor"
        )
      );
    });
  });

  describe("better-sqlite3 prebuild validation", () => {
    // The packaged prebuild is probed with dlopen only when it targets the
    // runner's own platform and arch (N-API polarity: loading successfully
    // under Node proves the binary is sound). Cross-target packages get a
    // presence check. Contexts are built from process.platform/process.arch
    // so these tests are deterministic on any runner.
    const runnerPlatform = process.platform as "darwin" | "linux" | "win32";
    const runnerOutDir =
      runnerPlatform === "darwin"
        ? "/build/mac"
        : runnerPlatform === "win32"
          ? "/build/win"
          : "/build/linux";
    const runnerArchEnum = process.arch === "arm64" ? Arch.arm64 : Arch.x64;

    it("probes the prebuild when it targets the runner platform and arch", async () => {
      mockExistsSync.mockReturnValue(true);
      const dlopenCalls: string[] = [];
      process.dlopen = ((_mod: unknown, filename: string) => {
        dlopenCalls.push(filename);
      }) as typeof process.dlopen;

      await afterPack(createContext(runnerPlatform, runnerOutDir, "Daintree", runnerArchEnum));

      expect(
        dlopenCalls.some((c) =>
          c.includes(path.join("prebuilds", `${runnerPlatform}-${process.arch}.node`))
        )
      ).toBe(true);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("better-sqlite3 load check passed")
      );
    });

    it("throws when the runner-native prebuild fails to load", async () => {
      mockExistsSync.mockReturnValue(true);
      process.dlopen = ((_mod: unknown, filename: string) => {
        if (filename.includes("prebuilds")) {
          throw new Error("dlopen failed: missing symbol");
        }
      }) as typeof process.dlopen;

      await expect(
        afterPack(createContext(runnerPlatform, runnerOutDir, "Daintree", runnerArchEnum))
      ).rejects.toThrow(/better-sqlite3 prebuild failed to load/);
    });

    it("skips the load probe for a cross-arch package", async () => {
      mockExistsSync.mockReturnValue(true);
      const crossArchEnum = process.arch === "arm64" ? Arch.x64 : Arch.arm64;
      const dlopenCalls: string[] = [];
      process.dlopen = ((_mod: unknown, filename: string) => {
        dlopenCalls.push(filename);
      }) as typeof process.dlopen;

      await afterPack(createContext("linux", "/build/linux", "Daintree", crossArchEnum));

      expect(dlopenCalls.some((c) => c.includes("prebuilds"))).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("better-sqlite3 prebuild present (cross-target)")
      );
    });

    it("requires both darwin prebuilds for a universal package", async () => {
      // The merged app carries both slices. Arch comes from builder-util rather
      // than a copied literal: electron-builder hands the hook whatever the real
      // enum says, so if that value ever moves, the hook's own constant goes
      // stale and this assertion catches it. It went unnoticed once already —
      // the hook checked 5 while the enum said 4, silently validating a single
      // arch on every universal release build.
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac", "Daintree", Arch.universal));

      const unpackedBase = "/build/mac/Daintree.app/Contents/Resources/app.asar.unpacked";
      for (const arch of ["x64", "arm64"]) {
        expect(mockExistsSync).toHaveBeenCalledWith(
          path.join(unpackedBase, `node_modules/better-sqlite3/prebuilds/darwin-${arch}.node`)
        );
      }
    });

    it("throws when a universal package is missing one darwin prebuild", async () => {
      mockExistsSync.mockImplementation((p) => !String(p).includes("darwin-x64.node"));

      await expect(
        afterPack(createContext("darwin", "/build/mac", "Daintree", Arch.universal))
      ).rejects.toThrow(/better-sqlite3 prebuild not found/);
    });
  });

  describe("win-job-object load validation", () => {
    it("should pass on Windows when win_job_object.node dlopens successfully", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("win32", "/build/win"));

      expect(consoleSpy).toHaveBeenCalledWith(
        "[afterPack] win-job-object load check passed (all transitive dependencies resolved)"
      );
    });

    it("should dlopen the exact win_job_object.node path", async () => {
      mockExistsSync.mockReturnValue(true);
      const dlopenCalls: string[] = [];
      process.dlopen = ((_mod: unknown, filename: string) => {
        dlopenCalls.push(filename);
      }) as typeof process.dlopen;

      await afterPack(createContext("win32", "/build/win"));

      expect(dlopenCalls).toContain(
        path.join(
          "/build/win/resources/app.asar.unpacked",
          "node_modules/win-job-object/build/Release/win_job_object.node"
        )
      );
    });

    it("should throw when win_job_object.node fails to load (missing transitive DLL)", async () => {
      mockExistsSync.mockReturnValue(true);
      process.dlopen = ((_mod: unknown, filename: string) => {
        if (filename.includes("win_job_object")) {
          throw new Error("The specified module could not be found");
        }
        throw new Error("NODE_MODULE_VERSION mismatch");
      }) as typeof process.dlopen;

      await expect(afterPack(createContext("win32", "/build/win"))).rejects.toThrow(
        /win-job-object failed to load/
      );
    });

    it("should skip win-job-object dlopen when packaging a different Windows arch", async () => {
      mockExistsSync.mockReturnValue(true);
      const crossArch = process.arch === "arm64" ? Arch.x64 : Arch.arm64;
      const dlopenCalls: string[] = [];
      process.dlopen = ((_mod: unknown, filename: string) => {
        dlopenCalls.push(filename);
        if (filename.includes("win_job_object")) {
          throw new Error("not a valid Win32 application");
        }
        throw new Error("NODE_MODULE_VERSION mismatch");
      }) as typeof process.dlopen;

      await afterPack(createContext("win32", "/build/win", "Daintree", crossArch));

      expect(dlopenCalls.some((c) => c.includes("win_job_object"))).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Skipping win-job-object load check")
      );
    });

    it("should not probe win-job-object on non-Windows platforms", async () => {
      mockExistsSync.mockReturnValue(true);
      const dlopenCalls: string[] = [];
      process.dlopen = ((_mod: unknown, filename: string) => {
        dlopenCalls.push(filename);
      }) as typeof process.dlopen;

      await afterPack(createContext("linux", "/build/linux"));

      expect(dlopenCalls.some((c) => c.includes("win_job_object"))).toBe(false);
    });
  });

  describe("posix-pty-reaper exec validation", () => {
    it("should exec the supervisor with empty stdin on macOS/Linux", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("linux", "/build/linux"));

      expect(mockSpawnSync).toHaveBeenCalledWith(
        path.join(
          "/build/linux/resources/app.asar.unpacked",
          "node_modules/posix-pty-reaper/build/Release/daintree_pty_supervisor"
        ),
        [],
        expect.objectContaining({ input: "", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 })
      );
      expect(consoleSpy).toHaveBeenCalledWith("[afterPack] posix-pty-reaper exec check passed");
    });

    it("should exec the supervisor with the exact macOS supervisor path", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac"));

      expect(mockSpawnSync).toHaveBeenCalledWith(
        path.join(
          "/build/mac/Daintree.app/Contents/Resources/app.asar.unpacked",
          "node_modules/posix-pty-reaper/build/Release/daintree_pty_supervisor"
        ),
        [],
        expect.objectContaining({ input: "", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 })
      );
    });

    it("should throw when the supervisor fails to exec (spawn error)", async () => {
      mockExistsSync.mockReturnValue(true);
      mockSpawnSync.mockReturnValue({
        status: null,
        error: new Error("spawn ENOENT"),
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
      });

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /posix-pty-reaper supervisor failed to exec/
      );
    });

    it("should throw when the supervisor exits with a non-zero status", async () => {
      mockExistsSync.mockReturnValue(true);
      mockSpawnSync.mockReturnValue({
        status: 1,
        error: null,
        stdout: Buffer.from(""),
        stderr: Buffer.from("dyld: missing symbol"),
      });

      await expect(afterPack(createContext("linux", "/build/linux"))).rejects.toThrow(
        /posix-pty-reaper supervisor exited with status 1/
      );
    });

    it("skips the exec probe for the foreign slice of a universal build", async () => {
      // A universal build packs x64 and arm64 separately before merging, so one
      // slice is always foreign to the runner. Exec'ing it fails with EBADARCH
      // on a correctly packaged app and took down the whole macOS universal
      // target before the merge was even attempted.
      mockExistsSync.mockReturnValue(true);
      const foreignArch = process.arch === "arm64" ? Arch.x64 : Arch.arm64;

      await afterPack(createContext("darwin", "/build/mac", "Daintree", foreignArch));

      expect(mockSpawnSync).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Skipping posix-pty-reaper exec check")
      );
    });

    it("still execs the merged universal binary", async () => {
      // The merged binary carries both slices, so it runs on either runner —
      // skipping it would drop the probe on the artifact that actually ships.
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac", "Daintree", Arch.universal));

      expect(mockSpawnSync).toHaveBeenCalled();
    });

    it("still execs the runner-native slice of a universal build", async () => {
      // Without this, an implementation that skips every concrete arch — not
      // just the foreign one — passes the whole suite while probing nothing.
      mockExistsSync.mockReturnValue(true);
      const nativeArch = process.arch === "arm64" ? Arch.arm64 : Arch.x64;

      await afterPack(createContext("darwin", "/build/mac", "Daintree", nativeArch));

      expect(mockSpawnSync).toHaveBeenCalled();
    });

    it("probes rather than skips an arch it does not recognise", async () => {
      // Skipping reduces validation, so it has to be a decision about a
      // known-foreign slice. A future builder-util enum value must not silently
      // disable the probe.
      mockExistsSync.mockReturnValue(true);
      const unknownArch =
        Math.max(...Object.values(Arch).filter((v): v is number => typeof v === "number")) + 1;

      await afterPack(createContext("linux", "/build/linux", "Daintree", unknownArch));

      expect(mockSpawnSync).toHaveBeenCalled();
    });

    it("should not exec the supervisor on Windows", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("win32", "/build/win"));

      expect(mockSpawnSync).not.toHaveBeenCalled();
    });
  });

  describe("logging", () => {
    it("should log platform and output directory", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac"));

      expect(consoleSpy).toHaveBeenCalledWith("[afterPack] Platform: darwin");
      expect(consoleSpy).toHaveBeenCalledWith("[afterPack] Output directory: /build/mac");
    });

    it("should log completion on success", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac"));

      expect(consoleSpy).toHaveBeenCalledWith("[afterPack] Complete - native modules validated");
    });
  });

  describe("app.asar packaging guard (#11475)", () => {
    const OVER_CEILING = /over the .* MiB ceiling/;

    it("resolves app.asar beside the unpacked resources on every platform", async () => {
      mockExistsSync.mockReturnValue(true);

      for (const [platform, outDir, appName, expected] of [
        ["darwin", "/build/mac", "Daintree", "/build/mac/Daintree.app/Contents/Resources/app.asar"],
        // A second product name proves the macOS path is derived, not hardcoded.
        ["darwin", "/build/mac", "MyApp", "/build/mac/MyApp.app/Contents/Resources/app.asar"],
        ["win32", "/build/win", "Daintree", "/build/win/resources/app.asar"],
        ["linux", "/build/linux", "Daintree", "/build/linux/resources/app.asar"],
      ] as const) {
        mockStatSync.mockClear();
        mockGetRawHeader.mockClear();
        await afterPack(createContext(platform, outDir, appName));
        // Both readers must land on the same archive — statting the right file
        // while parsing another would otherwise pass.
        expect(mockStatSync).toHaveBeenCalledWith(path.normalize(expected));
        expect(mockGetRawHeader).toHaveBeenCalledWith(path.normalize(expected));
      }
    });

    it("checks the archive before any native-module probe", async () => {
      // The native checks all read app.asar.unpacked, which stays correct while
      // app.asar bloats — so a packaging regression has to fail here or it
      // reaches signing looking healthy.
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({ size: Number.MAX_SAFE_INTEGER });

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(OVER_CEILING);

      expect(mockExistsSync).not.toHaveBeenCalled();
    });

    it("rejects an archive at the scale of the #11475 regression", async () => {
      // The incident shipped a 601MB archive. Pinning a real-world size, not
      // only an absurd one, keeps the ceiling meaningful: a limit raised to
      // gigabytes still passes a MAX_SAFE_INTEGER-only test.
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({ size: 601 * 1024 * 1024 });

      await expect(afterPack(createContext("linux", "/build/linux"))).rejects.toThrow(OVER_CEILING);
    });

    it("accepts the ceiling exactly and rejects one byte over", async () => {
      // Derived from the guard's own limit, so this exercises the comparison
      // rather than restating the number.
      mockExistsSync.mockReturnValue(true);

      mockStatSync.mockReturnValue({ size: MAX_APP_ASAR_BYTES });
      await afterPack(createContext("linux", "/build/linux"));

      mockStatSync.mockReturnValue({ size: MAX_APP_ASAR_BYTES + 1 });
      await expect(afterPack(createContext("linux", "/build/linux"))).rejects.toThrow(OVER_CEILING);
    });

    it("does not parse the header of an oversized archive", async () => {
      // A runaway archive has a proportionally runaway header, so the cheap
      // size gate has to come first.
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({ size: Number.MAX_SAFE_INTEGER });

      await expect(afterPack(createContext("linux", "/build/linux"))).rejects.toThrow(OVER_CEILING);

      expect(mockGetRawHeader).not.toHaveBeenCalled();
    });

    it("rejects a top-level entry outside the files allowlist", async () => {
      // The #11475 shape: the platform override dropped baseFiles(), so
      // electron-builder fell back to `**/*` and packed the source tree.
      mockExistsSync.mockReturnValue(true);
      mockGetRawHeader.mockReturnValue(asarHeader([...APP_ASAR_ROOT_ENTRIES, "src", "e2e"]));

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /Unexpected: e2e, src/
      );
    });

    it.each(APP_ASAR_ROOT_ENTRIES)("rejects an archive missing %s", async (root) => {
      // Every contract root, not just one — a validator that noticed only a
      // single missing entry would otherwise pass the suite.
      mockExistsSync.mockReturnValue(true);
      mockGetRawHeader.mockReturnValue(asarHeader(APP_ASAR_ROOT_ENTRIES.filter((r) => r !== root)));

      await expect(afterPack(createContext("win32", "/build/win"))).rejects.toThrow(
        new RegExp(`Missing: ${root.replace(".", "\\.")}`)
      );
    });

    it("rejects an archive with no entries at all", async () => {
      mockExistsSync.mockReturnValue(true);
      mockGetRawHeader.mockReturnValue({ header: { files: {} } });

      await expect(afterPack(createContext("linux", "/build/linux"))).rejects.toThrow(/Missing:/);
    });

    it("rejects a header with no files member", async () => {
      mockExistsSync.mockReturnValue(true);
      mockGetRawHeader.mockReturnValue({ header: {} });

      await expect(afterPack(createContext("linux", "/build/linux"))).rejects.toThrow(/Missing:/);
    });

    it("reports an unreadable archive as a packaging failure", async () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /app.asar could not be read/
      );
    });

    it("reports a corrupt header as a packaging failure", async () => {
      mockExistsSync.mockReturnValue(true);
      mockGetRawHeader.mockImplementation(() => {
        throw new Error("Unable to read header size");
      });

      await expect(afterPack(createContext("linux", "/build/linux"))).rejects.toThrow(
        /header could not be parsed/
      );
    });

    it("passes a correctly shaped archive", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac"));

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("app.asar verified"));
    });
  });

  describe("VAD native dependencies (#9177)", () => {
    const unpackedBase = "/build/mac/Daintree.app/Contents/Resources/app.asar.unpacked";

    it("verifies onnxruntime-node and avr-vad are unpacked", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac"));

      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/onnxruntime-node")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(path.join(unpackedBase, "node_modules/avr-vad"));
      expect(consoleSpy).toHaveBeenCalledWith(
        `[afterPack] onnxruntime-node verified: ${path.join(unpackedBase, "node_modules/onnxruntime-node")}`
      );
    });

    it("throws when onnxruntime-node is not unpacked", async () => {
      // Everything present except onnxruntime-node.
      mockExistsSync.mockImplementation(
        (p) => !String(p).endsWith(path.join("node_modules", "onnxruntime-node"))
      );

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /onnxruntime-node not found/
      );
    });
  });
});
