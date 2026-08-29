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

    const result = await handler({ senderFrame: { url: "http://localhost:5173" } }, "project-1");

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

    const result = (await handler(
      { senderFrame: { url: "http://localhost:5173" } },
      "project-1"
    )) as any[];

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

  it("excludes help-marked terminals from getForProject results", async () => {
    mockIsHelpTerminal.mockImplementation((id: string) => id === "t-help");

    const ptyClient = {
      getTerminalsForProjectAsync: vi.fn(async () => ["t-visible", "t-help", "t-dev-preview"]),
      getTerminalAsync: vi.fn(async (id: string) => ({
        id,
        kind: id === "t-dev-preview" ? "dev-preview" : "agent",
        type: "terminal",
        cwd: "/tmp",
        spawnedAt: Date.now(),
      })),
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

    const result = await handler({ senderFrame: { url: "http://localhost:5173" } }, "project-1");

    expect(result).toHaveLength(1);
    expect((result[0] as { id: string }).id).toBe("t-visible");

    mockIsHelpTerminal.mockImplementation(() => false);
  });

  it("forwards the live PTY grid so restore can build the xterm on it (#11718)", async () => {
    // Main is a pure relay here, and dropping these two fields is invisible:
    // the pty-host mapper still reports them and hydration still prefers them,
    // so every other suite stays green while the fix goes inert and restored
    // panes silently fall back to 80×24.
    const ptyClient = {
      getTerminalsForProjectAsync: vi.fn(async () => ["t-sized", "t-unknown"]),
      getTerminalAsync: vi.fn(async (id: string) => ({
        id,
        kind: "terminal",
        type: "terminal",
        cwd: "/tmp",
        spawnedAt: Date.now(),
        ...(id === "t-sized" ? { ptyCols: 203, ptyRows: 51 } : {}),
      })),
    };

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalSnapshotHandlers(deps);

    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const handler = calls.find(
      (c) => c[0] === CHANNELS.TERMINAL_GET_FOR_PROJECT
    )?.[1] as unknown as (
      event: unknown,
      projectId: string
    ) => Promise<{ id: string; ptyCols?: number; ptyRows?: number }[]>;

    const result = await handler({ senderFrame: { url: "http://localhost:5173" } }, "project-1");

    const sized = result.find((t) => t.id === "t-sized");
    expect(sized?.ptyCols).toBe(203);
    expect(sized?.ptyRows).toBe(51);
    // A host that reports no grid must stay "unknown" rather than acquire one.
    const unknown = result.find((t) => t.id === "t-unknown");
    expect(unknown?.ptyCols).toBeUndefined();
  });

  it("strips backend worktree attribution, which is renderer-owned (#5176)", async () => {
    // Hydration's primary path. The pty-host mapper only began reporting
    // worktreeId in #12078, so this projection had never seen a populated
    // value — a refactor to a spread would now let the backend win a placement
    // decision that belongs to the renderer's saved layout state alone.
    const ptyClient = {
      getTerminalsForProjectAsync: vi.fn(async () => ["t-worktreed"]),
      getTerminalAsync: vi.fn(async (id: string) => ({
        id,
        kind: "terminal",
        type: "terminal",
        cwd: "/repo/.worktrees/backend",
        spawnedAt: Date.now(),
        worktreeId: "/repo/.worktrees/backend",
      })),
    };

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalSnapshotHandlers(deps);

    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const handler = calls.find(
      (c) => c[0] === CHANNELS.TERMINAL_GET_FOR_PROJECT
    )?.[1] as unknown as (event: unknown, projectId: string) => Promise<unknown[]>;

    const result = await handler({ senderFrame: { url: "http://localhost:5173" } }, "project-1");

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty("worktreeId");
  });
});
