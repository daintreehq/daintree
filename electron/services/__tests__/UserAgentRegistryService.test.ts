import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { UserAgentConfig } from "../../../shared/types/userAgentRegistry.js";

const storeMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

const setUserRegistryMock = vi.hoisted(() => vi.fn());
const isBuiltInAgentMock = vi.hoisted(() => vi.fn((id: string) => id === "claude"));

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

vi.mock("../../../shared/config/agentRegistry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shared/config/agentRegistry.js")>();
  return {
    ...actual,
    setUserRegistry: setUserRegistryMock,
    isBuiltInAgent: isBuiltInAgentMock,
  };
});

import { UserAgentRegistryService } from "../UserAgentRegistryService.js";

function createConfig(id: string, overrides: Partial<UserAgentConfig> = {}): UserAgentConfig {
  return {
    id,
    name: `Agent ${id}`,
    command: "custom-agent",
    color: "#112233",
    iconId: "terminal",
    supportsContextInjection: true,
    ...overrides,
  };
}

describe("UserAgentRegistryService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (storeMock.get as Mock).mockReturnValue({});
    (storeMock.set as Mock).mockImplementation(() => {});
  });

  it("drops reserved and mismatched registry keys during load", () => {
    const storedRegistry: Record<string, UserAgentConfig> = {
      valid: createConfig("valid"),
      mismatch: createConfig("different-id"),
      claude: createConfig("claude"),
      __proto__: createConfig("proto-agent"),
    };

    (storeMock.get as Mock).mockReturnValue(storedRegistry);

    const service = new UserAgentRegistryService();

    expect(service.getRegistry()).toEqual({
      valid: expect.objectContaining({ id: "valid" }),
    });
    expect(setUserRegistryMock).toHaveBeenCalledWith({
      valid: expect.objectContaining({ id: "valid" }),
    });
  });

  it("returns cloned agent configs so external mutation cannot alter internal state", () => {
    (storeMock.get as Mock).mockReturnValue({
      alpha: createConfig("alpha"),
    });

    const service = new UserAgentRegistryService();

    const firstRead = service.getAgent("alpha");
    expect(firstRead).toBeDefined();

    firstRead!.name = "Mutated";

    const secondRead = service.getAgent("alpha");
    expect(secondRead?.name).toBe("Agent alpha");
  });

  it("returns cloned registry entries so callers cannot mutate internal state", () => {
    (storeMock.get as Mock).mockReturnValue({
      alpha: createConfig("alpha"),
    });

    const service = new UserAgentRegistryService();

    const registry = service.getRegistry();
    registry.alpha.name = "Mutated via registry";

    expect(service.getAgent("alpha")?.name).toBe("Agent alpha");
  });

  it("does not treat prototype properties as real agents during removal", () => {
    const service = new UserAgentRegistryService();

    const result = service.removeAgent("toString");

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("rejects agent IDs with unsafe characters", () => {
    const service = new UserAgentRegistryService();

    const result = service.addAgent(
      createConfig("bad id", {
        id: "bad id",
      })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Agent ID");
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("drops stored agents with invalid IDs during load", () => {
    (storeMock.get as Mock).mockReturnValue({
      "valid-id": createConfig("valid-id"),
      "invalid id": createConfig("invalid id"),
    });

    const service = new UserAgentRegistryService();

    expect(service.getRegistry()).toEqual({
      "valid-id": expect.objectContaining({ id: "valid-id" }),
    });
  });
});
