import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUserRegistry } from "../../../shared/config/agentRegistry.js";
import { AgentUpdateHandler } from "../AgentUpdateHandler.js";

type Listener = (...args: unknown[]) => void;

function createPtyClientMock() {
  const listeners = new Map<string, Set<Listener>>();

  const on = vi.fn((event: string, handler: Listener) => {
    const handlers = listeners.get(event) ?? new Set<Listener>();
    handlers.add(handler);
    listeners.set(event, handlers);
  });

  const off = vi.fn((event: string, handler: Listener) => {
    listeners.get(event)?.delete(handler);
  });

  const emit = (event: string, ...args: unknown[]) => {
    for (const handler of [...(listeners.get(event) ?? [])]) {
      handler(...args);
    }
  };

  return {
    emit,
    ptyClient: {
      spawn: vi.fn(),
      submit: vi.fn(),
      on,
      off,
    },
  };
}

describe("AgentUpdateHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setUserRegistry({
      "test-agent": {
        id: "test-agent",
        name: "Test Agent",
        command: "test-agent",
        color: "#000000",
        iconId: "terminal",
        supportsContextInjection: false,
        update: {
          npm: "npm install -g test-agent@latest",
          brew: "brew upgrade test-agent",
          other: {
            script: "./scripts/update-test-agent.sh",
            npm: "./scripts/custom-npm-update.sh",
          },
        },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    setUserRegistry({});
  });

  it("rejects explicitly requested unsupported update methods", async () => {
    const { ptyClient } = createPtyClientMock();
    const versionService = { clearCache: vi.fn() };
    const cliAvailabilityService = { refresh: vi.fn() };

    const handler = new AgentUpdateHandler(
      ptyClient as never,
      versionService as never,
      cliAvailabilityService as never
    );

    await expect(
      handler.startUpdate({
        agentId: "test-agent" as never,
        method: "nonexistent",
      })
    ).rejects.toThrow("No update command available for test-agent with method: nonexistent");

    expect(ptyClient.spawn).not.toHaveBeenCalled();
  });

  it("cancels delayed submit when terminal exits before command dispatch", async () => {
    const { ptyClient, emit } = createPtyClientMock();
    const versionService = { clearCache: vi.fn() };
    const cliAvailabilityService = { refresh: vi.fn() };

    const handler = new AgentUpdateHandler(
      ptyClient as never,
      versionService as never,
      cliAvailabilityService as never
    );

    const result = await handler.startUpdate({
      agentId: "test-agent" as never,
      method: "npm",
    });

    emit(`exit:${result.terminalId}`);
    vi.advanceTimersByTime(1000);

    expect(ptyClient.submit).not.toHaveBeenCalled();
    expect(versionService.clearCache).toHaveBeenCalledWith("test-agent");
    expect(cliAvailabilityService.refresh).toHaveBeenCalledTimes(1);
  });

  it("returns de-duplicated update methods", () => {
    const { ptyClient } = createPtyClientMock();
    const versionService = { clearCache: vi.fn() };
    const cliAvailabilityService = { refresh: vi.fn() };

    const handler = new AgentUpdateHandler(
      ptyClient as never,
      versionService as never,
      cliAvailabilityService as never
    );

    expect(handler.getAvailableUpdateMethods("test-agent" as never)).toEqual([
      "npm",
      "brew",
      "script",
    ]);
  });

  it("does not crash when command submission throws", async () => {
    const { ptyClient } = createPtyClientMock();
    const versionService = { clearCache: vi.fn() };
    const cliAvailabilityService = { refresh: vi.fn() };

    ptyClient.submit.mockImplementation(() => {
      throw new Error("submit failed");
    });

    const handler = new AgentUpdateHandler(
      ptyClient as never,
      versionService as never,
      cliAvailabilityService as never
    );

    await handler.startUpdate({
      agentId: "test-agent" as never,
      method: "npm",
    });

    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(versionService.clearCache).toHaveBeenCalledWith("test-agent");
    expect(cliAvailabilityService.refresh).toHaveBeenCalledTimes(1);
  });

  it("accepts update methods with surrounding whitespace", async () => {
    const { ptyClient } = createPtyClientMock();
    const versionService = { clearCache: vi.fn() };
    const cliAvailabilityService = { refresh: vi.fn() };

    const handler = new AgentUpdateHandler(
      ptyClient as never,
      versionService as never,
      cliAvailabilityService as never
    );

    const result = await handler.startUpdate({
      agentId: "test-agent" as never,
      method: " npm " as never,
    });

    expect(result.command).toBe("npm install -g test-agent@latest");
  });

  it("rejects empty update method values", async () => {
    const { ptyClient } = createPtyClientMock();
    const versionService = { clearCache: vi.fn() };
    const cliAvailabilityService = { refresh: vi.fn() };

    const handler = new AgentUpdateHandler(
      ptyClient as never,
      versionService as never,
      cliAvailabilityService as never
    );

    await expect(
      handler.startUpdate({
        agentId: "test-agent" as never,
        method: "   " as never,
      })
    ).rejects.toThrow("Invalid update method");

    expect(ptyClient.spawn).not.toHaveBeenCalled();
  });
});
