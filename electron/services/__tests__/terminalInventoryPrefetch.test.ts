import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => ({ isHelpTerminal: (id: string) => id === "help-1" }),
}));
vi.mock("../../utils/logger.js", () => ({ logInfo: vi.fn() }));

import {
  _resetTerminalInventoryPrefetchForTests,
  buildTerminalInventory,
  consumeTerminalInventoryPrefetch,
  invalidateTerminalInventoryPrefetch,
  prefetchTerminalInventory,
} from "../terminalInventoryPrefetch.js";

function terminal(id: string, kind = "terminal", extra: Record<string, unknown> = {}) {
  return { id, projectId: "p1", kind, title: id, hasPty: true, ...extra } as never;
}

describe("buildTerminalInventory", () => {
  it("lists the project's terminals and drops dev-preview and help PTYs", async () => {
    const ptyClient = {
      getTerminalsForProjectAsync: vi.fn(async () => ["t1", "dp", "help-1", "gone"]),
      getTerminalAsync: vi.fn(async (id: string) =>
        id === "gone" ? null : terminal(id, id === "dp" ? "dev-preview" : "terminal")
      ),
    };
    const inventory = await buildTerminalInventory(ptyClient, "p1");
    expect(inventory.map((t) => t.id)).toEqual(["t1"]);
    expect(ptyClient.getTerminalAsync).toHaveBeenCalledTimes(4);
  });

  it("drops an assistant PTY the renderer has not marked yet", async () => {
    // #12183: the availability-store mark arrives on a fire-and-forget renderer
    // round trip that lands AFTER the spawn IPC returned, so between "PTY
    // exists" and "help.markTerminal processed" this inventory used to report
    // the assistant — and `restorePanelsPhase` appends anything here with no
    // saved panel as a grid orphan. The spawn-time record stamp closes that
    // window, since it is on the record before the PTY is reachable at all.
    const ptyClient = {
      getTerminalsForProjectAsync: vi.fn(async () => ["t1", "assistant"]),
      getTerminalAsync: vi.fn(async (id: string) =>
        terminal(id, "terminal", id === "assistant" ? { isAssistantTerminal: true } : {})
      ),
    };
    const inventory = await buildTerminalInventory(ptyClient, "p1");
    expect(inventory.map((t) => t.id)).toEqual(["t1"]);
  });
});

describe("prefetchTerminalInventory", () => {
  beforeEach(() => {
    _resetTerminalInventoryPrefetchForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one in-flight fetch and hands it out exactly once", async () => {
    const build = vi.fn(async () => [terminal("t1")]);
    const first = prefetchTerminalInventory("p1", build);
    const second = prefetchTerminalInventory("p1", build);
    expect(second).toBe(first);
    expect(build).toHaveBeenCalledTimes(1);

    expect(consumeTerminalInventoryPrefetch("p1")).toBe(first);
    expect(consumeTerminalInventoryPrefetch("p1")).toBeNull();
    await expect(first).resolves.toHaveLength(1);
  });

  it("does not serve an inventory older than its TTL", () => {
    prefetchTerminalInventory("p1", async () => []);
    vi.advanceTimersByTime(6_000);
    expect(consumeTerminalInventoryPrefetch("p1")).toBeNull();
  });

  it("drops a rejected prefetch so the handler fetches live", async () => {
    const failed = prefetchTerminalInventory("p1", async () => {
      throw new Error("pty-host down");
    });
    await expect(failed).rejects.toThrow("pty-host down");
    await Promise.resolve();
    expect(consumeTerminalInventoryPrefetch("p1")).toBeNull();
  });

  it("invalidates per project and globally", () => {
    prefetchTerminalInventory("p1", async () => []);
    prefetchTerminalInventory("p2", async () => []);
    invalidateTerminalInventoryPrefetch("p1");
    expect(consumeTerminalInventoryPrefetch("p1")).toBeNull();
    expect(consumeTerminalInventoryPrefetch("p2")).not.toBeNull();
    prefetchTerminalInventory("p3", async () => []);
    invalidateTerminalInventoryPrefetch();
    expect(consumeTerminalInventoryPrefetch("p3")).toBeNull();
  });
});
