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

describe("terminal:get-for-project handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("excludes dev-preview PTYs from getForProject results", async () => {
    const ptyClient = {
      getTerminalsForProjectAsync: vi.fn(async () => ["t-visible", "t-dev-preview"]),
      getTerminalAsync: vi.fn(async (id: string) => {
        if (id === "t-visible") {
          return {
            id,
            kind: "terminal",
            type: "terminal",
            cwd: "/tmp",
            spawnedAt: Date.now(),
          };
        }
        if (id === "t-dev-preview") {
          return {
            id,
            kind: "dev-preview",
            type: "terminal",
            cwd: "/tmp",
            spawnedAt: Date.now(),
          };
        }
        return null;
      }),
    };

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalSnapshotHandlers(deps);

    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const getForProjectCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_FOR_PROJECT);
    expect(getForProjectCall).toBeTruthy();

    const handler = getForProjectCall?.[1] as unknown as (
      event: unknown,
      projectId: string
    ) => Promise<unknown[]>;

    const result = await handler({}, "project-1");

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect((result[0] as { id: string }).id).toBe("t-visible");
    expect(ptyClient.getTerminalsForProjectAsync).toHaveBeenCalledWith("project-1");
    expect(ptyClient.getTerminalAsync).toHaveBeenCalledTimes(2);
  });

  it("passes through trash metadata when present", async () => {
    const now = Date.now();
    const expiresAt = now + 120000;

    const ptyClient = {
      getTerminalsForProjectAsync: vi.fn(async () => ["t-active", "t-will-expire"]),
      getTerminalAsync: vi.fn(async (id: string) => {
        if (id === "t-active") {
          return {
            id,
            kind: "terminal",
            type: "terminal",
            cwd: "/tmp",
            spawnedAt: now,
            isTrashed: false,
          };
        }
        if (id === "t-will-expire") {
          return {
            id,
            kind: "terminal",
            type: "terminal",
            cwd: "/tmp",
            spawnedAt: now,
            isTrashed: false,
            trashExpiresAt: expiresAt,
          };
        }
        return null;
      }),
    };

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalSnapshotHandlers(deps);

    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const getForProjectCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_FOR_PROJECT);
    expect(getForProjectCall).toBeTruthy();

    const handler = getForProjectCall?.[1] as unknown as (
      event: unknown,
      projectId: string
    ) => Promise<unknown[]>;

    const result = await handler({}, "project-1");

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);

    const active = result.find((t: { id: string }) => t.id === "t-active") as {
      id: string;
      isTrashed?: boolean;
      trashExpiresAt?: number;
    };
    const willExpire = result.find((t: { id: string }) => t.id === "t-will-expire") as {
      id: string;
      isTrashed?: boolean;
      trashExpiresAt?: number;
    };

    expect(active.isTrashed).toBe(false);
    expect(active.trashExpiresAt).toBeUndefined();

    expect(willExpire.isTrashed).toBe(false);
    expect(willExpire.trashExpiresAt).toBe(expiresAt);
  });
});
