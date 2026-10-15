import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { AgentState } from "../../../../shared/types/agent.js";
import { ProjectAgentActivityCache } from "../ProjectAgentActivityCache.js";

type Inventory = {
  terminals: Array<{ id: string; projectId?: string; agentState?: AgentState }>;
  degraded: boolean;
};

/** PtyClient's spawn registry, inventory and exit/crash events, with inventories answered by hand. */
class FakePty extends EventEmitter {
  readonly owners = new Map<string, string>();
  readonly pending: Array<(inventory: Inventory) => void> = [];
  getTerminalProjectId(id: string): string | null {
    return this.owners.get(id) ?? null;
  }
  getAllTerminalsWithCompletenessAsync(): Promise<Inventory> {
    return new Promise((resolve) => this.pending.push(resolve));
  }
  answer(inventory: Inventory) {
    this.pending.shift()!(inventory);
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function setup() {
  const onChange = vi.fn();
  const cache = new ProjectAgentActivityCache(onChange);
  const pty = new FakePty();
  return { cache, pty, onChange };
}

describe("ProjectAgentActivityCache (#13359)", () => {
  it("counts working, waiting and directing agents for their own project only", () => {
    const { cache, pty, onChange } = setup();
    cache.attach(pty);
    pty.owners.set("t1", "p1");
    pty.owners.set("t2", "p2");

    for (const state of ["working", "waiting", "directing"] as const) {
      cache.noteState("t1", state);
      expect(cache.isProjectActive("p1")).toBe(true);
    }
    expect(cache.isProjectActive("p2")).toBe(false);

    cache.noteState("t1", "idle");
    cache.noteState("t2", "completed");
    expect(cache.isProjectActive("p1")).toBe(false);
    expect(cache.isProjectActive("p2")).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(5);
  });

  it("forgets a terminal that exits", () => {
    const { cache, pty, onChange } = setup();
    cache.attach(pty);
    pty.owners.set("t1", "p1");
    cache.noteState("t1", "working");
    onChange.mockClear();

    pty.emit("exit", "t1");
    expect(cache.isProjectActive("p1")).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("counts agents already running when it attaches, owned by the inventory's project", async () => {
    const { cache, pty, onChange } = setup();
    cache.attach(pty);
    pty.answer({
      terminals: [
        { id: "t1", projectId: "p1", agentState: "working" },
        { id: "t2", projectId: "p2", agentState: "idle" },
      ],
      degraded: false,
    });
    await flush();
    expect(cache.isProjectActive("p1")).toBe(true);
    expect(cache.isProjectActive("p2")).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps what an event said over an inventory taken before it", async () => {
    const { cache, pty } = setup();
    cache.attach(pty);
    pty.owners.set("t1", "p1");
    cache.noteState("t1", "idle");
    pty.emit("host-crash");
    cache.noteState("t1", "working");

    pty.answer({ terminals: [{ id: "t1", projectId: "p1", agentState: "idle" }], degraded: false });
    await flush();
    // The crash reseed was queued behind the attach seed.
    pty.answer({ terminals: [{ id: "t1", projectId: "p1", agentState: "idle" }], degraded: false });
    await flush();
    expect(cache.isProjectActive("p1")).toBe(false);

    cache.noteState("t1", "working");
    pty.emit("host-crash");
    cache.noteState("t1", "waiting");
    pty.answer({ terminals: [], degraded: false });
    await flush();
    expect(cache.isProjectActive("p1")).toBe(true);
  });

  it("drops terminals a complete inventory no longer has, but not on an incomplete one", async () => {
    const { cache, pty } = setup();
    cache.attach(pty);
    pty.answer({
      terminals: [{ id: "t1", projectId: "p1", agentState: "working" }],
      degraded: false,
    });
    await flush();

    pty.emit("host-crash");
    pty.answer({ terminals: [], degraded: true });
    await flush();
    expect(cache.isProjectActive("p1")).toBe(true);

    pty.emit("host-crash");
    pty.answer({ terminals: [], degraded: false });
    await flush();
    expect(cache.isProjectActive("p1")).toBe(false);
  });

  it("stops listening and ignores a late inventory once disposed", async () => {
    const { cache, pty, onChange } = setup();
    cache.attach(pty);
    cache.dispose();
    pty.answer({
      terminals: [{ id: "t1", projectId: "p1", agentState: "working" }],
      degraded: false,
    });
    await flush();
    cache.noteState("t1", "working");

    expect(cache.isProjectActive("p1")).toBe(false);
    expect(pty.listenerCount("exit")).toBe(0);
    expect(pty.listenerCount("host-crash")).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });
});
