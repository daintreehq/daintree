import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { EventEmitter } from "events";
import type { AgentId } from "../../../shared/types/agent.js";

const registryMock = vi.hoisted(() => ({
  getEffectiveAgentIds: vi.fn(),
  getEffectiveAgentConfig: vi.fn(),
}));

// Hoisted spawn mock — vi.spyOn can't redefine ESM-namespace exports of
// `child_process`, so we substitute the whole module at hoist time. The
// installed-version probe spawns `<command> --version` and resolves on the
// child's `exit` event; tests drive a fake ChildProcess via the helpers below.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("../../../shared/config/agentRegistry.js", () => registryMock);

import { AgentVersionService } from "../AgentVersionService.js";
import type { CliAvailabilityService } from "../CliAvailabilityService.js";

// Build a minimal fake ChildProcess: stdout/stderr as EventEmitters (with the
// `destroy` the probe calls on settle) plus `exit`/`error` events and a pid.
function makeFakeChild(): EventEmitter & {
  pid: number;
  kill: Mock;
  stdout: EventEmitter & { destroy: Mock };
  stderr: EventEmitter & { destroy: Mock };
} {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    kill: Mock;
    stdout: EventEmitter & { destroy: Mock };
    stderr: EventEmitter & { destroy: Mock };
  };
  child.pid = 4242;
  child.kill = vi.fn();
  const stdout = new EventEmitter() as EventEmitter & { destroy: Mock };
  stdout.destroy = vi.fn();
  const stderr = new EventEmitter() as EventEmitter & { destroy: Mock };
  stderr.destroy = vi.fn();
  child.stdout = stdout;
  child.stderr = stderr;
  return child;
}

// spawn returns a child that prints `output` to stdout and then exits cleanly,
// emitting `close` after `exit` (the normal CLI flow — `close` carries the full
// output, so the probe settles immediately without the post-exit grace).
function setSpawnSuccess(output: string): void {
  spawnMock.mockImplementation((() => {
    const child = makeFakeChild();
    // Emit after the probe has attached its listeners (the Promise executor
    // runs synchronously during `new Promise`, so a microtask suffices).
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(output));
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    return child;
  }) as never);
}

// spawn returns a child that fails with the given error (e.g. ENOENT/EACCES).
function setSpawnError(error: NodeJS.ErrnoException): void {
  spawnMock.mockImplementation((() => {
    const child = makeFakeChild();
    queueMicrotask(() => child.emit("error", error));
    return child;
  }) as never);
}

