import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

const mockIsHelpTerminal = vi.fn((_id: string) => false);

vi.mock("../../../../services/AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => ({
    isHelpTerminal: mockIsHelpTerminal,
  }),
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../../channels.js";
import { registerTerminalSnapshotHandlers } from "../snapshots.js";
import type { HandlerDependencies } from "../../../types.js";

type ReconnectBulkHandler = (
  event: unknown,
  terminalIds: string[]
) => Promise<Record<string, { exists: boolean; id?: string; hasPty?: boolean }>>;

function makeTerminal(id: string) {
  return {
    id,
    projectId: "project-1",
    kind: "terminal",
    cwd: "/tmp",
    spawnedAt: 1,
    hasPty: true,
  };
}

describe("terminal:reconnect-bulk handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsHelpTerminal.mockReturnValue(false);
  });

  function getHandler(): ReconnectBulkHandler {
    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const handlerCall = calls.find((call) => call[0] === CHANNELS.TERMINAL_RECONNECT_BULK);
    expect(handlerCall).toBeTruthy();
    return handlerCall?.[1] as ReconnectBulkHandler;
  }

  it("returns a per-id map matching the single reconnect contract", async () => {
    const ptyClient = {
      getTerminalAsync: vi.fn(async (id: string) => (id === "t-live" ? makeTerminal(id) : null)),
    };

    registerTerminalSnapshotHandlers({ ptyClient } as unknown as HandlerDependencies);
    const handler = getHandler();

    const result = await handler({}, ["t-live", "t-dead"]);

    expect(result["t-live"]).toMatchObject({ exists: true, id: "t-live", hasPty: true });
    expect(result["t-dead"]).toEqual({ exists: false });
  });

  it("deduplicates ids before probing", async () => {
    const ptyClient = {
      getTerminalAsync: vi.fn(async (id: string) => makeTerminal(id)),
    };

    registerTerminalSnapshotHandlers({ ptyClient } as unknown as HandlerDependencies);
    const handler = getHandler();

    const result = await handler({}, ["t-1", "t-1", "t-2"]);

    expect(Object.keys(result).sort()).toEqual(["t-1", "t-2"]);
    expect(ptyClient.getTerminalAsync).toHaveBeenCalledTimes(2);
  });

  it("degrades a failing id to { exists: false } without failing the batch", async () => {
    const ptyClient = {
      getTerminalAsync: vi.fn(async (id: string) => {
        if (id === "t-fail") throw new Error("boom");
        return makeTerminal(id);
      }),
    };

    registerTerminalSnapshotHandlers({ ptyClient } as unknown as HandlerDependencies);
    const handler = getHandler();

    const result = await handler({}, ["t-ok", "t-fail"]);

    expect(result["t-ok"]).toMatchObject({ exists: true });
    expect(result["t-fail"]).toEqual({ exists: false });
  });

  it("reports help terminals as { exists: false }, mirroring single reconnect", async () => {
    mockIsHelpTerminal.mockImplementation((id: string) => id === "t-help");
    const ptyClient = {
      getTerminalAsync: vi.fn(async (id: string) => makeTerminal(id)),
    };

    registerTerminalSnapshotHandlers({ ptyClient } as unknown as HandlerDependencies);
    const handler = getHandler();

    const result = await handler({}, ["t-help", "t-normal"]);

    expect(result["t-help"]).toEqual({ exists: false });
    expect(result["t-normal"]).toMatchObject({ exists: true });
  });

  it("rejects invalid payloads", async () => {
    const ptyClient = {
      getTerminalAsync: vi.fn(async () => null),
    };

    registerTerminalSnapshotHandlers({ ptyClient } as unknown as HandlerDependencies);
    const handler = getHandler();

    await expect(handler({}, null as unknown as string[])).rejects.toThrow(
      "Invalid terminal IDs: must be an array"
    );
    await expect(handler({}, ["" as unknown as string])).rejects.toThrow(
      "Invalid terminal ID in batch payload"
    );
    await expect(handler({}, new Array(257).fill("id"))).rejects.toThrow(
      "Invalid terminal IDs: maximum 256 IDs allowed"
    );
  });

  it("returns an empty map for an empty id list", async () => {
    const ptyClient = {
      getTerminalAsync: vi.fn(async () => null),
    };

    registerTerminalSnapshotHandlers({ ptyClient } as unknown as HandlerDependencies);
    const handler = getHandler();

    await expect(handler({}, [])).resolves.toEqual({});
    expect(ptyClient.getTerminalAsync).not.toHaveBeenCalled();
  });
});
