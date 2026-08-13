import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFile } from "child_process";
import {
  runSystemHealthCheck,
  resolvePrerequisites,
  resetSystemHealthCheckCache,
  BASELINE_PREREQUISITES,
} from "../SystemHealthCheck.js";
import { refreshPath } from "../../setup/environment.js";
import { setUserRegistry, type AgentConfig } from "../../../shared/config/agentRegistry.js";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("../../setup/environment.js", () => ({
  refreshPath: vi.fn().mockResolvedValue(undefined),
}));

const mockedExecFile = vi.mocked(execFile);

type ExecCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void;

/**
 * Drives the promisified `execFile` from a plain (command, args) -> stdout
 * function. Throwing from the handler stands in for a nonzero exit, which is
 * the distinction the availability logic now turns on.
 */
function mockExec(handler: (cmd: string, args: string[]) => string) {
  mockedExecFile.mockImplementation(((
    cmd: string,
    args: string[],
    _options: unknown,
    callback: ExecCallback
  ) => {
    try {
      callback(null, { stdout: handler(cmd, args ?? []), stderr: "" });
    } catch (err) {
      callback(err as Error);
    }
    return undefined;
  }) as never);
}

/** Commands the tool-presence probe should report as found. */
function mockLookup(found: string[], versions: Record<string, string>) {
  mockExec((cmd, args) => {
    if (cmd === "which" || cmd === "where") {
      const target = args[0] ?? "";
      if (!found.includes(target)) throw new Error(`${target} not found`);
      return `/usr/local/bin/${target}\n`;
    }
    const version = versions[cmd];
    if (version === undefined) throw new Error(`${cmd} failed`);
    return version;
  });
}

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
  const ALL_TOOLS = ["git", "node", "npm", "gh"];
  const ALL_VERSIONS = {
    git: "git version 2.43.0\n",
    node: "v20.11.0\n",
    npm: "10.2.4\n",
    gh: "gh version 2.40.0 (2024-01-15)\nhttps://github.com/cli/cli\n",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetSystemHealthCheckCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes PATH before spawning any probe", async () => {
    // Ordering matters: a probe that runs first would miss a tool installed
    // since launch, which is the whole point of the mid-session re-check.
    let refreshedBeforeFirstProbe: boolean | null = null;
    vi.mocked(refreshPath).mockImplementation(async () => {
      refreshedBeforeFirstProbe ??= mockedExecFile.mock.calls.length === 0;
    });
    mockLookup(ALL_TOOLS, ALL_VERSIONS);

    await runSystemHealthCheck();

    expect(refreshedBeforeFirstProbe).toBe(true);
    expect(mockedExecFile.mock.calls.length).toBeGreaterThan(0);
  });

  it("returns a result for every resolved baseline spec", async () => {
    mockLookup(ALL_TOOLS, ALL_VERSIONS);

    const result = await runSystemHealthCheck();

    expect(result.prerequisites.map((p) => p.tool).sort()).toEqual(
      resolvePrerequisites()
        .map((s) => s.tool)
        .sort()
    );
  });

  it("extracts versions using semver.coerce", async () => {
    mockLookup(ALL_TOOLS, ALL_VERSIONS);

    const result = await runSystemHealthCheck();

    expect(result.prerequisites.find((p) => p.tool === "git")?.version).toBe("2.43.0");
    expect(result.prerequisites.find((p) => p.tool === "node")?.version).toBe("20.11.0");
  });

  it("includes agent prerequisites when agentIds provided", async () => {
    mockLookup([...ALL_TOOLS, "claude"], { ...ALL_VERSIONS, claude: "1.0.0\n" });

    const result = await runSystemHealthCheck({ agentIds: ["claude"] });

    expect(result.prerequisites.some((p) => p.tool === "claude")).toBe(true);
  });

  it("marks a tool unavailable when the presence probe fails", async () => {
    mockLookup(["node", "npm", "gh"], ALL_VERSIONS);

    const result = await runSystemHealthCheck();

    const git = result.prerequisites.find((p) => p.tool === "git");
    expect(git?.available).toBe(false);
    expect(git?.unavailableReason).toBe("not-found");
  });

  it("marks a tool unavailable when the version command exits nonzero", async () => {
    // The macOS Command Line Tools shim in miniature: the binary resolves, but
    // running it fails. Before #11763 this reported healthy.
    mockLookup(ALL_TOOLS, { node: ALL_VERSIONS.node, npm: ALL_VERSIONS.npm, gh: ALL_VERSIONS.gh });

    const result = await runSystemHealthCheck();

    const git = result.prerequisites.find((p) => p.tool === "git");
    expect(git?.available).toBe(false);
    expect(git?.unavailableReason).toBe("version-command-failed");
    expect(git?.version).toBeNull();
  });

  it("keeps a tool available when it runs but prints an unparseable version", async () => {
    mockLookup(ALL_TOOLS, { ...ALL_VERSIONS, git: "some custom build\n" });

    const result = await runSystemHealthCheck();

    const git = result.prerequisites.find((p) => p.tool === "git");
    expect(git?.available).toBe(true);
    expect(git?.version).toBeNull();
    expect(git?.unavailableReason).toBeUndefined();
  });

  it("fails the minimum-version check when a versioned tool prints unparseable output", async () => {
    mockLookup(ALL_TOOLS, { ...ALL_VERSIONS, node: "not-a-version\n" });

    const result = await runSystemHealthCheck();

    const node = result.prerequisites.find((p) => p.tool === "node");
    expect(node?.available).toBe(true);
    expect(node?.meetsMinVersion).toBe(false);
  });

  it("meetsMinVersion is false when the version is below the minimum", async () => {
    mockLookup(ALL_TOOLS, { ...ALL_VERSIONS, node: "v16.20.0\n" });

    const result = await runSystemHealthCheck();

    expect(result.prerequisites.find((p) => p.tool === "node")?.meetsMinVersion).toBe(false);
    expect(result.allRequired).toBe(false);
  });

  it("allRequired is true when every fatal tool is healthy", async () => {
    mockLookup(ALL_TOOLS, ALL_VERSIONS);

    const result = await runSystemHealthCheck();

    expect(result.allRequired).toBe(true);
  });

  it("allRequired ignores warn-severity tools", async () => {
    const fatalTools = resolvePrerequisites()
      .filter((s) => s.severity === "fatal")
      .map((s) => s.tool);
    mockLookup(fatalTools, ALL_VERSIONS);

    const result = await runSystemHealthCheck();

    expect(result.prerequisites.some((p) => p.severity === "warn" && !p.available)).toBe(true);
    expect(result.allRequired).toBe(true);
  });

  it("allRequired is false when a fatal tool is missing", async () => {
    mockLookup([], {});

    const result = await runSystemHealthCheck();

    expect(result.allRequired).toBe(false);
  });

  it("carries label, severity, installUrl and installBlocks from the spec", async () => {
    mockLookup(ALL_TOOLS, ALL_VERSIONS);

    const result = await runSystemHealthCheck();

    const gitSpec = resolvePrerequisites().find((s) => s.tool === "git");
    const git = result.prerequisites.find((p) => p.tool === "git");
    expect(git?.label).toBe(gitSpec?.label);
    expect(git?.severity).toBe(gitSpec?.severity);
    expect(git?.installUrl).toBe(gitSpec?.installUrl);
    expect(git?.installBlocks).toEqual(gitSpec?.installBlocks);
  });

  it("carries installBlocks through for unavailable tools too", async () => {
    mockLookup([], {});

    const result = await runSystemHealthCheck();

    const git = result.prerequisites.find((p) => p.tool === "git");
    expect(git?.available).toBe(false);
    expect(git?.installBlocks).toEqual(
      resolvePrerequisites().find((s) => s.tool === "git")?.installBlocks
    );
  });

  it("reads only the first line of multi-line version output", async () => {
    mockLookup(ALL_TOOLS, ALL_VERSIONS);

    const result = await runSystemHealthCheck();

    expect(result.prerequisites.find((p) => p.tool === "gh")?.version).toBe("2.40.0");
  });

  it("uses 'which' on unix-like systems", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      mockLookup(ALL_TOOLS, ALL_VERSIONS);

      await runSystemHealthCheck();

      expect(mockedExecFile.mock.calls.some((c) => c[0] === "which")).toBe(true);
      expect(mockedExecFile.mock.calls.some((c) => c[0] === "where")).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("uses 'where' on windows", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      mockLookup(ALL_TOOLS, ALL_VERSIONS);

      await runSystemHealthCheck();

      expect(mockedExecFile.mock.calls.some((c) => c[0] === "where")).toBe(true);
      expect(mockedExecFile.mock.calls.some((c) => c[0] === "which")).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  describe("fatalOnly subset", () => {
    it("probes only fatal specs", async () => {
      mockLookup(ALL_TOOLS, ALL_VERSIONS);

      const result = await runSystemHealthCheck({ fatalOnly: true });

      expect(result.prerequisites.length).toBeGreaterThan(0);
      expect(result.prerequisites.every((p) => p.severity === "fatal")).toBe(true);
      expect(result.prerequisites.some((p) => p.tool === "gh")).toBe(false);
    });
  });

  describe("fatal-only caching", () => {
    it("probes once across repeated calls", async () => {
      mockLookup(ALL_TOOLS, ALL_VERSIONS);

      await runSystemHealthCheck({ fatalOnly: true });
      const callsAfterFirst = mockedExecFile.mock.calls.length;
      await runSystemHealthCheck({ fatalOnly: true });

      expect(mockedExecFile.mock.calls.length).toBe(callsAfterFirst);
    });

    it("collapses concurrent callers into a single probe", async () => {
      mockLookup(ALL_TOOLS, ALL_VERSIONS);

      const [a, b] = await Promise.all([
        runSystemHealthCheck({ fatalOnly: true }),
        runSystemHealthCheck({ fatalOnly: true }),
      ]);

      expect(a).toBe(b);
      expect(refreshPath).toHaveBeenCalledTimes(1);
    });

    it("re-probes when forced, and reflects a tool that appeared since", async () => {
      mockLookup(["node", "npm", "gh"], ALL_VERSIONS);
      const before = await runSystemHealthCheck({ fatalOnly: true });
      expect(before.prerequisites.find((p) => p.tool === "git")?.available).toBe(false);

      mockLookup(ALL_TOOLS, ALL_VERSIONS);
      const cached = await runSystemHealthCheck({ fatalOnly: true });
      expect(cached.prerequisites.find((p) => p.tool === "git")?.available).toBe(false);

      const forced = await runSystemHealthCheck({ fatalOnly: true, force: true });
      expect(forced.prerequisites.find((p) => p.tool === "git")?.available).toBe(true);
    });

    it("does not serve the cache to a full check", async () => {
      mockLookup(ALL_TOOLS, ALL_VERSIONS);
      await runSystemHealthCheck({ fatalOnly: true });

      const full = await runSystemHealthCheck();

      expect(full.prerequisites.some((p) => p.severity === "warn")).toBe(true);
    });

    it("a forced check never joins a probe that started before it", async () => {
      // The post-install re-check: a focus probe is already running with the
      // tool absent when the install finishes. Joining it would report the tool
      // still missing.
      let releaseFirstProbe: () => void = () => {};
      const firstProbeStarted = new Promise<void>((started) => {
        mockedExecFile.mockImplementation(((
          cmd: string,
          args: string[],
          _options: unknown,
          callback: ExecCallback
        ) => {
          if (cmd === "which" && args[0] === "git") {
            started();
            void new Promise<void>((release) => {
              releaseFirstProbe = () => release();
            }).then(() => callback(new Error("git not found")));
            return undefined;
          }
          callback(null, { stdout: "v20.11.0\n", stderr: "" });
          return undefined;
        }) as never);
      });

      const slowProbe = runSystemHealthCheck({ fatalOnly: true });
      await firstProbeStarted;

      // Git gets installed while that probe is still in flight.
      mockLookup(ALL_TOOLS, ALL_VERSIONS);
      const forced = runSystemHealthCheck({ fatalOnly: true, force: true });
      releaseFirstProbe();

      expect((await slowProbe).prerequisites.find((p) => p.tool === "git")?.available).toBe(false);
      expect((await forced).prerequisites.find((p) => p.tool === "git")?.available).toBe(true);
    });

    it("does not cache agent-scoped checks", async () => {
      mockLookup([...ALL_TOOLS, "claude"], { ...ALL_VERSIONS, claude: "1.0.0\n" });

      await runSystemHealthCheck({ fatalOnly: true, agentIds: ["claude"] });
      const callsAfterFirst = mockedExecFile.mock.calls.length;
      await runSystemHealthCheck({ fatalOnly: true, agentIds: ["claude"] });

      expect(mockedExecFile.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });
  });

  describe("macOS Command Line Tools shim", () => {
    // Preserve the whole descriptor: replacing it with a `writable: true` data
    // property leaks a mutable `process.platform` into every later test sharing
    // the worker.
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(process, "platform", originalPlatform);
    });

    it("never executes the shim when the tools are absent", async () => {
      mockExec((cmd, args) => {
        if (cmd === "which") return `/usr/bin/${args[0]}\n`;
        if (cmd === "xcode-select") throw new Error("unable to get active developer directory");
        if (cmd === "git") throw new Error("git should never be executed here");
        return "1.0.0\n";
      });

      const result = await runSystemHealthCheck({ fatalOnly: true });

      const git = result.prerequisites.find((p) => p.tool === "git");
      expect(git?.available).toBe(false);
      expect(git?.unavailableReason).toBe("macos-command-line-tools-missing");
      expect(mockedExecFile.mock.calls.some((c) => c[0] === "git")).toBe(false);
    });

    it("runs the version command when the tools are present", async () => {
      mockExec((cmd, args) => {
        if (cmd === "which") return `/usr/bin/${args[0]}\n`;
        if (cmd === "xcode-select") return "/Library/Developer/CommandLineTools\n";
        if (cmd === "git") return "git version 2.43.0\n";
        return "v20.11.0\n";
      });

      const result = await runSystemHealthCheck({ fatalOnly: true });

      expect(result.prerequisites.find((p) => p.tool === "git")?.available).toBe(true);
    });

    it("skips the tools probe when git resolves outside /usr/bin", async () => {
      // A Homebrew git is a real binary and works whether or not the Command
      // Line Tools are installed, so it must not be gated behind them.
      mockExec((cmd, args) => {
        if (cmd === "which") return `/opt/homebrew/bin/${args[0]}\n`;
        if (cmd === "xcode-select") throw new Error("unable to get active developer directory");
        if (cmd === "git") return "git version 2.43.0\n";
        return "v20.11.0\n";
      });

      const result = await runSystemHealthCheck({ fatalOnly: true });

      expect(result.prerequisites.find((p) => p.tool === "git")?.available).toBe(true);
      expect(mockedExecFile.mock.calls.some((c) => c[0] === "xcode-select")).toBe(false);
    });

    it("does not probe the tools for prerequisites that aren't CLT-provided", async () => {
      mockExec((cmd, args) => {
        if (cmd === "which") return args[0] === "node" ? "/usr/bin/node\n" : "/opt/bin/git\n";
        if (cmd === "xcode-select") throw new Error("unable to get active developer directory");
        if (cmd === "git") return "git version 2.43.0\n";
        return "v20.11.0\n";
      });

      const result = await runSystemHealthCheck({ fatalOnly: true });

      expect(result.prerequisites.find((p) => p.tool === "node")?.available).toBe(true);
    });
  });
});
