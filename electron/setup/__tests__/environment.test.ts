import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn<(p: string) => boolean>(),
  readdirSync: vi.fn<(p: string) => string[]>(),
  rmSync: vi.fn(),
  cpSync: vi.fn(),
  renameSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn<(p: string, enc: string) => string>(),
}));

const electronMock = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getPath: vi.fn<(key?: string) => string>(() => "/tmp/test-appdata"),
    setPath: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    enableSandbox: vi.fn(),
    disableHardwareAcceleration: vi.fn(),
    on: vi.fn(),
  },
}));

const fixPathMock = vi.hoisted(() => ({
  default: vi.fn(),
}));

const sqliteMock = vi.hoisted(() => ({
  get: vi.fn(),
  prepare: vi.fn(),
  close: vi.fn(),
  Database: vi.fn(),
}));

const fsUtilsMock = vi.hoisted(() => ({
  resilientAtomicWriteFileSync: vi.fn(),
  resilientRename: vi.fn(),
  resilientRenameSync: vi.fn(),
  resilientDirectWriteFile: vi.fn(),
  resilientAtomicWriteFile: vi.fn(),
  resilientUnlink: vi.fn(),
  waitForPathExists: vi.fn(),
}));

vi.mock("fs", () => ({
  default: {
    existsSync: fsMock.existsSync,
    readdirSync: fsMock.readdirSync,
    rmSync: fsMock.rmSync,
    cpSync: fsMock.cpSync,
    renameSync: fsMock.renameSync,
    writeFileSync: fsMock.writeFileSync,
    readFileSync: fsMock.readFileSync,
  },
  existsSync: fsMock.existsSync,
  readdirSync: fsMock.readdirSync,
  rmSync: fsMock.rmSync,
  cpSync: fsMock.cpSync,
  renameSync: fsMock.renameSync,
  writeFileSync: fsMock.writeFileSync,
  readFileSync: fsMock.readFileSync,
}));

vi.mock("electron", () => electronMock);

vi.mock("fix-path", () => fixPathMock);

vi.mock("better-sqlite3", () => ({ default: sqliteMock.Database }));

vi.mock("../../utils/fs.js", () => fsUtilsMock);

vi.mock("node:v8", () => ({
  default: { setFlagsFromString: vi.fn() },
}));

vi.mock("node:vm", () => ({
  default: { runInNewContext: vi.fn() },
}));

vi.mock("os", () => ({
  default: { homedir: () => "C:\\Users\\testuser" },
  homedir: () => "C:\\Users\\testuser",
}));

const originalPlatform = process.platform;
const originalArgv = [...process.argv];

function getCandidatePaths(): string[] {
  return fsMock.existsSync.mock.calls
    .map((c) => c[0])
    .filter(
      (p) =>
        !p.includes("gpu-disabled.flag") &&
        !p.includes(".rebrand-migrated") &&
        !p.includes("canopy-app-dev") &&
        !p.includes("daintree-dev") &&
        !p.endsWith("Canopy") &&
        !p.endsWith("Daintree")
    );
}

describe("V8 flag setup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.argv = ["electron", "main.js"];
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    process.argv = originalArgv;
  });

  it("sets --expose_gc and does not set --optimize_for_size", async () => {
    fsMock.existsSync.mockReturnValue(false);

    await import("../environment.js");

    const nodeV8 = (await import("node:v8")).default;
    expect(nodeV8.setFlagsFromString).toHaveBeenCalledWith("--expose_gc");
    expect(nodeV8.setFlagsFromString).not.toHaveBeenCalledWith("--optimize_for_size");
  });
});

