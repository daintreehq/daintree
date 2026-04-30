import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AgentId } from "../../../shared/types/agent.js";

const registryMock = vi.hoisted(() => ({
  getEffectiveAgentIds: vi.fn(),
  getEffectiveAgentConfig: vi.fn(),
}));

// Hoisted execFile mock — vi.spyOn can't redefine ESM-namespace exports of
// `child_process`, so we substitute the whole module at hoist time. Tests
// that need a custom impl mutate `execFileMock` via mockImplementationOnce.
const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("../../../shared/config/agentRegistry.js", () => registryMock);

import { AgentVersionService } from "../AgentVersionService.js";
import type { CliAvailabilityService } from "../CliAvailabilityService.js";

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

    // The constant gates execFileAsync timeout AND the two AbortController-based
    // fetch paths in getLatestNpmVersion / getLatestGitHubVersion. 5s was too
    // tight on Windows AV-scanned PATH entries, slow npm CDN edges, and WSL2
    // boundaries (issue #6041).
    expect((service as unknown as { TIMEOUT_MS: number }).TIMEOUT_MS).toBe(10000);
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

    function setExecFileImpl(
      impl: (cmd: string, args: string[], opts: unknown, cb: (...cbArgs: unknown[]) => void) => void
    ): void {
      execFileMock.mockImplementation(impl as never);
    }

    it("passes a sandboxed env to execFile (excludes ANTHROPIC_API_KEY, GITHUB_TOKEN)", async () => {
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

      setExecFileImpl(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (err: unknown, stdout: string, stderr: string) => void
        ) => {
          cb(null, "1.0.0\n", "");
        }
      );

      const { service } = createService(async () => ({ claude: "ready" }));
      await service.getVersion("claude" as AgentId);

      const opts = execFileMock.mock.calls[0][2] as { env?: Record<string, string> };
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

      setExecFileImpl(
        (_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown) => void) => {
          const err = new Error(leakingMessage) as NodeJS.ErrnoException & {
            stdout?: string;
            stderr?: string;
          };
          err.code = "EUNKNOWN";
          err.stdout = "";
          err.stderr = "";
          cb(err);
        }
      );

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
      execFileMock.mockImplementation(((
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (err: unknown, stdout: string, stderr: string) => void
      ) => {
        cb(null, "1.0.0\n", "");
      }) as never);
    }

    beforeEach(() => {
      execFileMock.mockReset();
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
});