describe("AgentVersionService resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createService(checkAvailabilityImpl: () => Promise<Record<string, unknown>>) {
    const cliAvailabilityService = {
      checkAvailability: vi.fn(checkAvailabilityImpl),
    } as unknown as CliAvailabilityService;

    return {
      service: new AgentVersionService(cliAvailabilityService),
      cliAvailabilityService,
    };
  }

  it("returns error info instead of throwing when availability check fails", async () => {
    (registryMock.getEffectiveAgentConfig as Mock).mockReturnValue({
      id: "claude",
      name: "Claude",
      command: "claude",
      version: {
        args: ["--version"],
      },
    });

    const { service } = createService(async () => {
      throw new Error("availability crash");
    });

    await expect(service.getVersion("claude" as AgentId)).resolves.toEqual(
      expect.objectContaining({
        agentId: "claude",
        installedVersion: null,
        latestVersion: null,
        updateAvailable: false,
        error: expect.stringContaining("availability crash"),
      })
    );
  });

  it("uses a 10s probe timeout to tolerate cold starts and AV-scanned binaries", () => {
    const cliAvailabilityService = {
      checkAvailability: vi.fn(),
    } as unknown as CliAvailabilityService;
    const service = new AgentVersionService(cliAvailabilityService);

    // The constant gates the spawn-probe wall-clock deadline AND the two
    // AbortController-based fetch paths in getLatestNpmVersion /
    // getLatestGitHubVersion. 5s was too tight on Windows AV-scanned PATH
    // entries, slow npm CDN edges, and WSL2 boundaries (issue #6041).
    expect((service as unknown as { TIMEOUT_MS: number }).TIMEOUT_MS).toBe(10000);
  });

  // Regression: a never-settling installed-version probe stranded the assistant
  // launch FSM on "Checking version…" forever. The old `execFile` resolved on
  // `close` (all stdio EOF), so a daemon grandchild inheriting the stdout fd
  // kept the promise pending and the 10s `timeout` was ineffective (it signals
  // the already-exited foreground PID, never the grandchild). The probe now
  // resolves on `exit` and hard-reaps the tree on a deadline.
  describe("installed-version probe hang resistance", () => {
    beforeEach(() => {
      spawnMock.mockReset();
    });

    it("settles via the post-exit grace timer when `close` never fires (grandchild holds the pipe)", async () => {
      (registryMock.getEffectiveAgentConfig as Mock).mockReturnValue({
        id: "claude",
        name: "Claude",
        command: "claude",
        version: { args: ["--version"] },
      });

      // Foreground prints its version and exits, but a grandchild holds the
      // stdout pipe open so `close` never fires — only `exit` does. The probe
      // must still settle (via the short post-exit grace), never hang on `close`.
      spawnMock.mockImplementation((() => {
        const child = makeFakeChild();
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from("1.2.3\n"));
          child.emit("exit", 0, null);
          // Deliberately never emit `close` — the inherited pipe never EOFs.
        });
        return child;
      }) as never);

      vi.useFakeTimers();
      try {
        const { service } = createService(async () => ({ claude: "ready" }));
        const pending = service.getVersion("claude" as AgentId);
        // Advance past the grace window (EXIT_DRAIN_MS) but nowhere near the
        // 10s hard deadline — proving we settle off `exit`+grace, not the deadline.
        await vi.advanceTimersByTimeAsync(300);
        const result = await pending;
        expect(result.installedVersion).toBe("1.2.3");
      } finally {
        vi.useRealTimers();
      }
    });

    it("captures stdout delivered after `exit` but before `close` (no lost version)", async () => {
      (registryMock.getEffectiveAgentConfig as Mock).mockReturnValue({
        id: "claude",
        name: "Claude",
        command: "claude",
        version: { args: ["--version"] },
      });

      // Node does not guarantee all stdout is delivered by `exit` — `data` can
      // arrive between `exit` and `close`. Settling on `close` (not `exit`) must
      // still capture the version line.
      spawnMock.mockImplementation((() => {
        const child = makeFakeChild();
        queueMicrotask(() => {
          child.emit("exit", 0, null);
          child.stdout.emit("data", Buffer.from("9.9.9\n"));
          child.emit("close", 0, null);
        });
        return child;
      }) as never);

      const { service } = createService(async () => ({ claude: "ready" }));
      const result = await service.getVersion("claude" as AgentId);
      expect(result.installedVersion).toBe("9.9.9");
    });

    it("reaps the process tree and resolves with captured output past the deadline", async () => {
      (registryMock.getEffectiveAgentConfig as Mock).mockReturnValue({
        id: "claude",
        name: "Claude",
        command: "claude",
        version: { args: ["--version"] },
      });

      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
      let spawnedChild: ReturnType<typeof makeFakeChild> | null = null;
      // A genuinely hung foreground: prints its version but never exits.
      spawnMock.mockImplementation((() => {
        const child = makeFakeChild();
        spawnedChild = child;
        queueMicrotask(() => child.stdout.emit("data", Buffer.from("4.5.6\n")));
        return child;
      }) as never);

      vi.useFakeTimers();
      try {
        const { service } = createService(async () => ({ claude: "ready" }));
        const pending = service.getVersion("claude" as AgentId);
        await vi.advanceTimersByTimeAsync(10000);
        const result = await pending;

        // The deadline force-resolves with what the CLI already printed rather
        // than leaving the launch FSM stuck on "Checking version…".
        expect(result.installedVersion).toBe("4.5.6");
        // The hung tree is reaped: POSIX SIGKILLs the whole process group
        // (negative pid) so a grandchild holding the pipe dies too; Windows has
        // no group here and falls back to killing the child directly.
        if (process.platform === "win32") {
          expect(spawnedChild!.kill).toHaveBeenCalledWith("SIGKILL");
        } else {
          expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
        }
      } finally {
        vi.useRealTimers();
        killSpy.mockRestore();
      }
    });
  });

  it("returns per-agent results even when one config lookup throws", async () => {
    (registryMock.getEffectiveAgentIds as Mock).mockReturnValue(["claude", "gemini"]);
    (registryMock.getEffectiveAgentConfig as Mock).mockImplementation((agentId: string) => {
      if (agentId === "gemini") {
        throw new Error("bad config payload");
      }

      return {
        id: "claude",
        name: "Claude",
        command: "claude",
      };
    });

    const { service } = createService(async () => ({
      claude: false,
      gemini: false,
    }));

    const results = await service.getVersions();

    expect(results).toHaveLength(2);
    expect(results).toContainEqual(
      expect.objectContaining({
        agentId: "claude",
        updateAvailable: false,
      })
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        agentId: "gemini",
        installedVersion: null,
        latestVersion: null,
        updateAvailable: false,
        error: expect.stringContaining("bad config payload"),
      })
    );
  });

  describe("env sandboxing and secret scrubbing (issue #6247)", () => {
    const originalEnv = process.env;

    afterEach(() => {
      process.env = originalEnv;
    });

    it("passes a sandboxed env to spawn (excludes ANTHROPIC_API_KEY, GITHUB_TOKEN)", async () => {
      process.env = {
        ...originalEnv,
        ANTHROPIC_API_KEY: "sk-ant-x",
        GITHUB_TOKEN: "ghp_x",
        PATH: process.env.PATH ?? "/usr/bin",
      } as NodeJS.ProcessEnv;

      (registryMock.getEffectiveAgentConfig as Mock).mockReturnValue({
        id: "claude",
        name: "Claude",
        command: "claude",
        version: { args: ["--version"] },
      });

      setSpawnSuccess("1.0.0\n");

      const { service } = createService(async () => ({ claude: "ready" }));
      await service.getVersion("claude" as AgentId);

      const opts = spawnMock.mock.calls[0][2] as { env?: Record<string, string> };
      expect(opts.env).toBeDefined();
      expect(opts.env!.ANTHROPIC_API_KEY).toBeUndefined();
      expect(opts.env!.GITHUB_TOKEN).toBeUndefined();
      expect(opts.env!.PATH).toBeTruthy();
    });

    it("scrubs secrets from error.message before they flow into AgentVersionInfo.error", async () => {
      const leakingMessage = `spawn failed for ANTHROPIC_API_KEY=sk-ant-${"A".repeat(95)}`;

      (registryMock.getEffectiveAgentConfig as Mock).mockReturnValue({
        id: "claude",
        name: "Claude",
        command: "claude",
        version: { args: ["--version"] },
      });

      const err = new Error(leakingMessage) as NodeJS.ErrnoException;
      err.code = "EUNKNOWN";
      setSpawnError(err);

      const { service } = createService(async () => ({ claude: "ready" }));
      const result = await service.getVersion("claude" as AgentId);

      expect(result.error ?? "").not.toContain("sk-ant-");
      expect(result.error ?? "").toContain("[REDACTED]");
    });
  });

  describe("PyPI version feed", () => {
    // execFile is used for the installed-version probe; default to a synthetic
    // success so getInstalledVersion returns a parseable value and the
    // assertion focuses on the latest-version branch.
    function setExecFileSuccess(): void {
      setSpawnSuccess("1.0.0\n");
    }

    beforeEach(() => {
      spawnMock.mockReset();
    });

    it("fetches the latest version from pypi.org/pypi/<pkg>/json", async () => {
      (registryMock.getEffectiveAgentConfig as Mock).mockReturnValue({
        id: "py-agent",
        name: "Py Agent",
        command: "py-agent",
        version: { args: ["--version"], pypiPackage: "py-agent-pkg" },
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ info: { version: "1.2.3" } }),
        headers: new Headers(),
      } as Response);
      setExecFileSuccess();

      const { service } = createService(async () => ({ "py-agent": "ready" }));
      const result = await service.getVersion("py-agent" as AgentId);

      expect(result.latestVersion).toBe("1.2.3");
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://pypi.org/pypi/py-agent-pkg/json",
        expect.objectContaining({
          headers: expect.objectContaining({ "User-Agent": "Daintree-Electron" }),
        })
      );
      fetchSpy.mockRestore();
    });

    it("returns null without erroring when PyPI returns 200 with missing version", async () => {
      (registryMock.getEffectiveAgentConfig as Mock).mockReturnValue({
        id: "py-agent",
        name: "Py Agent",
        command: "py-agent",
        version: { args: ["--version"], pypiPackage: "py-agent-pkg" },
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ info: {} }),
        headers: new Headers(),
      } as Response);
      setExecFileSuccess();

      const { service } = createService(async () => ({ "py-agent": "ready" }));
      const result = await service.getVersion("py-agent" as AgentId);

      expect(result.latestVersion).toBeNull();
      expect(result.error).toBeUndefined();
      fetchSpy.mockRestore();
    });

    it("surfaces an error when PyPI returns 404", async () => {
      (registryMock.getEffectiveAgentConfig as Mock).mockReturnValue({
        id: "py-agent",
        name: "Py Agent",
        command: "py-agent",
        version: { args: ["--version"], pypiPackage: "missing-pkg" },
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({}),
        headers: new Headers(),
      } as Response);
      setExecFileSuccess();

      const { service } = createService(async () => ({ "py-agent": "ready" }));
      const result = await service.getVersion("py-agent" as AgentId);

      expect(result.latestVersion).toBeNull();
      expect(result.error ?? "").toMatch(/PyPI/);
      fetchSpy.mockRestore();
    });
  });

  describe("npm version feed", () => {
    function setExecFileSuccess(): void {
      setSpawnSuccess("1.0.0\n");
    }

    beforeEach(() => {
      spawnMock.mockReset();
    });

    it("uses the abbreviated packument Accept header and User-Agent", async () => {
      (registryMock.getEffectiveAgentConfig as Mock).mockReturnValue({
        id: "npm-agent",
        name: "NPM Agent",
        command: "npm-agent",
        version: { args: ["--version"], npmPackage: "npm-agent-pkg" },
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          "dist-tags": { latest: "2.0.0" },
          name: "npm-agent-pkg",
        }),
        headers: new Headers(),
      } as Response);
      setExecFileSuccess();

      const { service } = createService(async () => ({ "npm-agent": "ready" }));
      const result = await service.getVersion("npm-agent" as AgentId);

      expect(result.latestVersion).toBe("2.0.0");
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://registry.npmjs.org/npm-agent-pkg",
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: "application/vnd.npm.install-v1+json",
            "User-Agent": "Daintree-Electron",
          }),
        })
      );
      fetchSpy.mockRestore();
    });

    it("omits the ?fields=dist-tags query parameter from the URL", async () => {
      (registryMock.getEffectiveAgentConfig as Mock).mockReturnValue({
        id: "npm-agent",
        name: "NPM Agent",
        command: "npm-agent",
        version: { args: ["--version"], npmPackage: "scoped-pkg" },
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          "dist-tags": { latest: "1.5.0" },
        }),
        headers: new Headers(),
      } as Response);
      setExecFileSuccess();

      const { service } = createService(async () => ({ "npm-agent": "ready" }));
      await service.getVersion("npm-agent" as AgentId);

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).not.toContain("?fields=");
      expect(url).toBe("https://registry.npmjs.org/scoped-pkg");
      fetchSpy.mockRestore();
    });
  });

  describe("parseVersion prerelease coercion", () => {
    it("preserves prerelease tags when coerce fallback is reached", () => {
      const { service } = createService(async () => ({}));

      // "2.0-beta" has no X.Y.Z pattern so it bypasses semver.clean() and
      // all three regex patterns, reaching the coerce fallback.
      expect(
        (service as unknown as { parseVersion(v: string): string | null }).parseVersion("2.0-beta")
      ).toBe("2.0.0-beta");
    });

    it("still returns null for unparseable strings", () => {
      const { service } = createService(async () => ({}));

      expect(
        (service as unknown as { parseVersion(v: string): string | null }).parseVersion(
          "not a version at all"
        )
      ).toBeNull();
    });
  });

  describe("isUpdateAvailable prerelease guard", () => {
    it("returns false when installed is stable and latest is a prerelease", () => {
      const { service } = createService(async () => ({}));

      expect(
        (
          service as unknown as { isUpdateAvailable(i: string | null, l: string | null): boolean }
        ).isUpdateAvailable("1.9.5", "2.0.0-beta.1")
      ).toBe(false);
    });

    it("returns true when both installed and latest are prereleases in the same channel", () => {
      const { service } = createService(async () => ({}));

      expect(
        (
          service as unknown as { isUpdateAvailable(i: string | null, l: string | null): boolean }
        ).isUpdateAvailable("2.0.0-beta.1", "2.0.0-beta.2")
      ).toBe(true);
    });

    it("returns true when installed is a prerelease and latest is stable", () => {
      const { service } = createService(async () => ({}));

      expect(
        (
          service as unknown as { isUpdateAvailable(i: string | null, l: string | null): boolean }
        ).isUpdateAvailable("2.0.0-beta.1", "2.0.0")
      ).toBe(true);
    });

    it("returns true for a normal stable-to-stable upgrade", () => {
      const { service } = createService(async () => ({}));

      expect(
        (
          service as unknown as { isUpdateAvailable(i: string | null, l: string | null): boolean }
        ).isUpdateAvailable("1.0.0", "2.0.0")
      ).toBe(true);
    });

    it("returns false for a normal stable-to-stable downgrade", () => {
      const { service } = createService(async () => ({}));

      expect(
        (
          service as unknown as { isUpdateAvailable(i: string | null, l: string | null): boolean }
        ).isUpdateAvailable("2.0.0", "1.0.0")
      ).toBe(false);
    });
  });

  describe("checkVersion parallelism", () => {
    function setExecFileSuccess(): void {
      setSpawnSuccess("1.9.5\n");
    }

    beforeEach(() => {
      spawnMock.mockReset();
    });

    it("returns both installed and latest when both probes succeed", async () => {
      (registryMock.getEffectiveAgentConfig as Mock).mockReturnValue({
        id: "claude",
        name: "Claude",
        command: "claude",
        version: { args: ["--version"], npmPackage: "claude-pkg" },
      });

      setExecFileSuccess();

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ "dist-tags": { latest: "2.0.0" } }),
        headers: new Headers(),
      } as Response);

      const { service } = createService(async () => ({ claude: "ready" }));
      const result = await service.getVersion("claude" as AgentId);

      expect(result.installedVersion).toBe("1.9.5");
      expect(result.latestVersion).toBe("2.0.0");
      expect(result.error).toBeUndefined();
      fetchSpy.mockRestore();
    });

    it("returns installed version and error when latest probe fails", async () => {
      (registryMock.getEffectiveAgentConfig as Mock).mockReturnValue({
        id: "claude",
        name: "Claude",
        command: "claude",
        version: { args: ["--version"], npmPackage: "claude-pkg" },
      });

      setExecFileSuccess();

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error("network down"));

      const { service } = createService(async () => ({ claude: "ready" }));
      const result = await service.getVersion("claude" as AgentId);

      expect(result.installedVersion).toBe("1.9.5");
      expect(result.latestVersion).toBeNull();
      expect(result.error).toContain("Failed to get latest version");
      expect(result.error).toContain("network down");
      fetchSpy.mockRestore();
    });

    it("returns latest version and error when installed probe fails", async () => {
      (registryMock.getEffectiveAgentConfig as Mock).mockReturnValue({
        id: "claude",
        name: "Claude",
        command: "claude",
        version: { args: ["--version"], npmPackage: "claude-pkg" },
      });

      const eaccesError = new Error("EACCES") as NodeJS.ErrnoException;
      eaccesError.code = "EACCES";
      setSpawnError(eaccesError);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ "dist-tags": { latest: "2.0.0" } }),
        headers: new Headers(),
      } as Response);

      const { service } = createService(async () => ({ claude: "ready" }));
      const result = await service.getVersion("claude" as AgentId);

      expect(result.installedVersion).toBeNull();
      expect(result.latestVersion).toBe("2.0.0");
      expect(result.error).toContain("Failed to get installed version");
      fetchSpy.mockRestore();
    });

    it("joins both error messages when both probes fail", async () => {
      (registryMock.getEffectiveAgentConfig as Mock).mockReturnValue({
        id: "claude",
        name: "Claude",
        command: "claude",
        version: { args: ["--version"], npmPackage: "claude-pkg" },
      });

      const etimedoutError = new Error("ETIMEDOUT") as NodeJS.ErrnoException;
      etimedoutError.code = "ETIMEDOUT";
      setSpawnError(etimedoutError);

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error("connect timeout"));

      const { service } = createService(async () => ({ claude: "ready" }));
      const result = await service.getVersion("claude" as AgentId);

      expect(result.installedVersion).toBeNull();
      expect(result.latestVersion).toBeNull();
      expect(result.error).toContain("Failed to get installed version");
      expect(result.error).toContain("Failed to get latest version");
      expect(result.error).toContain(";");
      fetchSpy.mockRestore();
    });
  });
});
