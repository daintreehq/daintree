import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../../channels.js";
import { registerTerminalSnapshotHandlers } from "../snapshots.js";
import type { HandlerDependencies } from "../../../types.js";
import type { SerializedTerminalSnapshot } from "../../../../../shared/types/terminal.js";

function snapshot(data: string): SerializedTerminalSnapshot {
  return { data, cols: 80, rows: 24 };
}

describe("terminal:get-serialized-states handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function getHandler(): (
    event: unknown,
    terminalIds: string[]
  ) => Promise<Record<string, SerializedTerminalSnapshot | null>> {
    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const handlerCall = calls.find((call) => call[0] === CHANNELS.TERMINAL_GET_SERIALIZED_STATES);
    expect(handlerCall).toBeTruthy();
    return handlerCall?.[1] as (
      event: unknown,
      terminalIds: string[]
    ) => Promise<Record<string, SerializedTerminalSnapshot | null>>;
  }

  it("returns serialized state map for unique terminal IDs", async () => {
    const ptyClient = {
      getSerializedStateAsync: vi.fn(async (terminalId: string) => {
        if (terminalId === "t-1") return snapshot("state-1");
        if (terminalId === "t-2") return null;
        return snapshot("unknown");
      }),
    };

    registerTerminalSnapshotHandlers({ ptyClient } as unknown as HandlerDependencies);
    const handler = getHandler();

    const result = await handler({}, ["t-1", "t-1", "t-2"]);

    // The batch must forward the capture grid per entry, not just the payload:
    // it is what each replay sizes itself to (#11552).
    expect(result).toEqual({
      "t-1": snapshot("state-1"),
      "t-2": null,
    });
    expect(ptyClient.getSerializedStateAsync).toHaveBeenCalledTimes(2);
  });

  it("returns null for terminals that fail to serialize without failing whole batch", async () => {
    const ptyClient = {
      getSerializedStateAsync: vi.fn(async (terminalId: string) => {
        if (terminalId === "t-fail") {
          throw new Error("boom");
        }
        return snapshot("ok");
      }),
    };

    registerTerminalSnapshotHandlers({ ptyClient } as unknown as HandlerDependencies);
    const handler = getHandler();

    const result = await handler({}, ["t-ok", "t-fail"]);

    expect(result).toEqual({
      "t-ok": snapshot("ok"),
      "t-fail": null,
    });
  });

  it("rejects invalid payloads", async () => {
    const ptyClient = {
      getSerializedStateAsync: vi.fn(async () => snapshot("state")),
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
});
