import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn<(p: string) => boolean>(),
}));

vi.mock("fs", () => ({
  default: { existsSync: fsMock.existsSync },
  existsSync: fsMock.existsSync,
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => "/tmp/test-appdata"),
    setPath: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    enableSandbox: vi.fn(),
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

describe("Windows Git PATH discovery", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    // Remove smoke-test flag so the module doesn't try to import node-pty
    process.argv = ["electron", "main.js"];
    // Start with an empty PATH
    process.env.PATH = "";
    // Remove env vars that would affect tests
    delete process.env["ProgramFiles"];
    delete process.env["ProgramFiles(x86)"];
    delete process.env["ChocolateyInstall"];
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    process.argv = originalArgv;
  });

  it("uses fallback paths when env vars are not set", async () => {
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const pathEntries = (process.env.PATH || "").split(path.delimiter);
    // User install
    expect(pathEntries).toContain(
      path.join("C:\\Users\\testuser", "AppData", "Local", "Programs", "Git", "cmd")
    );
    // Standard Program Files fallback
    expect(pathEntries).toContain(path.join("C:\\Program Files", "Git", "cmd"));
    // x86 Program Files fallback
    expect(pathEntries).toContain(path.join("C:\\Program Files (x86)", "Git", "cmd"));
    // Scoop
    expect(pathEntries).toContain(path.join("C:\\Users\\testuser", "scoop", "shims"));
    // Chocolatey fallback
    expect(pathEntries).toContain(path.join("C:\\ProgramData\\chocolatey", "bin"));
  });

  it("uses ProgramFiles env var when set", async () => {
    process.env["ProgramFiles"] = "D:\\Programs";
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const pathEntries = (process.env.PATH || "").split(path.delimiter);
    expect(pathEntries).toContain(path.join("D:\\Programs", "Git", "cmd"));
    expect(pathEntries).not.toContain(path.join("C:\\Program Files", "Git", "cmd"));
  });

  it("uses ProgramFiles(x86) env var when set", async () => {
    process.env["ProgramFiles(x86)"] = "D:\\Programs (x86)";
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const pathEntries = (process.env.PATH || "").split(path.delimiter);
    expect(pathEntries).toContain(path.join("D:\\Programs (x86)", "Git", "cmd"));
  });

  it("uses ChocolateyInstall env var when set", async () => {
    process.env["ChocolateyInstall"] = "D:\\Chocolatey";
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const pathEntries = (process.env.PATH || "").split(path.delimiter);
    expect(pathEntries).toContain(path.join("D:\\Chocolatey", "bin"));
    expect(pathEntries).not.toContain(path.join("C:\\ProgramData\\chocolatey", "bin"));
  });

  it("filters out paths that do not exist on disk", async () => {
    fsMock.existsSync.mockReturnValue(false);

    await import("../environment.js");

    // PATH should be unchanged (empty) since no candidate exists
    expect(process.env.PATH).toBe("");
  });

  it("does not duplicate paths already in PATH (case-insensitive)", async () => {
    const existing = path.join("C:\\Program Files", "Git", "cmd");
    process.env.PATH = existing.toUpperCase();
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const pathEntries = (process.env.PATH || "").split(path.delimiter);
    // The uppercase original should still be there
    expect(pathEntries).toContain(existing.toUpperCase());
    // The lowercase duplicate should NOT appear separately
    const matches = pathEntries.filter(
      (p) => p.toLowerCase() === existing.toLowerCase()
    );
    expect(matches).toHaveLength(1);
  });

  it("does not include .local/bin (Unix-only path regression)", async () => {
    fsMock.existsSync.mockReturnValue(true);

    await import("../environment.js");

    const pathEntries = (process.env.PATH || "").split(path.delimiter);
    const hasLocalBin = pathEntries.some((p) => p.includes(".local" + path.sep + "bin"));
    expect(hasLocalBin).toBe(false);
  });
});