describe("Windows Git PATH discovery", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    process.argv = ["electron", "main.js"];
    process.env.PATH = "";
    delete process.env["ProgramFiles"];
    delete process.env["ProgramFiles(x86)"];
    delete process.env["ChocolateyInstall"];
    delete process.env["VOLTA_HOME"];
    delete process.env["PNPM_HOME"];
    delete process.env["FNM_MULTISHELL_PATH"];
    delete process.env["NVM_SYMLINK"];
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    process.argv = originalArgv;
  });

  it("generates correct candidate paths with env var fallbacks", async () => {
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const candidates = getCandidatePaths();
    // User install
    expect(candidates).toContainEqual(
      expect.stringContaining(path.join("AppData", "Local", "Programs", "Git", "cmd"))
    );
    // Program Files (fallback)
    expect(candidates).toContainEqual(
      expect.stringContaining(path.join("C:\\Program Files", "Git", "cmd"))
    );
    // Program Files (x86) (fallback)
    expect(candidates).toContainEqual(
      expect.stringContaining(path.join("C:\\Program Files (x86)", "Git", "cmd"))
    );
    // Scoop shims
    expect(candidates).toContainEqual(expect.stringContaining(path.join("scoop", "shims")));
    // Chocolatey (fallback)
    expect(candidates).toContainEqual(
      expect.stringContaining(path.join("C:\\ProgramData\\chocolatey", "bin"))
    );
  });

  it("uses ProgramFiles env var when set", async () => {
    process.env["ProgramFiles"] = "D:\\Programs";
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const candidates = getCandidatePaths();
    expect(candidates).toContainEqual(
      expect.stringContaining(path.join("D:\\Programs", "Git", "cmd"))
    );
    // Should NOT contain the fallback
    const hasDefault = candidates.some(
      (p) => p.includes("C:\\Program Files") && !p.includes("(x86)")
    );
    expect(hasDefault).toBe(false);
  });

  it("uses ProgramFiles(x86) env var when set", async () => {
    process.env["ProgramFiles(x86)"] = "D:\\Programs (x86)";
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const candidates = getCandidatePaths();
    expect(candidates).toContainEqual(
      expect.stringContaining(path.join("D:\\Programs (x86)", "Git", "cmd"))
    );
  });

  it("uses ChocolateyInstall env var when set", async () => {
    process.env["ChocolateyInstall"] = "D:\\Chocolatey";
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const candidates = getCandidatePaths();
    expect(candidates).toContainEqual(expect.stringContaining(path.join("D:\\Chocolatey", "bin")));
    const hasDefault = candidates.some((p) => p.includes("ProgramData\\chocolatey"));
    expect(hasDefault).toBe(false);
  });

  it("does not prepend paths that do not exist on disk", async () => {
    fsMock.existsSync.mockReturnValue(false);

    await import("../environment.js");

    expect(process.env.PATH).toBe("");
  });

  it("prepends existing paths to PATH", async () => {
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    // PATH should be non-empty since all candidates "exist"
    expect(process.env.PATH!.length).toBeGreaterThan(0);
    // Each candidate should appear in the PATH string
    const candidates = getCandidatePaths();
    for (const candidate of candidates) {
      expect(process.env.PATH).toContain(candidate);
    }
  });

  it("does not include .local/bin (Unix-only path regression)", async () => {
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const candidates = getCandidatePaths();
    const hasLocalBin = candidates.some((p) => p.includes(".local"));
    expect(hasLocalBin).toBe(false);
  });

  it("includes npm global bin path", async () => {
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const candidates = getCandidatePaths();
    expect(candidates).toContainEqual(
      expect.stringContaining(path.join("AppData", "Roaming", "npm"))
    );
  });

  it("includes Volta bin from VOLTA_HOME env var when set", async () => {
    process.env["VOLTA_HOME"] = "D:\\Volta";
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const candidates = getCandidatePaths();
    expect(candidates).toContainEqual(expect.stringContaining(path.join("D:\\Volta", "bin")));
    // Should NOT contain the hardcoded fallback
    const hasFallback = candidates.some((p) =>
      p.includes(path.join("AppData", "Local", "Volta", "bin"))
    );
    expect(hasFallback).toBe(false);

    delete process.env["VOLTA_HOME"];
  });

  it("includes Volta bin from hardcoded fallback when VOLTA_HOME not set", async () => {
    delete process.env["VOLTA_HOME"];
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const candidates = getCandidatePaths();
    expect(candidates).toContainEqual(
      expect.stringContaining(path.join("AppData", "Local", "Volta", "bin"))
    );
  });

  it("includes PNPM_HOME path when env var is set", async () => {
    process.env["PNPM_HOME"] = "C:\\Users\\testuser\\AppData\\Local\\pnpm";
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const candidates = getCandidatePaths();
    expect(candidates).toContainEqual(expect.stringContaining("AppData\\Local\\pnpm"));

    delete process.env["PNPM_HOME"];
  });

  it("does not include pnpm path when PNPM_HOME is not set", async () => {
    delete process.env["PNPM_HOME"];
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const candidates = getCandidatePaths();
    const hasPnpm = candidates.some((p) => p.includes("pnpm"));
    expect(hasPnpm).toBe(false);
  });

  it("includes FNM_MULTISHELL_PATH when env var is set", async () => {
    process.env["FNM_MULTISHELL_PATH"] =
      "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\12345";
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const candidates = getCandidatePaths();
    expect(candidates).toContainEqual(expect.stringContaining("fnm_multishells"));

    delete process.env["FNM_MULTISHELL_PATH"];
  });

  it("does not include fnm path when FNM_MULTISHELL_PATH is not set", async () => {
    delete process.env["FNM_MULTISHELL_PATH"];
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const candidates = getCandidatePaths();
    const hasFnm = candidates.some((p) => p.includes("fnm"));
    expect(hasFnm).toBe(false);
  });

  it("includes NVM_SYMLINK path when env var is set", async () => {
    process.env["NVM_SYMLINK"] = "C:\\Program Files\\nodejs";
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const candidates = getCandidatePaths();
    expect(candidates).toContainEqual(expect.stringContaining("C:\\Program Files\\nodejs"));

    delete process.env["NVM_SYMLINK"];
  });

  it("does not include nvm-windows path when NVM_SYMLINK is not set", async () => {
    delete process.env["NVM_SYMLINK"];
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const candidates = getCandidatePaths();
    // "nodejs" only appears from NVM_SYMLINK, not from other paths
    const hasNvm = candidates.some((p) => p === "C:\\Program Files\\nodejs");
    expect(hasNvm).toBe(false);
  });

  it("falls back to defaults when env vars are empty strings", async () => {
    process.env["ProgramFiles"] = "";
    process.env["ProgramFiles(x86)"] = "";
    process.env["ChocolateyInstall"] = "";
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const candidates = getCandidatePaths();
    expect(candidates).toContainEqual(
      expect.stringContaining(path.join("C:\\Program Files", "Git", "cmd"))
    );
    expect(candidates).toContainEqual(
      expect.stringContaining(path.join("C:\\Program Files (x86)", "Git", "cmd"))
    );
    expect(candidates).toContainEqual(
      expect.stringContaining(path.join("C:\\ProgramData\\chocolatey", "bin"))
    );
  });

  it("preserves existing PATH entries when prepending", async () => {
    process.env.PATH = "C:\\existing\\bin";
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    // Original entry must still be present at the end
    expect(process.env.PATH).toContain("C:\\existing\\bin");
    // New candidates should appear before the existing entry
    const pathStr = process.env.PATH!;
    const existingIdx = pathStr.indexOf("C:\\existing\\bin");
    const candidates = getCandidatePaths();
    for (const candidate of candidates) {
      const candidateIdx = pathStr.indexOf(candidate);
      expect(candidateIdx).toBeLessThan(existingIdx);
    }
  });
});

