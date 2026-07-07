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
  unlinkSync: vi.fn(),
  statSync: vi.fn<(p: string) => { isDirectory: () => boolean }>(),
}));

const electronMock = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getPath: vi.fn<(key?: string) => string>(() => "/tmp/test-appdata"),
    setPath: vi.fn(),
    getVersion: vi.fn<() => string>(() => "9.9.9"),
    commandLine: { appendSwitch: vi.fn() },
    enableSandbox: vi.fn(),
    disableHardwareAcceleration: vi.fn(),
    on: vi.fn(),
  },
}));

const osMock = vi.hoisted(() => ({
  totalmem: vi.fn<() => number>(),
}));

const gpuDetectionMock = vi.hoisted(() => ({
  isLinuxWaylandHybridGpu: vi.fn<() => boolean>(() => false),
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
    unlinkSync: fsMock.unlinkSync,
    statSync: fsMock.statSync,
  },
  existsSync: fsMock.existsSync,
  readdirSync: fsMock.readdirSync,
  rmSync: fsMock.rmSync,
  cpSync: fsMock.cpSync,
  renameSync: fsMock.renameSync,
  writeFileSync: fsMock.writeFileSync,
  readFileSync: fsMock.readFileSync,
  unlinkSync: fsMock.unlinkSync,
  statSync: fsMock.statSync,
}));

vi.mock("electron", () => electronMock);

vi.mock("node:v8", () => ({
  default: { setFlagsFromString: vi.fn() },
}));

vi.mock("node:vm", () => ({
  default: { runInNewContext: vi.fn() },
}));

vi.mock("os", () => ({
  default: { homedir: () => "C:\\Users\\testuser", totalmem: osMock.totalmem },
  homedir: () => "C:\\Users\\testuser",
  totalmem: osMock.totalmem,
}));

vi.mock("../../utils/gpuDetection.js", () => ({
  isLinuxWaylandHybridGpu: gpuDetectionMock.isLinuxWaylandHybridGpu,
}));

const originalPlatform = process.platform;
const originalArgv = [...process.argv];

function getCandidatePaths(): string[] {
  return fsMock.existsSync.mock.calls
    .map((c) => c[0])
    .filter(
      (p) =>
        !p.includes("gpu-disabled.flag") &&
        !p.includes("gpu-angle-fallback.flag") &&
        !p.includes("daintree-dev")
    );
}

describe("V8 flag setup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.argv = ["electron", "main.js"];
    delete process.env.DAINTREE_DEV_USER_DATA_DIR;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    process.argv = originalArgv;
    delete process.env.DAINTREE_DEV_USER_DATA_DIR;
  });

  it("sets --expose_gc and does not set --optimize_for_size", async () => {
    fsMock.existsSync.mockReturnValue(false);

    await import("../environment.js");

    const nodeV8 = (await import("node:v8")).default;
    expect(nodeV8.setFlagsFromString).toHaveBeenCalledWith("--expose_gc");
    expect(nodeV8.setFlagsFromString).not.toHaveBeenCalledWith("--optimize_for_size");
  });
});

