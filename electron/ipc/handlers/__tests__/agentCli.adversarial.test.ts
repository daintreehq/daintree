import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const getAgentIdsMock = vi.hoisted(() => vi.fn(() => ["claude", "codex"]));
const sendToRendererMock = vi.hoisted(() => vi.fn());
const getWindowForWebContentsMock = vi.hoisted(() => vi.fn());
const runAgentInstallMock = vi.hoisted(() => vi.fn());
const storeMock = vi.hoisted(() => ({
  get: vi.fn<(key: string, fallback?: unknown) => unknown>(),
  set: vi.fn(),
}));
const runSystemHealthCheckMock = vi.hoisted(() => vi.fn());
const getHealthCheckSpecsMock = vi.hoisted(() => vi.fn());
const checkPrerequisiteMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

vi.mock("../../../../shared/config/agentRegistry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../shared/config/agentRegistry.js")>();
  return { ...actual, getAgentIds: getAgentIdsMock };
});

vi.mock("../../utils.js", () => ({
  sendToRenderer: sendToRendererMock,
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleWithContext: (channel: string, handler: unknown) => {
    ipcMainMock.handle(
      channel,
      (event: { sender?: { id?: number } } | null | undefined, ...args: unknown[]) => {
        const ctx = {
          event: event as unknown,
          webContentsId: event?.sender?.id ?? 0,
          senderWindow: getWindowForWebContentsMock(event?.sender),
          projectId: null,
        };
        return (handler as (...a: unknown[]) => unknown)(ctx, ...args);
      }
    );
    return () => ipcMainMock.removeHandler(channel);
  },
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: getWindowForWebContentsMock,
}));
vi.mock("../../../services/AgentInstallService.js", () => ({
  runAgentInstall: runAgentInstallMock,
}));
vi.mock("../../../store.js", () => ({ store: storeMock }));
vi.mock("../../../services/SystemHealthCheck.js", () => ({
  runSystemHealthCheck: runSystemHealthCheckMock,
  getHealthCheckSpecs: getHealthCheckSpecsMock,
  checkPrerequisite: checkPrerequisiteMock,
}));

import { registerAgentCliHandlers } from "../agentCli.js";
import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies } from "../../types.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const fn = ipcHandlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn as Handler;
}

function fakeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} as Electron.WebContents } as Electron.IpcMainInvokeEvent;
}

