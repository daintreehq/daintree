import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import {
  runSystemHealthCheck,
  resolvePrerequisites,
  BASELINE_PREREQUISITES,
} from "../SystemHealthCheck.js";
import { setUserRegistry, type AgentConfig } from "../../../shared/config/agentRegistry.js";

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

describe("resolvePrerequisites", () => {
  it("returns baseline prerequisites when no agentIds provided", () => {
    const specs = resolvePrerequisites();
    const tools = specs.map((s) => s.tool);
    expect(tools).toContain("git");
    expect(tools).toContain("node");
    expect(tools).toContain("npm");
    expect(tools).toContain("gh");
    expect(tools).not.toContain("claude");
  });

  it("includes agent prerequisites when agentIds provided", () => {
    const specs = resolvePrerequisites(["claude"]);
    const tools = specs.map((s) => s.tool);
    expect(tools).toContain("git");
    expect(tools).toContain("node");
    expect(tools).toContain("claude");
  });

  it("includes prerequisites for multiple agents", () => {
    const specs = resolvePrerequisites(["claude", "gemini"]);
    const tools = specs.map((s) => s.tool);
    expect(tools).toContain("claude");
    expect(tools).toContain("gemini");
  });

  it("deduplicates by tool name keeping stricter severity", () => {
    const testAgent: AgentConfig = {
      id: "test-agent",
      name: "Test",
      command: "test-agent",
      color: "#000",
      iconId: "test",
      supportsContextInjection: false,
      prerequisites: [{ tool: "npm", label: "npm", versionArgs: ["--version"], severity: "fatal" }],
    };
    setUserRegistry({ "test-agent": testAgent });

    const specs = resolvePrerequisites(["test-agent"]);
    const npmSpec = specs.find((s) => s.tool === "npm");
    // npm is baseline "warn" but test-agent declares it "fatal" — fatal should win
    expect(npmSpec?.severity).toBe("fatal");

    setUserRegistry({});
  });

  it("deduplicates keeping higher minVersion", () => {
    const testAgent: AgentConfig = {
      id: "test-agent",
      name: "Test",
      command: "test-agent",
      color: "#000",
      iconId: "test",
      supportsContextInjection: false,
      prerequisites: [
        {
          tool: "node",
          label: "Node.js",
          versionArgs: ["--version"],
          severity: "fatal",
          minVersion: "20.0.0",
        },
      ],
    };
    setUserRegistry({ "test-agent": testAgent });

    const specs = resolvePrerequisites(["test-agent"]);
    const nodeSpec = specs.find((s) => s.tool === "node");
    // Baseline node has minVersion 18.0.0, agent wants 20.0.0 — higher wins
    expect(nodeSpec?.minVersion).toBe("20.0.0");

    setUserRegistry({});
  });

  it("does not produce duplicates when same tool appears in baseline and agent", () => {
    const testAgent: AgentConfig = {
      id: "test-agent",
      name: "Test",
      command: "test-agent",
      color: "#000",
      iconId: "test",
      supportsContextInjection: false,
      prerequisites: [{ tool: "git", label: "Git", versionArgs: ["--version"], severity: "fatal" }],
    };
    setUserRegistry({ "test-agent": testAgent });

    const specs = resolvePrerequisites(["test-agent"]);
    const gitSpecs = specs.filter((s) => s.tool === "git");
    expect(gitSpecs).toHaveLength(1);

    setUserRegistry({});
  });

  it("ignores unknown agent IDs gracefully", () => {
    const specs = resolvePrerequisites(["nonexistent"]);
    expect(specs.length).toBe(BASELINE_PREREQUISITES.length);
  });
});