describe("development userData path", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.argv = ["electron", "main.js"];
    delete process.env.DAINTREE_DEV_USER_DATA_DIR;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    process.argv = originalArgv;
    delete process.env.DAINTREE_DEV_USER_DATA_DIR;
  });

  it("uses the isolated dev userData directory when provided", async () => {
    process.env.DAINTREE_DEV_USER_DATA_DIR = "/tmp/daintree-dev-fresh-test";
    fsMock.existsSync.mockReturnValue(false);

    await import("../environment.js");

    expect(electronMock.app.setPath).toHaveBeenCalledWith(
      "userData",
      "/tmp/daintree-dev-fresh-test"
    );
  });

  it("ignores a relative dev userData override", async () => {
    process.env.DAINTREE_DEV_USER_DATA_DIR = "relative-profile";
    fsMock.existsSync.mockReturnValue(false);

    await import("../environment.js");

    expect(electronMock.app.setPath).toHaveBeenCalledWith(
      "userData",
      path.join("/tmp/test-appdata", "daintree-dev")
    );
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
  const GIB = 1024 ** 3;

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

  it("sets force-gpu-mem-available-mb to 768 on a 4 GiB machine", async () => {
    fsMock.existsSync.mockReturnValue(false);
    osMock.totalmem.mockReturnValue(4 * GIB);

    await import("../environment.js");

    const { app } = await import("electron");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("force-gpu-mem-available-mb", "768");
  });

  it("sets force-gpu-mem-available-mb to 768 at the 8 GiB boundary", async () => {
    fsMock.existsSync.mockReturnValue(false);
    osMock.totalmem.mockReturnValue(8 * GIB);

    await import("../environment.js");

    const { app } = await import("electron");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("force-gpu-mem-available-mb", "768");
  });

  it("sets force-gpu-mem-available-mb to 1024 just above the 8 GiB boundary", async () => {
    fsMock.existsSync.mockReturnValue(false);
    osMock.totalmem.mockReturnValue(8 * GIB + 1);

    await import("../environment.js");

    const { app } = await import("electron");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("force-gpu-mem-available-mb", "1024");
  });

  it("sets force-gpu-mem-available-mb to 1024 at the 16 GiB boundary", async () => {
    fsMock.existsSync.mockReturnValue(false);
    osMock.totalmem.mockReturnValue(16 * GIB);

    await import("../environment.js");

    const { app } = await import("electron");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("force-gpu-mem-available-mb", "1024");
  });

  it("sets force-gpu-mem-available-mb to 2048 just above the 16 GiB boundary", async () => {
    fsMock.existsSync.mockReturnValue(false);
    osMock.totalmem.mockReturnValue(16 * GIB + 1);

    await import("../environment.js");

    const { app } = await import("electron");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("force-gpu-mem-available-mb", "2048");
  });

  it("sets force-gpu-mem-available-mb to 2048 on a 32 GiB machine", async () => {
    fsMock.existsSync.mockReturnValue(false);
    osMock.totalmem.mockReturnValue(32 * GIB);

    await import("../environment.js");

    const { app } = await import("electron");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("force-gpu-mem-available-mb", "2048");
  });

  it("does not set gpu-rasterization-msaa-sample-count", async () => {
    fsMock.existsSync.mockReturnValue(false);
    osMock.totalmem.mockReturnValue(16 * GIB);

    await import("../environment.js");

    const { app } = await import("electron");
    const msaaCalls = vi
      .mocked(app.commandLine.appendSwitch)
      .mock.calls.filter(([key]) => key === "gpu-rasterization-msaa-sample-count");
    expect(msaaCalls).toEqual([]);
  });
});

