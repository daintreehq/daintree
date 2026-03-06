import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { runSystemHealthCheck } from "../SystemHealthCheck.js";

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

describe("runSystemHealthCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockAllAvailable() {
    mockedExecFileSync.mockImplementation((cmd, args) => {
      // which/where call: cmd = "which"/"where", args[0] = tool name → return anything (just don't throw)
      // version call: cmd = tool name (e.g. "git"), args[0] = "--version" → return version string
      const arg = Array.isArray(args) ? args[0] : "";
      if (cmd === "git") return "git version 2.43.0\n";
      if (cmd === "node") return "v20.11.0\n";
      if (cmd === "npm") return "10.2.4\n";
      if (arg === "git" || arg === "node" || arg === "npm") return ""; // which/where success
      return "";
    });
  }

  it("returns all tools as available when they are in PATH with version info", async () => {
    mockAllAvailable();

    const result = await runSystemHealthCheck();

    expect(result.allRequired).toBe(true);
    expect(result.prerequisites).toHaveLength(3);

    const git = result.prerequisites.find((p) => p.tool === "git");
    expect(git?.available).toBe(true);
    expect(git?.version).toBe("2.43.0");

    const node = result.prerequisites.find((p) => p.tool === "node");
    expect(node?.available).toBe(true);
    expect(node?.version).toBe("20.11.0");

    const npm = result.prerequisites.find((p) => p.tool === "npm");
    expect(npm?.available).toBe(true);
    expect(npm?.version).toBe("10.2.4");
  });

  it("marks tool as unavailable when which/where fails", async () => {
    mockedExecFileSync.mockImplementation((cmd, args) => {
      const arg = Array.isArray(args) ? args[0] : "";
      if (arg === "git") throw new Error("not found");
      if (cmd === "node") return "v20.11.0\n";
      if (cmd === "npm") return "10.2.4\n";
      return "";
    });

    const result = await runSystemHealthCheck();

    const git = result.prerequisites.find((p) => p.tool === "git");
    expect(git?.available).toBe(false);
    expect(git?.version).toBeNull();

    expect(result.allRequired).toBe(false);
  });

  it("allRequired is false when node is missing (node is required)", async () => {
    mockedExecFileSync.mockImplementation((cmd, args) => {
      const arg = Array.isArray(args) ? args[0] : "";
      if (cmd === "git") return "git version 2.43.0\n";
      if (arg === "node") throw new Error("not found");
      if (cmd === "npm") return "10.2.4\n";
      return "";
    });

    const result = await runSystemHealthCheck();

    expect(result.allRequired).toBe(false);
  });

  it("allRequired is true when only npm (optional) is missing", async () => {
    mockedExecFileSync.mockImplementation((cmd, args) => {
      const arg = Array.isArray(args) ? args[0] : "";
      if (cmd === "git") return "git version 2.43.0\n";
      if (cmd === "node") return "v20.11.0\n";
      if (arg === "npm") throw new Error("not found");
      return "";
    });

    const result = await runSystemHealthCheck();

    expect(result.allRequired).toBe(true);

    const npm = result.prerequisites.find((p) => p.tool === "npm");
    expect(npm?.available).toBe(false);
  });

  it("returns available=true with null version if version command fails", async () => {
    mockedExecFileSync.mockImplementation((cmd, args) => {
      const arg = Array.isArray(args) ? args[0] : "";
      // which/where git succeeds (arg === "git"), but git --version fails (cmd === "git")
      if (arg === "git") return ""; // which/where succeeds
      if (cmd === "git") throw new Error("version check failed"); // git --version fails
      if (cmd === "node") return "v20.11.0\n";
      if (cmd === "npm") return "10.2.4\n";
      return "";
    });

    const result = await runSystemHealthCheck();

    const git = result.prerequisites.find((p) => p.tool === "git");
    expect(git?.available).toBe(true);
    expect(git?.version).toBeNull();
  });

  it("runs all checks and returns results for git, node, and npm", async () => {
    mockedExecFileSync.mockReturnValue(Buffer.from(""));

    const result = await runSystemHealthCheck();

    const tools = result.prerequisites.map((p) => p.tool);
    expect(tools).toContain("git");
    expect(tools).toContain("node");
    expect(tools).toContain("npm");
    expect(result.prerequisites).toHaveLength(3);
  });

  it("uses 'which' on unix-like systems", async () => {
    const originalPlatform = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "darwin", writable: true });
      mockedExecFileSync.mockReturnValue(Buffer.from(""));

      await runSystemHealthCheck();

      const calls = mockedExecFileSync.mock.calls;
      const whichCalls = calls.filter((c) => c[0] === "which");
      expect(whichCalls.length).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    }
  });

  it("uses 'where' on windows", async () => {
    const originalPlatform = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "win32", writable: true });
      mockedExecFileSync.mockReturnValue(Buffer.from(""));

      await runSystemHealthCheck();

      const calls = mockedExecFileSync.mock.calls;
      const whereCalls = calls.filter((c) => c[0] === "where");
      expect(whereCalls.length).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    }
  });
});
