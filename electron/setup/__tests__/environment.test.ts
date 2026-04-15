import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn<(p: string) => boolean>(),
  readdirSync: vi.fn<(p: string) => string[]>(),
  rmSync: vi.fn(),
}));

const electronMock = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => "/tmp/test-appdata"),
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

vi.mock("fs", () => ({
  default: {
    existsSync: fsMock.existsSync,
    readdirSync: fsMock.readdirSync,
    rmSync: fsMock.rmSync,
  },
  existsSync: fsMock.existsSync,
  readdirSync: fsMock.readdirSync,
  rmSync: fsMock.rmSync,
}));

vi.mock("electron", () => electronMock);

vi.mock("fix-path", () => fixPathMock);

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
    .filter((p) => !p.includes("gpu-disabled.flag"));
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

  it("sets force-gpu-mem-available-mb to 512", async () => {
    fsMock.existsSync.mockReturnValue(false);

    await import("../environment.js");

    const { app } = await import("electron");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("force-gpu-mem-available-mb", "512");
  });

  it("disables GPU rasterization MSAA", async () => {
    fsMock.existsSync.mockReturnValue(false);

    await import("../environment.js");

    const { app } = await import("electron");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
      "gpu-rasterization-msaa-sample-count",
      "0"
    );
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