describe("runSystemHealthCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockAllBaselineAvailable() {
    mockedExecFileSync.mockImplementation((cmd, args) => {
      const arg = Array.isArray(args) ? args[0] : "";
      if (cmd === "git") return "git version 2.43.0\n";
      if (cmd === "node") return "v20.11.0\n";
      if (cmd === "npm") return "10.2.4\n";
      if (cmd === "gh") return "gh version 2.40.0 (2024-01-15)\nhttps://github.com/cli/cli\n";
      if (arg === "git" || arg === "node" || arg === "npm" || arg === "gh") return "";
      return "";
    });
  }

  it("returns baseline tools when no agentIds provided", async () => {
    mockAllBaselineAvailable();

    const result = await runSystemHealthCheck();

    expect(result.allRequired).toBe(true);
    expect(result.prerequisites.length).toBe(BASELINE_PREREQUISITES.length);

    const tools = result.prerequisites.map((p) => p.tool);
    expect(tools).toContain("git");
    expect(tools).toContain("node");
    expect(tools).toContain("npm");
    expect(tools).toContain("gh");
  });

  it("extracts versions using semver.coerce", async () => {
    mockAllBaselineAvailable();

    const result = await runSystemHealthCheck();

    expect(result.prerequisites.find((p) => p.tool === "git")?.version).toBe("2.43.0");
    expect(result.prerequisites.find((p) => p.tool === "node")?.version).toBe("20.11.0");
    expect(result.prerequisites.find((p) => p.tool === "npm")?.version).toBe("10.2.4");
    expect(result.prerequisites.find((p) => p.tool === "gh")?.version).toBe("2.40.0");
  });

  it("includes agent prerequisites when agentIds provided", async () => {
    mockedExecFileSync.mockImplementation((cmd, args) => {
      const arg = Array.isArray(args) ? args[0] : "";
      if (cmd === "git") return "git version 2.43.0\n";
      if (cmd === "node") return "v20.11.0\n";
      if (cmd === "npm") return "10.2.4\n";
      if (cmd === "gh") return "gh version 2.40.0 (2024-01-15)\n";
      if (cmd === "claude") return "1.2.3\n";
      if (arg === "git" || arg === "node" || arg === "npm" || arg === "gh" || arg === "claude")
        return "";
      return "";
    });

    const result = await runSystemHealthCheck(["claude"]);

    const claude = result.prerequisites.find((p) => p.tool === "claude");
    expect(claude).toBeDefined();
    expect(claude?.available).toBe(true);
    expect(claude?.severity).toBe("fatal");
    expect(claude?.label).toBe("Claude CLI");
  });

  it("marks tool as unavailable when which/where fails", async () => {
    mockedExecFileSync.mockImplementation((cmd, args) => {
      const arg = Array.isArray(args) ? args[0] : "";
      if (arg === "git") throw new Error("not found");
      if (cmd === "node") return "v20.11.0\n";
      if (cmd === "npm") return "10.2.4\n";
      if (cmd === "gh") return "gh version 2.40.0\n";
      return "";
    });

    const result = await runSystemHealthCheck();

    const git = result.prerequisites.find((p) => p.tool === "git");
    expect(git?.available).toBe(false);
    expect(git?.version).toBeNull();
    expect(result.allRequired).toBe(false);
  });

  it("allRequired is false when fatal prerequisite is missing", async () => {
    mockedExecFileSync.mockImplementation((cmd, args) => {
      const arg = Array.isArray(args) ? args[0] : "";
      if (arg === "node") throw new Error("not found");
      if (cmd === "git") return "git version 2.43.0\n";
      if (cmd === "npm") return "10.2.4\n";
      if (cmd === "gh") return "gh version 2.40.0\n";
      return "";
    });

    const result = await runSystemHealthCheck();
    expect(result.allRequired).toBe(false);
  });

  it("allRequired is true when only warn-severity tool is missing", async () => {
    mockedExecFileSync.mockImplementation((cmd, args) => {
      const arg = Array.isArray(args) ? args[0] : "";
      if (cmd === "git") return "git version 2.43.0\n";
      if (cmd === "node") return "v20.11.0\n";
      if (arg === "npm") throw new Error("not found");
      if (arg === "gh") throw new Error("not found");
      return "";
    });

    const result = await runSystemHealthCheck();
    expect(result.allRequired).toBe(true);
  });

  it("returns available=true with null version if version command fails", async () => {
    mockedExecFileSync.mockImplementation((cmd, args) => {
      const arg = Array.isArray(args) ? args[0] : "";
      if (arg === "git") return "";
      if (cmd === "git") throw new Error("version check failed");
      if (cmd === "node") return "v20.11.0\n";
      if (cmd === "npm") return "10.2.4\n";
      if (cmd === "gh") return "gh version 2.40.0\n";
      return "";
    });

    const result = await runSystemHealthCheck();

    const git = result.prerequisites.find((p) => p.tool === "git");
    expect(git?.available).toBe(true);
    expect(git?.version).toBeNull();
  });

  it("allRequired is false when all tools are missing", async () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const result = await runSystemHealthCheck();

    expect(result.allRequired).toBe(false);
    expect(result.prerequisites.every((p) => !p.available)).toBe(true);
    expect(result.prerequisites.every((p) => p.version === null)).toBe(true);
  });

  it("meetsMinVersion is false when version is below minimum", async () => {
    mockedExecFileSync.mockImplementation((cmd, args) => {
      const arg = Array.isArray(args) ? args[0] : "";
      if (cmd === "git") return "git version 2.43.0\n";
      if (cmd === "node") return "v16.0.0\n"; // Below minVersion 18.0.0
      if (cmd === "npm") return "10.2.4\n";
      if (cmd === "gh") return "gh version 2.40.0\n";
      if (arg === "git" || arg === "node" || arg === "npm" || arg === "gh") return "";
      return "";
    });

    const result = await runSystemHealthCheck();

    const node = result.prerequisites.find((p) => p.tool === "node");
    expect(node?.available).toBe(true);
    expect(node?.version).toBe("16.0.0");
    expect(node?.meetsMinVersion).toBe(false);
    expect(result.allRequired).toBe(false);
  });

  it("meetsMinVersion is false when version command fails for a tool with minVersion", async () => {
    mockedExecFileSync.mockImplementation((cmd, args) => {
      const arg = Array.isArray(args) ? args[0] : "";
      if (cmd === "git") return "git version 2.43.0\n";
      if (arg === "node") return ""; // which succeeds
      if (cmd === "node") throw new Error("version check failed"); // version extraction fails
      if (cmd === "npm") return "10.2.4\n";
      if (cmd === "gh") return "gh version 2.40.0\n";
      return "";
    });

    const result = await runSystemHealthCheck();

    const node = result.prerequisites.find((p) => p.tool === "node");
    expect(node?.available).toBe(true);
    expect(node?.version).toBeNull();
    expect(node?.meetsMinVersion).toBe(false);
    expect(result.allRequired).toBe(false);
  });

  it("handles unparsable version output gracefully", async () => {
    mockedExecFileSync.mockImplementation((cmd, args) => {
      const arg = Array.isArray(args) ? args[0] : "";
      if (cmd === "git") return "git version 2.43.0\n";
      if (cmd === "node") return "not-a-version\n";
      if (cmd === "npm") return "10.2.4\n";
      if (cmd === "gh") return "gh version 2.40.0\n";
      if (arg === "git" || arg === "node" || arg === "npm" || arg === "gh") return "";
      return "";
    });

    const result = await runSystemHealthCheck();

    const node = result.prerequisites.find((p) => p.tool === "node");
    expect(node?.available).toBe(true);
    expect(node?.version).toBeNull();
    expect(node?.meetsMinVersion).toBe(false);
  });

  it("meetsMinVersion is true when version meets minimum", async () => {
    mockAllBaselineAvailable();

    const result = await runSystemHealthCheck();

    const node = result.prerequisites.find((p) => p.tool === "node");
    expect(node?.meetsMinVersion).toBe(true);
  });

  it("each result includes label, severity, and installUrl from spec", async () => {
    mockAllBaselineAvailable();

    const result = await runSystemHealthCheck();

    const git = result.prerequisites.find((p) => p.tool === "git");
    expect(git?.label).toBe("Git");
    expect(git?.severity).toBe("fatal");
    expect(git?.installUrl).toBe("https://git-scm.com/downloads");

    const gh = result.prerequisites.find((p) => p.tool === "gh");
    expect(gh?.label).toBe("GitHub CLI");
    expect(gh?.severity).toBe("warn");
  });

  it("handles gh --version multi-line output correctly", async () => {
    mockedExecFileSync.mockImplementation((cmd, args) => {
      const arg = Array.isArray(args) ? args[0] : "";
      if (cmd === "gh")
        return "gh version 2.40.0 (2024-01-15)\nhttps://github.com/cli/cli/releases/tag/v2.40.0\n";
      if (cmd === "git") return "git version 2.43.0\n";
      if (cmd === "node") return "v20.11.0\n";
      if (cmd === "npm") return "10.2.4\n";
      if (arg === "git" || arg === "node" || arg === "npm" || arg === "gh") return "";
      return "";
    });

    const result = await runSystemHealthCheck();
    const gh = result.prerequisites.find((p) => p.tool === "gh");
    expect(gh?.version).toBe("2.40.0");
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
