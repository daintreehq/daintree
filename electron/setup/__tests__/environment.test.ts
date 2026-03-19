import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn<(p: string) => boolean>(),
  readdirSync: vi.fn<(p: string) => string[]>(),
  rmSync: vi.fn(),
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

vi.mock("electron", () => ({
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

vi.mock("fix-path", () => ({
  default: vi.fn(),
}));

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

  it("sets --optimize_for_size V8 flag for compact code generation", async () => {
    fsMock.existsSync.mockReturnValue(false);

    await import("../environment.js");

    const nodeV8 = (await import("node:v8")).default;
    expect(nodeV8.setFlagsFromString).toHaveBeenCalledWith("--expose_gc");
    expect(nodeV8.setFlagsFromString).toHaveBeenCalledWith("--optimize_for_size");
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

describe("reset-data", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.argv = ["electron", "main.js"];
    delete process.env.CANOPY_RESET_DATA;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    process.argv = originalArgv;
    delete process.env.CANOPY_RESET_DATA;
  });

  it("wipes userData when CANOPY_RESET_DATA=1 is set", async () => {
    process.env.CANOPY_RESET_DATA = "1";
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
    process.env.CANOPY_RESET_DATA = "1";
    fsMock.existsSync.mockImplementation((p: string) => {
      if (p.includes("gpu-disabled.flag")) return false;
      return false; // userData path does not exist
    });

    await import("../environment.js");

    expect(fsMock.readdirSync).not.toHaveBeenCalled();
  });

  it("continues wiping other entries when rmSync throws on one", async () => {
    process.env.CANOPY_RESET_DATA = "1";
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

  it("ignores CANOPY_RESET_DATA values other than '1'", async () => {
    process.env.CANOPY_RESET_DATA = "true";
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    expect(fsMock.readdirSync).not.toHaveBeenCalled();
  });
});
