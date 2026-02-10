import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AgentId } from "../../../shared/types/domain.js";

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
});