describe("WebGL context cap", () => {
  const GIB = 1024 ** 3;

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

  it("sets max-active-webgl-contexts to 24 on a 4 GiB machine", async () => {
    fsMock.existsSync.mockReturnValue(false);
    osMock.totalmem.mockReturnValue(4 * GIB);

    await import("../environment.js");

    const { app } = await import("electron");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("max-active-webgl-contexts", "24");
  });

  it("sets max-active-webgl-contexts to 24 at the 8 GiB boundary", async () => {
    fsMock.existsSync.mockReturnValue(false);
    osMock.totalmem.mockReturnValue(8 * GIB);

    await import("../environment.js");

    const { app } = await import("electron");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("max-active-webgl-contexts", "24");
  });

  it("sets max-active-webgl-contexts to 28 just above the 8 GiB boundary", async () => {
    fsMock.existsSync.mockReturnValue(false);
    osMock.totalmem.mockReturnValue(8 * GIB + 1);

    await import("../environment.js");

    const { app } = await import("electron");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("max-active-webgl-contexts", "28");
  });

  it("sets max-active-webgl-contexts to 28 at the 16 GiB boundary", async () => {
    fsMock.existsSync.mockReturnValue(false);
    osMock.totalmem.mockReturnValue(16 * GIB);

    await import("../environment.js");

    const { app } = await import("electron");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("max-active-webgl-contexts", "28");
  });

  it("sets max-active-webgl-contexts to 32 just above the 16 GiB boundary", async () => {
    fsMock.existsSync.mockReturnValue(false);
    osMock.totalmem.mockReturnValue(16 * GIB + 1);

    await import("../environment.js");

    const { app } = await import("electron");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("max-active-webgl-contexts", "32");
  });

  it("sets max-active-webgl-contexts to 32 on a 32 GiB machine", async () => {
    fsMock.existsSync.mockReturnValue(false);
    osMock.totalmem.mockReturnValue(32 * GIB);

    await import("../environment.js");

    const { app } = await import("electron");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("max-active-webgl-contexts", "32");
  });

  it("registers max-active-webgl-contexts exactly once", async () => {
    fsMock.existsSync.mockReturnValue(false);
    osMock.totalmem.mockReturnValue(16 * GIB);

    await import("../environment.js");

    const { app } = await import("electron");
    const calls = vi
      .mocked(app.commandLine.appendSwitch)
      .mock.calls.filter(([key]) => key === "max-active-webgl-contexts");
    expect(calls).toHaveLength(1);
  });

  it("registers max-active-webgl-contexts on Linux too", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    fsMock.existsSync.mockReturnValue(false);
    osMock.totalmem.mockReturnValue(16 * GIB);

    await import("../environment.js");

    const { app } = await import("electron");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("max-active-webgl-contexts", "28");
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

// The disabled flag is read via readFileSync (reason-aware since #10379);
// route its content through the fs mock, ENOENT when absent, and leave every
// other path on the unconfigured-mock default.
function mockDisabledFlagContent(content: string | null) {
  fsMock.readFileSync.mockImplementation(((p: string) => {
    if (String(p).includes("gpu-disabled.flag")) {
      if (content !== null) return content;
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    }
    return undefined as unknown as string;
  }) as (p: string, enc: string) => string);
}

describe("Linux Wayland multi-GPU fallback", () => {
  function flagAwareExists(flags: { disabled?: boolean; angle?: boolean }) {
    return (p: string) => {
      if (p.includes("gpu-disabled.flag")) return flags.disabled === true;
      if (p.includes("gpu-angle-fallback.flag")) return flags.angle === true;
      return false;
    };
  }

  function getAngleSwitchCalls() {
    const calls = vi.mocked(electronMock.app.commandLine.appendSwitch).mock.calls;
    return {
      useAngle: calls.filter(([k]) => k === "use-angle"),
      useCmdDecoder: calls.filter(([k]) => k === "use-cmd-decoder"),
      ignoreBlocklist: calls.filter(([k]) => k === "ignore-gpu-blocklist"),
    };
  }

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    process.argv = ["electron", "main.js"];
    process.env.XDG_SESSION_TYPE = "wayland";
    gpuDetectionMock.isLinuxWaylandHybridGpu.mockReturnValue(false);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    process.argv = originalArgv;
    delete process.env.XDG_SESSION_TYPE;
  });

  it("appends ANGLE/Vulkan switches when hybrid GPU is detected on Wayland", async () => {
    fsMock.existsSync.mockImplementation(flagAwareExists({}));
    gpuDetectionMock.isLinuxWaylandHybridGpu.mockReturnValue(true);

    await import("../environment.js");

    const angle = getAngleSwitchCalls();
    expect(angle.useAngle).toEqual([["use-angle", "vulkan"]]);
    expect(angle.useCmdDecoder).toEqual([["use-cmd-decoder", "passthrough"]]);
    expect(angle.ignoreBlocklist).toHaveLength(1);
    expect(angle.ignoreBlocklist[0][0]).toBe("ignore-gpu-blocklist");
  });

  it("appends ANGLE/Vulkan switches when crash-fallback flag is present (even without hybrid)", async () => {
    fsMock.existsSync.mockImplementation(flagAwareExists({ angle: true }));
    gpuDetectionMock.isLinuxWaylandHybridGpu.mockReturnValue(false);

    await import("../environment.js");

    const angle = getAngleSwitchCalls();
    expect(angle.useAngle).toEqual([["use-angle", "vulkan"]]);
    expect(angle.useCmdDecoder).toEqual([["use-cmd-decoder", "passthrough"]]);
    expect(angle.ignoreBlocklist).toHaveLength(1);
    // Hybrid detection should NOT have run when the crash flag short-circuits.
    expect(gpuDetectionMock.isLinuxWaylandHybridGpu).not.toHaveBeenCalled();
  });

  it("does NOT append ANGLE switches on Wayland when neither hybrid nor crash flag", async () => {
    fsMock.existsSync.mockImplementation(flagAwareExists({}));
    gpuDetectionMock.isLinuxWaylandHybridGpu.mockReturnValue(false);

    await import("../environment.js");

    const angle = getAngleSwitchCalls();
    expect(angle.useAngle).toEqual([]);
    expect(angle.useCmdDecoder).toEqual([]);
    expect(angle.ignoreBlocklist).toEqual([]);
  });

  it("does NOT append ANGLE switches on Linux X11 even with hybrid + crash flag", async () => {
    process.env.XDG_SESSION_TYPE = "x11";
    fsMock.existsSync.mockImplementation(flagAwareExists({ angle: true }));
    gpuDetectionMock.isLinuxWaylandHybridGpu.mockReturnValue(true);

    await import("../environment.js");

    const angle = getAngleSwitchCalls();
    expect(angle.useAngle).toEqual([]);
    expect(angle.useCmdDecoder).toEqual([]);
    expect(angle.ignoreBlocklist).toEqual([]);
    // Detection should not be called when XDG_SESSION_TYPE is not wayland.
    expect(gpuDetectionMock.isLinuxWaylandHybridGpu).not.toHaveBeenCalled();
  });

  it("does NOT append ANGLE switches when hardware acceleration is already disabled", async () => {
    fsMock.existsSync.mockImplementation(flagAwareExists({ disabled: true, angle: true }));
    // Same-version crash flag: no version-change retry, acceleration stays off.
    mockDisabledFlagContent(JSON.stringify({ reason: "crash", version: "9.9.9", timestamp: 1 }));
    gpuDetectionMock.isLinuxWaylandHybridGpu.mockReturnValue(true);

    await import("../environment.js");

    const angle = getAngleSwitchCalls();
    expect(angle.useAngle).toEqual([]);
    expect(angle.useCmdDecoder).toEqual([]);
    expect(angle.ignoreBlocklist).toEqual([]);
    expect(electronMock.app.disableHardwareAcceleration).toHaveBeenCalled();
    // Once the nuclear path is taken, hybrid detection is irrelevant.
    expect(gpuDetectionMock.isLinuxWaylandHybridGpu).not.toHaveBeenCalled();
  });

  it("does NOT append ANGLE switches on macOS even with the crash flag present", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    fsMock.existsSync.mockImplementation(flagAwareExists({ angle: true }));
    gpuDetectionMock.isLinuxWaylandHybridGpu.mockReturnValue(true);

    await import("../environment.js");

    const angle = getAngleSwitchCalls();
    expect(angle.useAngle).toEqual([]);
    expect(angle.useCmdDecoder).toEqual([]);
    expect(angle.ignoreBlocklist).toEqual([]);
  });

  it("exports gpuAngleFallbackActive=true when the flag exists", async () => {
    fsMock.existsSync.mockImplementation(flagAwareExists({ angle: true }));

    const mod = await import("../environment.js");
    expect(mod.gpuAngleFallbackActive).toBe(true);
  });

  it("exports gpuAngleFallbackActive=false when the flag is absent", async () => {
    fsMock.existsSync.mockImplementation(flagAwareExists({}));

    const mod = await import("../environment.js");
    expect(mod.gpuAngleFallbackActive).toBe(false);
  });
});