describe("GPU memory flags", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.argv = ["electron", "main.js"];
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    process.argv = originalArgv;
  });

  it("sets force-gpu-mem-available-mb to 1024", async () => {
    fsMock.existsSync.mockReturnValue(false);

    await import("../environment.js");

    const { app } = await import("electron");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("force-gpu-mem-available-mb", "1024");
  });

  it("does not set gpu-rasterization-msaa-sample-count", async () => {
    fsMock.existsSync.mockReturnValue(false);

    await import("../environment.js");

    const { app } = await import("electron");
    const msaaCalls = vi
      .mocked(app.commandLine.appendSwitch)
      .mock.calls.filter(([key]) => key === "gpu-rasterization-msaa-sample-count");
    expect(msaaCalls).toEqual([]);
  });
});

describe("Chromium feature flags", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    process.argv = ["electron", "main.js"];
    delete process.env.XDG_SESSION_TYPE;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    process.argv = originalArgv;
    delete process.env.XDG_SESSION_TYPE;
  });

  it("always includes PartitionAllocMemoryReclaimer in enable-features", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    fsMock.existsSync.mockReturnValue(false);

    await import("../environment.js");

    const { app } = await import("electron");
    const calls = vi.mocked(app.commandLine.appendSwitch).mock.calls;
    const enableCalls = calls.filter(([key]) => key === "enable-features");
    expect(enableCalls).toHaveLength(1);
    expect(enableCalls[0][1]).toBe("PartitionAllocMemoryReclaimer");
  });

  it("merges WaylandWindowDecorations with PartitionAllocMemoryReclaimer on Linux Wayland", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    process.env.XDG_SESSION_TYPE = "wayland";
    fsMock.existsSync.mockReturnValue(false);

    await import("../environment.js");

    const { app } = await import("electron");
    const calls = vi.mocked(app.commandLine.appendSwitch).mock.calls;
    const enableCalls = calls.filter(([key]) => key === "enable-features");
    expect(enableCalls).toHaveLength(1);
    expect(enableCalls[0][1]).toBe("PartitionAllocMemoryReclaimer,WaylandWindowDecorations");
  });

  it("does not include WaylandWindowDecorations on Linux non-Wayland", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    fsMock.existsSync.mockReturnValue(false);

    await import("../environment.js");

    const { app } = await import("electron");
    const calls = vi.mocked(app.commandLine.appendSwitch).mock.calls;
    const enableCalls = calls.filter(([key]) => key === "enable-features");
    expect(enableCalls).toHaveLength(1);
    expect(enableCalls[0][1]).toBe("PartitionAllocMemoryReclaimer");
    const imeCalls = calls.filter(([key]) => key === "enable-wayland-ime");
    expect(imeCalls).toHaveLength(0);
  });
});

