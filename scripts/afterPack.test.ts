import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import path from "path";
import Module from "module";

const mockExistsSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockCopyFileSync = vi.fn();
const mockSpawnSync = vi.fn();
const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

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
        };
      }
      if (id === "child_process" || id === "node:child_process") {
        return { spawnSync: mockSpawnSync };
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
    const runnerArchEnum = process.arch === "arm64" ? 3 : 1;

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
      const crossArchEnum = process.arch === "arm64" ? 1 : 3;
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
      // Arch enum 5 = universal: the merged app carries both slices.
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac", "Daintree", 5));

      const unpackedBase = "/build/mac/Daintree.app/Contents/Resources/app.asar.unpacked";
      for (const arch of ["x64", "arm64"]) {
        expect(mockExistsSync).toHaveBeenCalledWith(
          path.join(unpackedBase, `node_modules/better-sqlite3/prebuilds/darwin-${arch}.node`)
        );
      }
    });

    it("throws when a universal package is missing one darwin prebuild", async () => {
      mockExistsSync.mockImplementation((p) => !String(p).includes("darwin-x64.node"));

      await expect(afterPack(createContext("darwin", "/build/mac", "Daintree", 5))).rejects.toThrow(
        /better-sqlite3 prebuild not found/
      );
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
      const crossArch = process.arch === "arm64" ? 1 : 3;
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