describe("GPU disabled flag version-change retry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.argv = ["electron", "main.js"];
    fsMock.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    process.argv = originalArgv;
  });

  it("clears a crash flag written by an older version and keeps acceleration on", async () => {
    mockDisabledFlagContent(JSON.stringify({ reason: "crash", version: "1.0.0", timestamp: 1 }));

    const mod = await import("../environment.js");

    expect(mod.gpuHardwareAccelerationDisabled).toBe(false);
    expect(electronMock.app.disableHardwareAcceleration).not.toHaveBeenCalled();
    const unlinked = fsMock.unlinkSync.mock.calls.map(([p]) => String(p));
    expect(unlinked.some((p) => p.includes("gpu-disabled.flag"))).toBe(true);
    expect(unlinked.some((p) => p.includes("gpu-angle-fallback.flag"))).toBe(true);
  });

  it("keeps acceleration off for a crash flag written by the current version", async () => {
    mockDisabledFlagContent(JSON.stringify({ reason: "crash", version: "9.9.9", timestamp: 1 }));

    const mod = await import("../environment.js");

    expect(mod.gpuHardwareAccelerationDisabled).toBe(true);
    expect(electronMock.app.disableHardwareAcceleration).toHaveBeenCalled();
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it("never retries a user-written flag, even across versions", async () => {
    mockDisabledFlagContent(JSON.stringify({ reason: "user", version: "1.0.0", timestamp: 1 }));

    const mod = await import("../environment.js");

    expect(mod.gpuHardwareAccelerationDisabled).toBe(true);
    expect(electronMock.app.disableHardwareAcceleration).toHaveBeenCalled();
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it("treats a legacy timestamp-only flag as crash and retries it after an update", async () => {
    mockDisabledFlagContent("1718105000000");

    const mod = await import("../environment.js");

    expect(mod.gpuHardwareAccelerationDisabled).toBe(false);
    expect(electronMock.app.disableHardwareAcceleration).not.toHaveBeenCalled();
  });

  it("keeps acceleration off this session when clearing the flag fails", async () => {
    mockDisabledFlagContent(JSON.stringify({ reason: "crash", version: "1.0.0", timestamp: 1 }));
    fsMock.unlinkSync.mockImplementation(() => {
      throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
    });

    const mod = await import("../environment.js");

    expect(mod.gpuHardwareAccelerationDisabled).toBe(true);
    expect(electronMock.app.disableHardwareAcceleration).toHaveBeenCalled();
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

describe("kickOffEarlyPathRefresh", () => {
  let shellEnvCallCount = 0;
  let shellEnvMode: "path" | "throw" | "empty" = "path";
  let savedPath: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.argv = ["electron", "main.js"];
    fsMock.existsSync.mockReturnValue(false);
    shellEnvCallCount = 0;
    shellEnvMode = "path";
    savedPath = process.env.PATH;
    process.env.PATH = "/old/path";
    vi.doMock("shell-env", () => ({
      shellEnv: vi.fn(async () => {
        shellEnvCallCount += 1;
        if (shellEnvMode === "throw") {
          throw new Error("broken .zshrc");
        }
        if (shellEnvMode === "empty") {
          return {};
        }
        return { PATH: "/from/shell-env" };
      }),
    }));
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    electronMock.app.isPackaged = false;
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    process.argv = originalArgv;
    vi.doUnmock("shell-env");
  });

  it("returns null from getEarlyPathRefreshPromise before kick-off", async () => {
    const env = await import("../environment.js");
    expect(env.getEarlyPathRefreshPromise()).toBeNull();
  });

  it("kick-off runs refreshPath and updates PATH", async () => {
    const env = await import("../environment.js");
    await env.kickOffEarlyPathRefresh();
    expect(shellEnvCallCount).toBe(1);
    expect(process.env.PATH).toContain("/from/shell-env");
  });

  it("kick-off is idempotent — repeat calls share the same promise", async () => {
    const env = await import("../environment.js");
    const p1 = env.kickOffEarlyPathRefresh();
    const p2 = env.kickOffEarlyPathRefresh();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    // shellEnv must only be invoked once even with two concurrent kick-offs.
    expect(shellEnvCallCount).toBe(1);
  });

  it("getEarlyPathRefreshPromise returns a settled promise after kick-off", async () => {
    const env = await import("../environment.js");
    await env.kickOffEarlyPathRefresh();
    const after = env.getEarlyPathRefreshPromise();
    expect(after).not.toBeNull();
    // Awaiting a settled promise is a no-op — must not re-run shell-env.
    await after;
    expect(shellEnvCallCount).toBe(1);
  });

  it("concurrent refreshPath callers share one in-flight shell-env probe", async () => {
    const env = await import("../environment.js");
    await Promise.all([env.refreshPath(), env.refreshPath(), env.refreshPath()]);
    expect(shellEnvCallCount).toBe(1);
  });

  it("kick-off swallows shell-env rejection and leaves PATH unchanged", async () => {
    shellEnvMode = "throw";
    process.env.PATH = "/old/path";
    const env = await import("../environment.js");
    await expect(env.kickOffEarlyPathRefresh()).resolves.toBeUndefined();
    const settled = env.getEarlyPathRefreshPromise();
    expect(settled).not.toBeNull();
    // Awaiting the settled promise must also not reject — the PtyClient gate
    // depends on this guarantee or the first PTY spawn would abort.
    await expect(settled).resolves.toBeUndefined();
    expect(process.env.PATH).toBe("/old/path");
  });

  it("kick-off preserves PATH when shell-env returns no PATH key", async () => {
    shellEnvMode = "empty";
    process.env.PATH = "/old/path";
    const env = await import("../environment.js");
    await env.kickOffEarlyPathRefresh();
    expect(process.env.PATH).toBe("/old/path");
  });
});

describe("macOS open-file handler", () => {
  type OpenFileEvent = { preventDefault: () => void };
  type OpenFileHandler = (event: OpenFileEvent, filePath: string) => void;

  function getOpenFileHandler(): OpenFileHandler | undefined {
    const call = electronMock.app.on.mock.calls.find((c) => c[0] === "open-file");
    return call?.[1] as OpenFileHandler | undefined;
  }

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.argv = ["electron", "main.js"];
    fsMock.existsSync.mockReturnValue(false);
    // A normal `.dntr` file routes as a file (stat succeeds, not a directory).
    fsMock.statSync.mockReturnValue({ isDirectory: () => false });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    process.argv = originalArgv;
  });

  it("registers an open-file listener on macOS", async () => {
    await import("../environment.js");
    expect(getOpenFileHandler()).toBeTypeOf("function");
  });

  it("does not register an open-file listener on Linux", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    await import("../environment.js");
    expect(getOpenFileHandler()).toBeUndefined();
  });

  it("does not register an open-file listener on Windows", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    await import("../environment.js");
    expect(getOpenFileHandler()).toBeUndefined();
  });

  it("calls preventDefault and queues the path when no consumer is set", async () => {
    const env = await import("../environment.js");
    const handler = getOpenFileHandler()!;
    const event = { preventDefault: vi.fn() };
    handler(event, "/tmp/foo.dntr");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(env.getPendingOpenFilePaths()).toEqual(["/tmp/foo.dntr"]);
  });

  it("queues multiple paths in FIFO order", async () => {
    const env = await import("../environment.js");
    const handler = getOpenFileHandler()!;
    handler({ preventDefault: vi.fn() }, "/a.dntr");
    handler({ preventDefault: vi.fn() }, "/b.dntr");
    expect(env.getPendingOpenFilePaths()).toEqual(["/a.dntr", "/b.dntr"]);
  });

  it("clearPendingOpenFilePaths empties the queue", async () => {
    const env = await import("../environment.js");
    const handler = getOpenFileHandler()!;
    handler({ preventDefault: vi.fn() }, "/a.dntr");
    env.clearPendingOpenFilePaths();
    expect(env.getPendingOpenFilePaths()).toEqual([]);
  });

  it("routes to the consumer instead of queueing once one is set", async () => {
    const env = await import("../environment.js");
    const handler = getOpenFileHandler()!;
    const consumer = vi.fn();
    env.setOpenFileConsumer(consumer);
    handler({ preventDefault: vi.fn() }, "/live.dntr");
    expect(consumer).toHaveBeenCalledWith("/live.dntr");
    expect(env.getPendingOpenFilePaths()).toEqual([]);
  });

  it("calls preventDefault on the consumer path too", async () => {
    const env = await import("../environment.js");
    const handler = getOpenFileHandler()!;
    env.setOpenFileConsumer(vi.fn());
    const event = { preventDefault: vi.fn() };
    handler(event, "/live.dntr");
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("deduplicates identical queued paths before activation", async () => {
    const env = await import("../environment.js");
    const handler = getOpenFileHandler()!;
    handler({ preventDefault: vi.fn() }, "/dup.dntr");
    handler({ preventDefault: vi.fn() }, "/dup.dntr");
    expect(env.getPendingOpenFilePaths()).toEqual(["/dup.dntr"]);
  });

  it("getPendingOpenFilePaths returns a copy so caller mutation is isolated", async () => {
    const env = await import("../environment.js");
    const handler = getOpenFileHandler()!;
    handler({ preventDefault: vi.fn() }, "/a.dntr");
    const snapshot = env.getPendingOpenFilePaths();
    snapshot.push("/injected.dntr");
    expect(env.getPendingOpenFilePaths()).toEqual(["/a.dntr"]);
  });
});

describe("macOS open-file directory routing (#10976)", () => {
  type OpenFileEvent = { preventDefault: () => void };
  type OpenFileHandler = (event: OpenFileEvent, filePath: string) => void;

  function getOpenFileHandler(): OpenFileHandler | undefined {
    const call = electronMock.app.on.mock.calls.find((c) => c[0] === "open-file");
    return call?.[1] as OpenFileHandler | undefined;
  }

  function mockStatDirectory(dirPath: string): void {
    fsMock.statSync.mockImplementation(((p: string) => ({
      isDirectory: () => p === dirPath,
    })) as (p: string) => { isDirectory: () => boolean });
  }

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.argv = ["electron", "main.js"];
    fsMock.existsSync.mockReturnValue(false);
    // Default: nothing is a directory (a `.dntr` file routes as a file).
    fsMock.statSync.mockReturnValue({ isDirectory: () => false });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    process.argv = originalArgv;
  });

  it("routes a directory to the directory queue, not the plugin queue", async () => {
    const env = await import("../environment.js");
    const handler = getOpenFileHandler()!;
    fsMock.statSync.mockReturnValue({ isDirectory: () => true });
    handler({ preventDefault: vi.fn() }, "/projects/foo");

    expect(env.getPendingOpenDirPaths()).toEqual(["/projects/foo"]);
    expect(env.getPendingOpenFilePaths()).toEqual([]);
  });

  it("queues multiple directories in FIFO order", async () => {
    const env = await import("../environment.js");
    const handler = getOpenFileHandler()!;
    fsMock.statSync.mockReturnValue({ isDirectory: () => true });
    handler({ preventDefault: vi.fn() }, "/a");
    handler({ preventDefault: vi.fn() }, "/b");
    expect(env.getPendingOpenDirPaths()).toEqual(["/a", "/b"]);
  });

  it("clearPendingOpenDirPaths empties the directory queue", async () => {
    const env = await import("../environment.js");
    const handler = getOpenFileHandler()!;
    fsMock.statSync.mockReturnValue({ isDirectory: () => true });
    handler({ preventDefault: vi.fn() }, "/a");
    env.clearPendingOpenDirPaths();
    expect(env.getPendingOpenDirPaths()).toEqual([]);
  });

  it("routes to the directory consumer instead of queueing once one is set", async () => {
    const env = await import("../environment.js");
    const handler = getOpenFileHandler()!;
    const consumer = vi.fn();
    env.setOpenDirConsumer(consumer);
    fsMock.statSync.mockReturnValue({ isDirectory: () => true });
    handler({ preventDefault: vi.fn() }, "/live/folder");

    expect(consumer).toHaveBeenCalledWith("/live/folder");
    expect(env.getPendingOpenDirPaths()).toEqual([]);
  });

  it("deduplicates identical queued directories before a window exists", async () => {
    const env = await import("../environment.js");
    const handler = getOpenFileHandler()!;
    fsMock.statSync.mockReturnValue({ isDirectory: () => true });
    handler({ preventDefault: vi.fn() }, "/dup");
    handler({ preventDefault: vi.fn() }, "/dup");
    expect(env.getPendingOpenDirPaths()).toEqual(["/dup"]);
  });

  it("queuePendingOpenDirPath deduplicates when re-queuing from the consumer", async () => {
    const env = await import("../environment.js");
    env.queuePendingOpenDirPath("/requeue");
    env.queuePendingOpenDirPath("/requeue");
    expect(env.getPendingOpenDirPaths()).toEqual(["/requeue"]);
  });

  it("calls preventDefault for directories too", async () => {
    await import("../environment.js");
    const handler = getOpenFileHandler()!;
    fsMock.statSync.mockReturnValue({ isDirectory: () => true });
    const event = { preventDefault: vi.fn() };
    handler(event, "/projects/foo");
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("routes a file (non-directory) through the plugin queue, not the directory queue", async () => {
    const env = await import("../environment.js");
    const handler = getOpenFileHandler()!;
    fsMock.statSync.mockReturnValue({ isDirectory: () => false });
    handler({ preventDefault: vi.fn() }, "/plugin.dntr");

    expect(env.getPendingOpenFilePaths()).toEqual(["/plugin.dntr"]);
    expect(env.getPendingOpenDirPaths()).toEqual([]);
  });

  it("treats a stat failure as a file so the plugin error route is preserved", async () => {
    const env = await import("../environment.js");
    const handler = getOpenFileHandler()!;
    fsMock.statSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    handler({ preventDefault: vi.fn() }, "/vanished.dntr");

    expect(env.getPendingOpenFilePaths()).toEqual(["/vanished.dntr"]);
    expect(env.getPendingOpenDirPaths()).toEqual([]);
  });

  it("routes a mixed burst of dir + file to the correct queues", async () => {
    const env = await import("../environment.js");
    const handler = getOpenFileHandler()!;
    mockStatDirectory("/projects/foo");
    handler({ preventDefault: vi.fn() }, "/projects/foo");
    handler({ preventDefault: vi.fn() }, "/plugin.dntr");

    expect(env.getPendingOpenDirPaths()).toEqual(["/projects/foo"]);
    expect(env.getPendingOpenFilePaths()).toEqual(["/plugin.dntr"]);
  });

  it("getPendingOpenDirPaths returns a copy so caller mutation is isolated", async () => {
    const env = await import("../environment.js");
    const handler = getOpenFileHandler()!;
    fsMock.statSync.mockReturnValue({ isDirectory: () => true });
    handler({ preventDefault: vi.fn() }, "/a");
    const snapshot = env.getPendingOpenDirPaths();
    snapshot.push("/injected");
    expect(env.getPendingOpenDirPaths()).toEqual(["/a"]);
  });

  it("stat failure routes to the file consumer even when a dir consumer is set", async () => {
    // Locks the invariant: stat decides before any consumer sees the path, so a
    // vanished/permission-denied path can never reach the directory route.
    const env = await import("../environment.js");
    const handler = getOpenFileHandler()!;
    const dirConsumer = vi.fn();
    const fileConsumer = vi.fn();
    env.setOpenDirConsumer(dirConsumer);
    env.setOpenFileConsumer(fileConsumer);
    fsMock.statSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    handler({ preventDefault: vi.fn() }, "/vanished.dntr");

    expect(fileConsumer).toHaveBeenCalledWith("/vanished.dntr");
    expect(dirConsumer).not.toHaveBeenCalled();
    expect(env.getPendingOpenDirPaths()).toEqual([]);
  });

  it("routes a .dntr path that is actually a directory to the dir queue (stat wins over extension)", async () => {
    const env = await import("../environment.js");
    const handler = getOpenFileHandler()!;
    fsMock.statSync.mockImplementation(((p: string) => ({
      isDirectory: () => p === "/odd/plugin.dntr",
    })) as (p: string) => {
      isDirectory: () => boolean;
    });
    handler({ preventDefault: vi.fn() }, "/odd/plugin.dntr");
    handler({ preventDefault: vi.fn() }, "/real.dntr");

    expect(env.getPendingOpenDirPaths()).toEqual(["/odd/plugin.dntr"]);
    expect(env.getPendingOpenFilePaths()).toEqual(["/real.dntr"]);
  });
});
