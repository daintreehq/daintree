import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AgentId } from "../../../shared/types/agent.js";

const registryMock = vi.hoisted(() => ({
  getEffectiveAgentIds: vi.fn(),
  getEffectiveAgentConfig: vi.fn(),
}));

vi.mock("../../../shared/config/agentRegistry.js", () => registryMock);

import { AgentVersionService } from "../AgentVersionService.js";
import type { CliAvailabilityService } from "../CliAvailabilityService.js";

describe("AgentVersionService resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createService(checkAvailabilityImpl: () => Promise<Record<string, boolean>>) {
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

  describe("PyPI version feed", () => {
    // execFile is used for the installed-version probe; default to a synthetic
    // success so getInstalledVersion returns a parseable value and the
    // assertion focuses on the latest-version branch.
    function mockExecFileVersion(): ReturnType<typeof vi.spyOn> {
      const cp = require("child_process") as { execFile: typeof import("child_process").execFile };
      return vi.spyOn(cp, "execFile").mockImplementation(((
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (err: unknown, stdout: string, stderr: string) => void
      ) => {
        cb(null, "1.0.0\n", "");
      }) as never);
    }

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
      const execSpy = mockExecFileVersion();

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
      execSpy.mockRestore();
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
      const execSpy = mockExecFileVersion();

      const { service } = createService(async () => ({ "py-agent": "ready" }));
      const result = await service.getVersion("py-agent" as AgentId);

      expect(result.latestVersion).toBeNull();
      expect(result.error ?? "").toMatch(/PyPI/);
      fetchSpy.mockRestore();
      execSpy.mockRestore();
    });
  });
});