describe("reset-data", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.argv = ["electron", "main.js"];
    delete process.env.DAINTREE_RESET_DATA;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    process.argv = originalArgv;
    delete process.env.DAINTREE_RESET_DATA;
  });

  it("wipes userData when DAINTREE_RESET_DATA=1 is set", async () => {
    process.env.DAINTREE_RESET_DATA = "1";
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue(["Local Storage", "config.json"]);

    await import("../environment.js");

    expect(fsMock.readdirSync).toHaveBeenCalledWith("/tmp/test-appdata");
    expect(fsMock.rmSync).toHaveBeenCalledTimes(2);
    expect(fsMock.rmSync).toHaveBeenCalledWith(path.join("/tmp/test-appdata", "Local Storage"), {
      recursive: true,
      force: true,
    });
    expect(fsMock.rmSync).toHaveBeenCalledWith(path.join("/tmp/test-appdata", "config.json"), {
      recursive: true,
      force: true,
    });
  });

  it("wipes userData when --reset-data argv is present", async () => {
    process.argv = ["electron", "main.js", "--reset-data"];
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue(["db.sqlite"]);

    await import("../environment.js");

    expect(fsMock.readdirSync).toHaveBeenCalledWith("/tmp/test-appdata");
    expect(fsMock.rmSync).toHaveBeenCalledTimes(1);
    expect(fsMock.rmSync).toHaveBeenCalledWith(path.join("/tmp/test-appdata", "db.sqlite"), {
      recursive: true,
      force: true,
    });
  });

  it("does not wipe when neither trigger is present", async () => {
    fsMock.existsSync.mockReturnValue(false);

    await import("../environment.js");

    expect(fsMock.readdirSync).not.toHaveBeenCalled();
    expect(fsMock.rmSync).not.toHaveBeenCalled();
  });

  it("skips wipe when userData directory does not exist", async () => {
    process.env.DAINTREE_RESET_DATA = "1";
    fsMock.existsSync.mockImplementation((p: string) => {
      if (p.includes("gpu-disabled.flag")) return false;
      return false; // userData path does not exist
    });

    await import("../environment.js");

    expect(fsMock.readdirSync).not.toHaveBeenCalled();
  });

  it("continues wiping other entries when rmSync throws on one", async () => {
    process.env.DAINTREE_RESET_DATA = "1";
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue(["locked-file", "deletable-file"]);
    fsMock.rmSync
      .mockImplementationOnce(() => {
        throw new Error("EBUSY: resource busy");
      })
      .mockImplementationOnce(() => {});

    await import("../environment.js");

    expect(fsMock.rmSync).toHaveBeenCalledTimes(2);
    expect(fsMock.rmSync).toHaveBeenCalledWith(path.join("/tmp/test-appdata", "locked-file"), {
      recursive: true,
      force: true,
    });
    expect(fsMock.rmSync).toHaveBeenCalledWith(path.join("/tmp/test-appdata", "deletable-file"), {
      recursive: true,
      force: true,
    });
  });

  it("ignores DAINTREE_RESET_DATA values other than '1'", async () => {
    process.env.DAINTREE_RESET_DATA = "true";
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    expect(fsMock.readdirSync).not.toHaveBeenCalled();
  });
});