describe("agentCli IPC adversarial", () => {
  let cleanup: () => void;

  function register(overrides: Partial<HandlerDependencies> = {}) {
    ipcHandlers.clear();
    const deps = {
      cliAvailabilityService: {
        getAvailability: vi.fn().mockReturnValue(null),
        checkAvailability: vi.fn().mockResolvedValue({}),
        refresh: vi.fn().mockResolvedValue({}),
      },
      agentVersionService: { getVersions: vi.fn().mockResolvedValue([]) },
      agentUpdateHandler: { startUpdate: vi.fn().mockResolvedValue({ jobId: "u1" }) },
      ...overrides,
    } as unknown as HandlerDependencies;
    cleanup = registerAgentCliHandlers(deps);
    return deps;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.get.mockImplementation((_key, fallback) => fallback);
  });

  afterEach(() => {
    cleanup?.();
  });

  it("SYSTEM_GET_CLI_AVAILABILITY returns all agent ids as missing when the service is absent", async () => {
    register({ cliAvailabilityService: undefined });

    const result = await getHandler(CHANNELS.SYSTEM_GET_CLI_AVAILABILITY)(fakeEvent());
    expect(result).toEqual({ claude: "missing", codex: "missing" });
  });

  it("SYSTEM_GET_CLI_AVAILABILITY returns cached availability without calling checkAvailability", async () => {
    const cached = { claude: "available" };
    const checkAvailability = vi.fn();
    register({
      cliAvailabilityService: {
        getAvailability: vi.fn().mockReturnValue(cached),
        checkAvailability,
        refresh: vi.fn(),
      } as unknown as HandlerDependencies["cliAvailabilityService"],
    });

    const result = await getHandler(CHANNELS.SYSTEM_GET_CLI_AVAILABILITY)(fakeEvent());

    expect(result).toEqual(cached);
    expect(checkAvailability).not.toHaveBeenCalled();
  });

  it("SYSTEM_GET_AGENT_CLI_DETAILS returns {} when the service is absent", async () => {
    register({ cliAvailabilityService: undefined });

    const result = await getHandler(CHANNELS.SYSTEM_GET_AGENT_CLI_DETAILS)(fakeEvent());
    expect(result).toEqual({});
  });

  it("SYSTEM_GET_AGENT_CLI_DETAILS returns cached details without re-probing", async () => {
    const cached = {
      claude: {
        state: "ready" as const,
        resolvedPath: "/usr/local/bin/claude",
        via: "which" as const,
      },
    };
    const checkAvailability = vi.fn();
    register({
      cliAvailabilityService: {
        getAvailability: vi.fn().mockReturnValue({ claude: "ready" }),
        getDetails: vi.fn().mockReturnValue(cached),
        checkAvailability,
        refresh: vi.fn(),
      } as unknown as HandlerDependencies["cliAvailabilityService"],
    });

    const result = await getHandler(CHANNELS.SYSTEM_GET_AGENT_CLI_DETAILS)(fakeEvent());

    expect(result).toEqual(cached);
    expect(checkAvailability).not.toHaveBeenCalled();
  });

  it("SYSTEM_GET_AGENT_CLI_DETAILS lazy-loads via checkAvailability when no cache exists", async () => {
    // First call to getDetails returns null (cold), second call (post-check)
    // returns populated details — mirrors the real service's populate-on-
    // check semantics.
    const details = {
      claude: {
        state: "installed" as const,
        resolvedPath: "/home/user/.local/bin/claude",
        via: "native" as const,
      },
    };
    const getDetails = vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(details);
    const checkAvailability = vi.fn().mockResolvedValue({ claude: "installed" });
    register({
      cliAvailabilityService: {
        getAvailability: vi.fn().mockReturnValue(null),
        getDetails,
        checkAvailability,
        refresh: vi.fn(),
      } as unknown as HandlerDependencies["cliAvailabilityService"],
    });

    const result = await getHandler(CHANNELS.SYSTEM_GET_AGENT_CLI_DETAILS)(fakeEvent());

    expect(checkAvailability).toHaveBeenCalledOnce();
    expect(result).toEqual(details);
  });

  it("SYSTEM_SET_AGENT_UPDATE_SETTINGS rejects invalid settings before persistence", async () => {
    register();
    const handler = getHandler(CHANNELS.SYSTEM_SET_AGENT_UPDATE_SETTINGS);

    await expect(
      handler(fakeEvent(), { autoCheck: true, checkFrequencyHours: 0, lastAutoCheck: null })
    ).rejects.toThrow(/Invalid AgentUpdateSettings/);

    await expect(
      handler(fakeEvent(), {
        autoCheck: true,
        checkFrequencyHours: Infinity,
        lastAutoCheck: null,
      })
    ).rejects.toThrow(/Invalid AgentUpdateSettings/);

    await expect(
      handler(fakeEvent(), {
        autoCheck: "yes",
        checkFrequencyHours: 24,
        lastAutoCheck: null,
      })
    ).rejects.toThrow(/Invalid AgentUpdateSettings/);

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("SYSTEM_SET_AGENT_UPDATE_SETTINGS persists valid settings exactly", async () => {
    register();
    const settings = { autoCheck: true, checkFrequencyHours: 24, lastAutoCheck: 1234 };

    await getHandler(CHANNELS.SYSTEM_SET_AGENT_UPDATE_SETTINGS)(fakeEvent(), settings);

    expect(storeMock.set).toHaveBeenCalledWith("agentUpdateSettings", settings);
  });

  it("SYSTEM_START_AGENT_UPDATE rejects malformed payloads before calling the handler", async () => {
    const startUpdate = vi.fn();
    register({
      agentUpdateHandler: { startUpdate } as unknown as HandlerDependencies["agentUpdateHandler"],
    });

    const handler = getHandler(CHANNELS.SYSTEM_START_AGENT_UPDATE);

    await expect(handler(fakeEvent(), null)).rejects.toThrow(/Invalid StartAgentUpdatePayload/);
    await expect(handler(fakeEvent(), { agentId: "" })).rejects.toThrow(
      /Invalid StartAgentUpdatePayload/
    );
    await expect(handler(fakeEvent(), { agentId: "claude", method: 123 })).rejects.toThrow(
      /Invalid StartAgentUpdatePayload/
    );

    expect(startUpdate).not.toHaveBeenCalled();
  });

  it("SYSTEM_START_AGENT_UPDATE rejects when the handler is absent", async () => {
    register({ agentUpdateHandler: undefined });
    await expect(
      getHandler(CHANNELS.SYSTEM_START_AGENT_UPDATE)(fakeEvent(), { agentId: "claude" })
    ).rejects.toThrow(/AgentUpdateHandler not available/);
  });

  it("SETUP_AGENT_INSTALL forwards progress to sender window only", async () => {
    const senderWindow = { id: 9 } as unknown as Electron.BrowserWindow;
    getWindowForWebContentsMock.mockReturnValue(senderWindow);
    runAgentInstallMock.mockImplementation(
      async (
        _payload: unknown,
        onProgress: (event: { jobId: string; chunk: string; stream: string }) => void
      ) => {
        onProgress({ jobId: "j1", chunk: "one", stream: "stdout" });
        onProgress({ jobId: "j1", chunk: "two", stream: "stderr" });
        return { success: true, exitCode: 0 };
      }
    );

    register();
    const result = await getHandler(CHANNELS.SETUP_AGENT_INSTALL)(fakeEvent(), {
      agentId: "claude",
      jobId: "j1",
    });

    expect(result).toEqual({ success: true, exitCode: 0 });
    expect(sendToRendererMock).toHaveBeenCalledTimes(2);
    expect(sendToRendererMock.mock.calls.map((c) => c[0])).toEqual([senderWindow, senderWindow]);
  });

  it("SETUP_AGENT_INSTALL succeeds silently when no sender window is available", async () => {
    getWindowForWebContentsMock.mockReturnValue(null);
    runAgentInstallMock.mockImplementation(
      async (
        _payload: unknown,
        onProgress: (event: { jobId: string; chunk: string; stream: string }) => void
      ) => {
        onProgress({ jobId: "j1", chunk: "orphan", stream: "stdout" });
        return { success: true, exitCode: 0 };
      }
    );

    register();
    const result = await getHandler(CHANNELS.SETUP_AGENT_INSTALL)(fakeEvent(), {
      agentId: "claude",
      jobId: "j1",
    });

    expect(result).toMatchObject({ success: true });
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it("SETUP_AGENT_INSTALL rejects malformed payloads", async () => {
    register();
    const handler = getHandler(CHANNELS.SETUP_AGENT_INSTALL);

    await expect(handler(fakeEvent(), null)).rejects.toThrow(/Invalid AgentInstallPayload/);
    await expect(handler(fakeEvent(), { agentId: "claude" })).rejects.toThrow(
      /Invalid AgentInstallPayload/
    );
    await expect(handler(fakeEvent(), { agentId: 123, jobId: "j" })).rejects.toThrow(
      /Invalid AgentInstallPayload/
    );
    expect(runAgentInstallMock).not.toHaveBeenCalled();
  });

  it("SYSTEM_CHECK_TOOL is asynchronous via setImmediate and still returns the prerequisite result", async () => {
    checkPrerequisiteMock.mockReturnValue({ ok: true });
    register();

    const spec = { id: "node" };
    const result = await getHandler(CHANNELS.SYSTEM_CHECK_TOOL)(fakeEvent(), spec);

    expect(result).toEqual({ ok: true });
    expect(checkPrerequisiteMock).toHaveBeenCalledWith(spec);
  });

  it("cleanup removes all registered handlers", async () => {
    register();
    const countBefore = ipcHandlers.size;
    expect(countBefore).toBeGreaterThan(0);

    cleanup();
    expect(ipcHandlers.size).toBe(0);
  });
});
