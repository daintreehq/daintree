import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUserRegistry } from "../../../shared/config/agentRegistry.js";
import { AgentUpdateHandler } from "../AgentUpdateHandler.js";

const refreshWindowsPathForSpawnMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

// Full export surface: a factory that omits one throws for every consumer of the
// module at collection while vitest still exits 0.
vi.mock("../../setup/windowsPath.js", () => ({
  refreshWindowsPathForSpawn: refreshWindowsPathForSpawnMock,
  resolveWindowsRegistryPath: vi.fn().mockResolvedValue(null),
  applyWindowsExtraPaths: vi.fn((p: string) => p),
  expandWindowsEnvVars: vi.fn((s: string) => s),
  deduplicatePath: vi.fn((p: string) => p),
  __resetWindowsPathStateForTests: vi.fn(),
}));

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
          script: "./scripts/update-test-agent.sh",
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

  it("does not register a data listener during startUpdate", async () => {
    const { ptyClient } = createPtyClientMock();
    const versionService = { clearCache: vi.fn() };
    const cliAvailabilityService = { refresh: vi.fn() };

    const handler = new AgentUpdateHandler(
      ptyClient as never,
      versionService as never,
      cliAvailabilityService as never
    );

    await handler.startUpdate({
      agentId: "test-agent" as never,
      method: "npm",
    });

    const dataListenerCalls = ptyClient.on.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].startsWith("data:")
    );
    expect(dataListenerCalls).toHaveLength(0);

    // Exit handler is still registered.
    const exitListenerCalls = ptyClient.on.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].startsWith("exit:")
    );
    expect(exitListenerCalls).toHaveLength(1);
  });

  it("selects brew before cargo when npm is absent (explicit priority list)", () => {
    const { ptyClient } = createPtyClientMock();
    const versionService = { clearCache: vi.fn() };
    const cliAvailabilityService = { refresh: vi.fn() };

    setUserRegistry({
      "cargo-agent": {
        id: "cargo-agent",
        name: "Cargo Agent",
        command: "cargo-agent",
        color: "#000000",
        iconId: "terminal",
        supportsContextInjection: false,
        update: {
          cargo: "cargo install cargo-agent",
          brew: "brew upgrade cargo-agent",
        },
      },
    });

    const handler = new AgentUpdateHandler(
      ptyClient as never,
      versionService as never,
      cliAvailabilityService as never
    );

    // brew (index 1 in priority) beats cargo (index 7)
    expect(handler.getAvailableUpdateMethods("cargo-agent" as never)).toEqual(["cargo", "brew"]);
  });

  it("auto-selects brew over cargo via explicit priority when no method is given", async () => {
    const { ptyClient } = createPtyClientMock();
    const versionService = { clearCache: vi.fn() };
    const cliAvailabilityService = { refresh: vi.fn() };

    setUserRegistry({
      "cargo-agent": {
        id: "cargo-agent",
        name: "Cargo Agent",
        command: "cargo-agent",
        color: "#000000",
        iconId: "terminal",
        supportsContextInjection: false,
        update: {
          cargo: "cargo install cargo-agent",
          brew: "brew upgrade cargo-agent",
        },
      },
    });

    const handler = new AgentUpdateHandler(
      ptyClient as never,
      versionService as never,
      cliAvailabilityService as never
    );

    const result = await handler.startUpdate({
      agentId: "cargo-agent" as never,
    });

    // brew has higher priority than cargo, so it wins auto-selection.
    expect(result.command).toBe("brew upgrade cargo-agent");
  });
});

describe("AgentUpdateHandler Windows PATH refresh", () => {
  const realPlatform = process.platform;
  const setPlatform = (platform: NodeJS.Platform) => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    refreshWindowsPathForSpawnMock.mockClear();
    refreshWindowsPathForSpawnMock.mockResolvedValue(undefined);
    setUserRegistry({
      "test-agent": {
        id: "test-agent",
        name: "Test Agent",
        command: "test-agent",
        color: "#000000",
        iconId: "terminal",
        supportsContextInjection: false,
        update: { npm: "npm install -g test-agent@latest" },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    setUserRegistry({});
    setPlatform(realPlatform);
  });

  function createHandler() {
    const { ptyClient } = createPtyClientMock();
    const handler = new AgentUpdateHandler(
      ptyClient as never,
      { clearCache: vi.fn() } as never,
      { refresh: vi.fn() } as never
    );
    return { handler, ptyClient };
  }

  it("refreshes the registry PATH before spawning the update terminal", async () => {
    setPlatform("win32");
    const { handler, ptyClient } = createHandler();

    await handler.startUpdate({ agentId: "test-agent" as never });

    // The user typically installs the runtime, then asks Daintree to update a
    // CLI through it — the update command needs the PATH that install created.
    expect(refreshWindowsPathForSpawnMock).toHaveBeenCalledTimes(1);
    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
  });

  it("spawns anyway when the refresh fails", async () => {
    setPlatform("win32");
    refreshWindowsPathForSpawnMock.mockRejectedValue(new Error("reg query exploded"));
    const { handler, ptyClient } = createHandler();

    await expect(handler.startUpdate({ agentId: "test-agent" as never })).resolves.toBeTruthy();
    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
  });
});