describe("fixPath packaging guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.argv = ["electron", "main.js"];
  });

  afterEach(() => {
    electronMock.app.isPackaged = false;
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    process.argv = originalArgv;
  });

  it("does not call fixPath in dev mode (isPackaged=false)", async () => {
    electronMock.app.isPackaged = false;
    fsMock.existsSync.mockReturnValue(false);

    await import("../environment.js");

    expect(fixPathMock.default).not.toHaveBeenCalled();
  });

  it("calls fixPath in packaged mode (isPackaged=true)", async () => {
    electronMock.app.isPackaged = true;
    fsMock.existsSync.mockReturnValue(false);

    await import("../environment.js");

    expect(fixPathMock.default).toHaveBeenCalledOnce();
  });
});

describe("Canopy -> Daintree userData migration gating", () => {
  const originalVariant = process.env.BUILD_VARIANT;

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.argv = ["electron", "main.js"];
    electronMock.app.isPackaged = true;
    electronMock.app.getPath.mockImplementation((key?: string) => {
      if (key === "userData") return "/tmp/user-data/Daintree";
      if (key === "appData") return "/tmp/user-data";
      return "/tmp/test";
    });
    // Re-wire the better-sqlite3 chain after vi.resetAllMocks() — the reset
    // clears the implementation set inside vi.mock(...) factories, so the
    // Database -> prepare -> get chain has to be rebuilt every test. Vitest
    // 4 requires `mockImplementation` with a `class` (or `function`, not arrow)
    // when the mock is invoked with `new`. Default: probe returns 0 rows
    // (empty DB) so migration proceeds unless a test overrides.
    sqliteMock.get.mockReturnValue({ count: 0 });
    sqliteMock.prepare.mockReturnValue({ get: sqliteMock.get });
    sqliteMock.Database.mockImplementation(
      class {
        prepare = sqliteMock.prepare;
        close = sqliteMock.close;
      } as never
    );
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    process.argv = originalArgv;
    if (originalVariant === undefined) {
      Reflect.deleteProperty(process.env, "BUILD_VARIANT");
    } else {
      (process.env as Record<string, string | undefined>).BUILD_VARIANT = originalVariant;
    }
  });

  it("runs the migration when BUILD_VARIANT is unset (Daintree default)", async () => {
    Reflect.deleteProperty(process.env, "BUILD_VARIANT");
    // Legacy Canopy userData exists; new Daintree userData does not (no
    // daintree.db marker).
    fsMock.existsSync.mockImplementation((p: string) => {
      if (p.endsWith(".rebrand-migrated")) return false;
      if (p.endsWith("daintree.db")) return false;
      if (p.endsWith("/Canopy") || p.endsWith("\\Canopy")) return true;
      return false;
    });

    await import("../environment.js");

    // Copy goes into a staging dir first (atomic rename pattern) with a
    // filter that excludes Chromium singleton/cache/crashpad state.
    expect(fsMock.cpSync).toHaveBeenCalledWith(
      path.join("/tmp/user-data", "Canopy"),
      "/tmp/user-data/Daintree.migrating",
      expect.objectContaining({
        recursive: true,
        filter: expect.any(Function),
      })
    );
    // Staging is atomically promoted into place.
    expect(fsMock.renameSync).toHaveBeenCalledWith(
      "/tmp/user-data/Daintree.migrating",
      "/tmp/user-data/Daintree"
    );
  });

  it("skips the migration when Daintree data already exists (daintree.db has rows)", async () => {
    Reflect.deleteProperty(process.env, "BUILD_VARIANT");
    fsMock.existsSync.mockImplementation((p: string) => {
      if (p.endsWith(".rebrand-migrated")) return false;
      if (p.endsWith("daintree.db")) return true;
      if (p.endsWith("/Canopy") || p.endsWith("\\Canopy")) return true;
      return false;
    });
    // The DB exists AND has real rows — a real Daintree user.
    sqliteMock.get.mockReturnValue({ count: 1 });

    await import("../environment.js");

    // Must not touch the existing Daintree userData. A previous migration
    // attempt may have crashed between the copy and the marker write — the
    // user has since used Daintree and accumulated real state.
    expect(fsMock.cpSync).not.toHaveBeenCalled();
    expect(fsMock.rmSync).not.toHaveBeenCalled();
    expect(fsUtilsMock.resilientAtomicWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".rebrand-migrated"),
      expect.stringContaining("skipped: daintree.db already present")
    );
  });

  it("migrates when daintree.db exists but the projects table is empty (issue #5156)", async () => {
    // Pre-release Daintree launches caused openDb() to create a schema-only
    // empty daintree.db. The previous existsSync-only guard mistook this for
    // a real install and silently left user data unmigrated. Now we probe
    // for actual rows.
    Reflect.deleteProperty(process.env, "BUILD_VARIANT");
    fsMock.existsSync.mockImplementation((p: string) => {
      if (p.endsWith(".rebrand-migrated")) return false;
      if (p.endsWith("daintree.db")) return true; // file exists but...
      if (p.endsWith("/Canopy") || p.endsWith("\\Canopy")) return true;
      return false;
    });
    // ...projects table has 0 rows (default beforeEach mock value).

    await import("../environment.js");

    // Migration runs into the staging dir and is atomically promoted.
    expect(fsMock.cpSync).toHaveBeenCalledWith(
      path.join("/tmp/user-data", "Canopy"),
      "/tmp/user-data/Daintree.migrating",
      expect.objectContaining({ recursive: true, filter: expect.any(Function) })
    );
    expect(fsMock.renameSync).toHaveBeenCalledWith(
      "/tmp/user-data/Daintree.migrating",
      "/tmp/user-data/Daintree"
    );
    // The skip marker is NOT written.
    expect(fsUtilsMock.resilientAtomicWriteFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining(".rebrand-migrated"),
      expect.stringContaining("skipped: daintree.db already present")
    );
  });

  it("auto-heals: deletes a stale skip marker and re-runs migration when daintree.db is empty and canopy.db has rows", async () => {
    Reflect.deleteProperty(process.env, "BUILD_VARIANT");
    // Marker is initially present but gets deleted by the auto-heal pre-check;
    // the !existsSync(markerPath) gate has to flip after rmSync runs.
    let markerDeleted = false;
    fsMock.existsSync.mockImplementation((p: string) => {
      if (p.endsWith(".rebrand-migrated")) return !markerDeleted;
      if (p.endsWith("daintree.db")) return true;
      if (p.endsWith("/Canopy") || p.endsWith("\\Canopy")) return true;
      return false;
    });
    fsMock.rmSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.endsWith(".rebrand-migrated")) {
        markerDeleted = true;
      }
    });
    fsMock.readFileSync.mockReturnValue(
      "2026-04-16T14:31:00.178Z\nskipped: daintree.db already present\n"
    );
    // Discriminate by path: empty daintree.db, populated canopy.db. Vitest 4
    // requires a class (not an arrow function) when the mock is `new`-called.
    sqliteMock.Database.mockImplementation(
      class {
        constructor(dbPath: unknown) {
          const isCanopy = typeof dbPath === "string" && dbPath.endsWith("canopy.db");
          (this as unknown as { prepare: unknown }).prepare = () => ({
            get: () => ({ count: isCanopy ? 3 : 0 }),
          });
          (this as unknown as { close: unknown }).close = vi.fn();
        }
      } as never
    );

    await import("../environment.js");

    // Stale marker is deleted, then the migration runs.
    expect(fsMock.rmSync).toHaveBeenCalledWith(
      path.join("/tmp/user-data/Daintree", ".rebrand-migrated")
    );
    expect(fsMock.cpSync).toHaveBeenCalledWith(
      path.join("/tmp/user-data", "Canopy"),
      "/tmp/user-data/Daintree.migrating",
      expect.objectContaining({ recursive: true, filter: expect.any(Function) })
    );
    expect(fsMock.renameSync).toHaveBeenCalledWith(
      "/tmp/user-data/Daintree.migrating",
      "/tmp/user-data/Daintree"
    );
  });

  it("does NOT auto-heal when the marker says skipped but canopy.db has no rows", async () => {
    // Edge case: legitimate first-launch user with zero projects in Canopy
    // who somehow got the skip marker — we must not re-trigger migration
    // and clobber whatever's in Daintree.
    Reflect.deleteProperty(process.env, "BUILD_VARIANT");
    fsMock.existsSync.mockImplementation((p: string) => {
      if (p.endsWith(".rebrand-migrated")) return true; // marker stays
      if (p.endsWith("daintree.db")) return true;
      if (p.endsWith("/Canopy") || p.endsWith("\\Canopy")) return true;
      return false;
    });
    fsMock.readFileSync.mockReturnValue(
      "2026-04-16T14:31:00.178Z\nskipped: daintree.db already present\n"
    );
    // Both DBs report 0 rows.
    sqliteMock.get.mockReturnValue({ count: 0 });

    await import("../environment.js");

    // Marker is NOT deleted, migration does NOT run.
    expect(fsMock.rmSync).not.toHaveBeenCalledWith(
      path.join("/tmp/user-data/Daintree", ".rebrand-migrated")
    );
    expect(fsMock.cpSync).not.toHaveBeenCalled();
  });

  it("fail-safe: treats DB probe error as 'has data' and skips migration", async () => {
    // If daintree.db is corrupt, locked, or otherwise unreadable we must
    // never overwrite it — the user's data could still be in there.
    Reflect.deleteProperty(process.env, "BUILD_VARIANT");
    fsMock.existsSync.mockImplementation((p: string) => {
      if (p.endsWith(".rebrand-migrated")) return false;
      if (p.endsWith("daintree.db")) return true;
      if (p.endsWith("/Canopy") || p.endsWith("\\Canopy")) return true;
      return false;
    });
    sqliteMock.Database.mockImplementation(
      class {
        constructor() {
          const err = new Error("file is not a database") as Error & { code: string };
          err.code = "SQLITE_NOTADB";
          throw err;
        }
      } as never
    );

    await import("../environment.js");

    expect(fsMock.cpSync).not.toHaveBeenCalled();
    expect(fsUtilsMock.resilientAtomicWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".rebrand-migrated"),
      expect.stringContaining("skipped: daintree.db already present")
    );
  });

  it("fail-safe: treats prepare/get error as 'has data' and closes the DB", async () => {
    // Covers a different SQLITE error path: constructor succeeds but the
    // probe query throws (e.g. SQLITE_BUSY mid-read or a missing table).
    // The finally block must still close the connection so WAL/SHM handles
    // don't leak into the persistence service that opens this DB seconds later.
    Reflect.deleteProperty(process.env, "BUILD_VARIANT");
    fsMock.existsSync.mockImplementation((p: string) => {
      if (p.endsWith(".rebrand-migrated")) return false;
      if (p.endsWith("daintree.db")) return true;
      if (p.endsWith("/Canopy") || p.endsWith("\\Canopy")) return true;
      return false;
    });
    const closeSpy = vi.fn();
    sqliteMock.Database.mockImplementation(
      class {
        prepare = () => ({
          get: () => {
            const err = new Error("database is locked") as Error & { code: string };
            err.code = "SQLITE_BUSY";
            throw err;
          },
        });
        close = closeSpy;
      } as never
    );

    await import("../environment.js");

    expect(closeSpy).toHaveBeenCalled();
    expect(fsMock.cpSync).not.toHaveBeenCalled();
    expect(fsUtilsMock.resilientAtomicWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".rebrand-migrated"),
      expect.stringContaining("skipped: daintree.db already present")
    );
  });

  it("does NOT migrate when daintree.db is empty but Chromium-side state exists (Preferences)", async () => {
    // A pre-release Daintree user who customized prefs/themes but never opened
    // a project leaves zero rows in projects but does write `Preferences`.
    // Migrating Canopy data over them would wipe out their customization at
    // the rmSync(newUserData, recursive) step. This is the symmetric bug to
    // #5156 — a regression in the opposite direction.
    Reflect.deleteProperty(process.env, "BUILD_VARIANT");
    fsMock.existsSync.mockImplementation((p: string) => {
      if (p.endsWith(".rebrand-migrated")) return false;
      if (p.endsWith("daintree.db")) return true;
      if (p.endsWith("/Daintree/Preferences") || p.endsWith("\\Daintree\\Preferences")) return true;
      if (p.endsWith("/Canopy") || p.endsWith("\\Canopy")) return true;
      return false;
    });
    // Zero rows is the default beforeEach mock — the usage-marker check is
    // what must catch this case.

    await import("../environment.js");

    expect(fsMock.cpSync).not.toHaveBeenCalled();
    expect(fsMock.rmSync).not.toHaveBeenCalled();
    expect(fsUtilsMock.resilientAtomicWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".rebrand-migrated"),
      expect.stringContaining("skipped: daintree.db already present")
    );
  });

  it("does NOT auto-heal when Chromium-side Daintree state exists (Local Storage)", async () => {
    // Same protection in the auto-heal direction — a pre-release user with a
    // stale skip marker who customized Daintree (creating Local Storage) but
    // never opened a project must not have their state wiped by auto-heal.
    Reflect.deleteProperty(process.env, "BUILD_VARIANT");
    fsMock.existsSync.mockImplementation((p: string) => {
      if (p.endsWith(".rebrand-migrated")) return true; // marker stays
      if (p.endsWith("daintree.db")) return true;
      if (p.endsWith("/Daintree/Local Storage") || p.endsWith("\\Daintree\\Local Storage"))
        return true;
      if (p.endsWith("/Canopy") || p.endsWith("\\Canopy")) return true;
      return false;
    });
    fsMock.readFileSync.mockReturnValue(
      "2026-04-16T14:31:00.178Z\nskipped: daintree.db already present\n"
    );
    sqliteMock.Database.mockImplementation(
      class {
        constructor(dbPath: unknown) {
          const isCanopy = typeof dbPath === "string" && dbPath.endsWith("canopy.db");
          (this as unknown as { prepare: unknown }).prepare = () => ({
            get: () => ({ count: isCanopy ? 5 : 0 }),
          });
          (this as unknown as { close: unknown }).close = vi.fn();
        }
      } as never
    );

    await import("../environment.js");

    expect(fsMock.rmSync).not.toHaveBeenCalledWith(
      path.join("/tmp/user-data/Daintree", ".rebrand-migrated")
    );
    expect(fsMock.cpSync).not.toHaveBeenCalled();
  });

  it("excludes Chromium singleton / cache / crashpad state from the copy", async () => {
    Reflect.deleteProperty(process.env, "BUILD_VARIANT");
    fsMock.existsSync.mockImplementation((p: string) => {
      if (p.endsWith(".rebrand-migrated")) return false;
      if (p.endsWith("daintree.db")) return false;
      if (p.endsWith("/Canopy") || p.endsWith("\\Canopy")) return true;
      return false;
    });

    await import("../environment.js");

    const cpCall = fsMock.cpSync.mock.calls[0];
    expect(cpCall).toBeDefined();
    const filter = cpCall[2].filter as (src: string) => boolean;
    // Inheriting SingletonLock that points at a live Canopy PID would make
    // Daintree fail to launch (Chromium treats it as a secondary instance).
    expect(filter("/tmp/user-data/Canopy/SingletonLock")).toBe(false);
    expect(filter("/tmp/user-data/Canopy/SingletonCookie")).toBe(false);
    expect(filter("/tmp/user-data/Canopy/SingletonSocket")).toBe(false);
    // Crashpad state would re-report Canopy's old crashes under Daintree's
    // bundle id.
    expect(filter("/tmp/user-data/Canopy/Crashpad")).toBe(false);
    expect(filter("/tmp/user-data/Canopy/Crash Reports")).toBe(false);
    // Caches regenerate — copying wastes I/O.
    expect(filter("/tmp/user-data/Canopy/GPUCache")).toBe(false);
    expect(filter("/tmp/user-data/Canopy/Code Cache")).toBe(false);
    // Real user state is kept.
    expect(filter("/tmp/user-data/Canopy/canopy.db")).toBe(true);
    expect(filter("/tmp/user-data/Canopy/Preferences")).toBe(true);
    expect(filter("/tmp/user-data/Canopy/Local Storage")).toBe(true);
  });

  it("skips the migration when BUILD_VARIANT=canopy (legacy build)", async () => {
    (process.env as Record<string, string | undefined>).BUILD_VARIANT = "canopy";
    fsMock.existsSync.mockImplementation((p: string) => {
      if (p.endsWith(".rebrand-migrated")) return false;
      if (p.endsWith("/Canopy") || p.endsWith("\\Canopy")) return true;
      return false;
    });

    await import("../environment.js");

    expect(fsMock.cpSync).not.toHaveBeenCalled();
    expect(fsMock.renameSync).not.toHaveBeenCalled();
  });
});
