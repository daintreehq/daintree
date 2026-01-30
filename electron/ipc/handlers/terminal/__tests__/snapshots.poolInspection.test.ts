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

describe("terminal pool inspection handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("terminal:get-available handler", () => {
    it("returns only idle and waiting terminals", async () => {
      const ptyClient = {
        getAvailableTerminalsAsync: vi.fn(async () => [
          {
            id: "t-idle",
            kind: "agent",
            type: "claude",
            cwd: "/tmp",
            agentState: "idle",
            spawnedAt: Date.now(),
          },
          {
            id: "t-waiting",
            kind: "agent",
            type: "claude",
            cwd: "/tmp",
            agentState: "waiting",
            spawnedAt: Date.now(),
          },
        ]),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getAvailableCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_AVAILABLE);
      expect(getAvailableCall).toBeTruthy();

      const handler = getAvailableCall?.[1] as unknown as () => Promise<unknown[]>;

      const result = await handler();

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect((result[0] as { agentState: string }).agentState).toBe("idle");
      expect((result[1] as { agentState: string }).agentState).toBe("waiting");
    });

    it("returns empty array when no terminals are available", async () => {
      const ptyClient = {
        getAvailableTerminalsAsync: vi.fn(async () => []),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getAvailableCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_AVAILABLE);
      const handler = getAvailableCall?.[1] as unknown as () => Promise<unknown[]>;

      const result = await handler();

      expect(result).toEqual([]);
      expect(Array.isArray(result)).toBe(true);
    });

    it("throws error when ptyClient fails", async () => {
      const ptyClient = {
        getAvailableTerminalsAsync: vi.fn(async () => {
          throw new Error("PTY client error");
        }),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getAvailableCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_AVAILABLE);
      const handler = getAvailableCall?.[1] as unknown as () => Promise<unknown[]>;

      await expect(handler()).rejects.toThrow(
        "Failed to get available terminals: PTY client error"
      );
    });

    it("excludes dev-preview PTYs from available results", async () => {
      const ptyClient = {
        getAvailableTerminalsAsync: vi.fn(async () => [
          {
            id: "t-idle",
            kind: "agent",
            type: "claude",
            cwd: "/tmp",
            agentState: "idle",
            spawnedAt: Date.now(),
          },
          {
            id: "t-dev-preview",
            kind: "dev-preview",
            type: "terminal",
            cwd: "/tmp",
            agentState: "idle",
            spawnedAt: Date.now(),
          },
        ]),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getAvailableCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_AVAILABLE);
      const handler = getAvailableCall?.[1] as unknown as () => Promise<unknown[]>;

      const result = await handler();

      expect(result).toHaveLength(1);
      expect((result[0] as { id: string }).id).toBe("t-idle");
    });
  });

  describe("terminal:get-by-state handler", () => {
    it("returns terminals filtered by state", async () => {
      const ptyClient = {
        getTerminalsByStateAsync: vi.fn(async () => [
          {
            id: "t-working-1",
            kind: "agent",
            type: "claude",
            cwd: "/tmp",
            agentState: "working",
            spawnedAt: Date.now(),
          },
          {
            id: "t-working-2",
            kind: "agent",
            type: "codex",
            cwd: "/tmp",
            agentState: "working",
            spawnedAt: Date.now(),
          },
        ]),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getByStateCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_BY_STATE);
      expect(getByStateCall).toBeTruthy();

      const handler = getByStateCall?.[1] as unknown as (
        event: unknown,
        state: string
      ) => Promise<unknown[]>;

      const result = await handler({}, "working");

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(ptyClient.getTerminalsByStateAsync).toHaveBeenCalledWith("working");
    });

    it("excludes dev-preview PTYs from state results", async () => {
      const ptyClient = {
        getTerminalsByStateAsync: vi.fn(async () => [
          {
            id: "t-working",
            kind: "agent",
            type: "claude",
            cwd: "/tmp",
            agentState: "working",
            spawnedAt: Date.now(),
          },
          {
            id: "t-dev-preview",
            kind: "dev-preview",
            type: "terminal",
            cwd: "/tmp",
            agentState: "working",
            spawnedAt: Date.now(),
          },
        ]),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getByStateCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_BY_STATE);
      const handler = getByStateCall?.[1] as unknown as (
        event: unknown,
        state: string
      ) => Promise<unknown[]>;

      const result = await handler({}, "working");

      expect(result).toHaveLength(1);
      expect((result[0] as { id: string }).id).toBe("t-working");
    });

    it("throws error for empty state parameter", async () => {
      const ptyClient = {
        getTerminalsByStateAsync: vi.fn(async () => []),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getByStateCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_BY_STATE);
      const handler = getByStateCall?.[1] as unknown as (
        event: unknown,
        state: string
      ) => Promise<unknown[]>;

      await expect(handler({}, "")).rejects.toThrow("Invalid state");
      expect(ptyClient.getTerminalsByStateAsync).not.toHaveBeenCalled();
    });

    it("throws error for invalid state value", async () => {
      const ptyClient = {
        getTerminalsByStateAsync: vi.fn(async () => []),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getByStateCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_BY_STATE);
      const handler = getByStateCall?.[1] as unknown as (
        event: unknown,
        state: string
      ) => Promise<unknown[]>;

      await expect(handler({}, "invalid")).rejects.toThrow(
        "Invalid state: must be one of idle, working, waiting, completed, failed"
      );
      expect(ptyClient.getTerminalsByStateAsync).not.toHaveBeenCalled();
    });

    it("returns empty array when no terminals match state", async () => {
      const ptyClient = {
        getTerminalsByStateAsync: vi.fn(async () => []),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getByStateCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_BY_STATE);
      const handler = getByStateCall?.[1] as unknown as (
        event: unknown,
        state: string
      ) => Promise<unknown[]>;

      const result = await handler({}, "working");

      expect(result).toEqual([]);
      expect(Array.isArray(result)).toBe(true);
    });

    it("includes all metadata fields for returned terminals", async () => {
      const now = Date.now();
      const ptyClient = {
        getTerminalsByStateAsync: vi.fn(async () => [
          {
            id: "t-full",
            projectId: "proj-1",
            kind: "agent",
            type: "claude",
            agentId: "claude",
            title: "Claude Agent",
            cwd: "/tmp",
            worktreeId: "wt-1",
            agentState: "working",
            lastStateChange: now - 1000,
            spawnedAt: now,
            isTrashed: false,
            trashExpiresAt: undefined,
            activityTier: "active",
            hasPty: true,
          },
        ]),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getByStateCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_BY_STATE);
      const handler = getByStateCall?.[1] as unknown as (
        event: unknown,
        state: string
      ) => Promise<unknown[]>;

      const result = (await handler({}, "working")) as Array<{
        id: string;
        projectId?: string;
        worktreeId?: string;
        agentId?: string;
        lastStateChange?: number;
        activityTier?: string;
        hasPty?: boolean;
      }>;

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("t-full");
      expect(result[0].projectId).toBe("proj-1");
      expect(result[0].worktreeId).toBe("wt-1");
      expect(result[0].agentId).toBe("claude");
      expect(result[0].lastStateChange).toBe(now - 1000);
      expect(result[0].activityTier).toBe("active");
      expect(result[0].hasPty).toBe(true);
    });
  });

  describe("terminal:get-all handler", () => {
    it("returns all terminals", async () => {
      const ptyClient = {
        getAllTerminalsAsync: vi.fn(async () => [
          {
            id: "t-1",
            kind: "agent",
            type: "claude",
            cwd: "/tmp",
            agentState: "idle",
            spawnedAt: Date.now(),
          },
          {
            id: "t-2",
            kind: "terminal",
            type: "terminal",
            cwd: "/tmp",
            agentState: "idle",
            spawnedAt: Date.now(),
          },
          {
            id: "t-3",
            kind: "agent",
            type: "codex",
            cwd: "/tmp",
            agentState: "working",
            spawnedAt: Date.now(),
          },
        ]),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getAllCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_ALL);
      expect(getAllCall).toBeTruthy();

      const handler = getAllCall?.[1] as unknown as () => Promise<unknown[]>;

      const result = await handler();

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(3);
    });

    it("excludes dev-preview PTYs from all results", async () => {
      const ptyClient = {
        getAllTerminalsAsync: vi.fn(async () => [
          {
            id: "t-terminal",
            kind: "terminal",
            type: "terminal",
            cwd: "/tmp",
            agentState: "idle",
            spawnedAt: Date.now(),
          },
          {
            id: "t-dev-preview",
            kind: "dev-preview",
            type: "terminal",
            cwd: "/tmp",
            agentState: "idle",
            spawnedAt: Date.now(),
          },
        ]),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getAllCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_ALL);
      const handler = getAllCall?.[1] as unknown as () => Promise<unknown[]>;

      const result = await handler();

      expect(result).toHaveLength(1);
      expect((result[0] as { id: string }).id).toBe("t-terminal");
    });

    it("includes hasPty and activityTier fields", async () => {
      const ptyClient = {
        getAllTerminalsAsync: vi.fn(async () => [
          {
            id: "t-active",
            kind: "agent",
            type: "claude",
            cwd: "/tmp",
            agentState: "working",
            spawnedAt: Date.now(),
            activityTier: "active",
            hasPty: true,
          },
          {
            id: "t-background",
            kind: "agent",
            type: "codex",
            cwd: "/tmp",
            agentState: "idle",
            spawnedAt: Date.now(),
            activityTier: "background",
            hasPty: false,
          },
        ]),
      };

      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalSnapshotHandlers(deps);

      const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } })
        .mock.calls;
      const getAllCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_GET_ALL);
      const handler = getAllCall?.[1] as unknown as () => Promise<
        Array<{ activityTier?: string; hasPty?: boolean }>
      >;

      const result = await handler();

      expect(result).toHaveLength(2);
      expect(result[0].activityTier).toBe("active");
      expect(result[0].hasPty).toBe(true);
      expect(result[1].activityTier).toBe("background");
      expect(result[1].hasPty).toBe(false);
    });
  });
});
