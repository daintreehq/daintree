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
  const demand = { wanted: true };
  const cache = new ProjectAgentActivityCache(onChange, () => demand.wanted);
  const pty = new FakePty();
  return { cache, pty, onChange, demand };
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
    expect(cache.isProjectActive("p1")).toBe(true);
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

  it("learns a terminal's project from an inventory taken before its latest state", async () => {
    // Main isn't tracking this terminal's spawn, so only the inventory names its project.
    const { cache, pty, onChange } = setup();
    cache.attach(pty);
    cache.noteState("t1", "working");
    onChange.mockClear();
    pty.answer({ terminals: [{ id: "t1", projectId: "p1", agentState: "idle" }], degraded: false });
    await flush();
    expect(cache.isProjectActive("p1")).toBe(true);
    // The project now counts, so the views showing it are owed an answer.
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("never brings back a terminal that exited while the inventory was read", async () => {
    const { cache, pty, onChange } = setup();
    cache.attach(pty);
    pty.emit("exit", "t1");
    pty.answer({
      terminals: [{ id: "t1", projectId: "p1", agentState: "working" }],
      degraded: false,
    });
    await flush();
    expect(cache.isProjectActive("p1")).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("forgets the agent of a terminal the inventory still has but no longer as an agent", async () => {
    const { cache, pty } = setup();
    cache.attach(pty);
    pty.answer({
      terminals: [{ id: "t1", projectId: "p1", agentState: "working" }],
      degraded: false,
    });
    await flush();

    cache.reconcile();
    pty.answer({ terminals: [{ id: "t1", projectId: "p1" }], degraded: false });
    await flush();
    expect(cache.isProjectActive("p1")).toBe(false);
  });

  it("repairs a failed read on the next reconcile", async () => {
    const { cache, pty } = setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    pty.getAllTerminalsWithCompletenessAsync = () => Promise.reject(new Error("shard down"));
    cache.attach(pty);
    await flush();
    expect(cache.isProjectActive("p1")).toBe(false);

    pty.getAllTerminalsWithCompletenessAsync =
      FakePty.prototype.getAllTerminalsWithCompletenessAsync;
    cache.reconcile();
    pty.answer({
      terminals: [{ id: "t1", projectId: "p1", agentState: "waiting" }],
      degraded: false,
    });
    await flush();
    expect(cache.isProjectActive("p1")).toBe(true);
    error.mockRestore();
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
    cache.reconcile();
    cache.dispose();
    pty.answer({
      terminals: [{ id: "t1", projectId: "p1", agentState: "working" }],
      degraded: false,
    });
    await flush();
    expect(pty.pending).toHaveLength(0);
    cache.noteState("t1", "working");

    expect(cache.isProjectActive("p1")).toBe(false);
    expect(pty.listenerCount("exit")).toBe(0);
    expect(pty.listenerCount("host-crash")).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reads no inventory while nothing wants its answers, and follows events meanwhile", async () => {
    const { cache, pty, onChange, demand } = setup();
    demand.wanted = false;
    cache.attach(pty);
    pty.emit("host-crash");
    cache.reconcile();
    expect(pty.pending).toHaveLength(0);

    pty.owners.set("t1", "p1");
    cache.noteState("t1", "working");
    expect(cache.isProjectActive("p1")).toBe(true);
    pty.emit("exit", "t1");
    expect(cache.isProjectActive("p1")).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);

    demand.wanted = true;
    cache.reconcile();
    pty.answer({
      terminals: [{ id: "t2", projectId: "p2", agentState: "waiting" }],
      degraded: false,
    });
    await flush();
    expect(cache.isProjectActive("p2")).toBe(true);
  });

  it("takes the inventory over what events said while it read none", async () => {
    const { cache, pty, demand } = setup();
    demand.wanted = false;
    cache.attach(pty);
    pty.owners.set("t1", "p1");
    cache.noteState("t1", "working");
    pty.emit("exit", "t2");

    demand.wanted = true;
    cache.reconcile();
    pty.answer({
      terminals: [
        { id: "t1", projectId: "p1", agentState: "idle" },
        { id: "t2", projectId: "p2", agentState: "working" },
      ],
      degraded: false,
    });
    await flush();
    expect(cache.isProjectActive("p1")).toBe(false);
    // Running again under the same id since: only an exit during the read counts.
    expect(cache.isProjectActive("p2")).toBe(true);
  });

  it("queues no read asked for while nothing wanted it", async () => {
    const { cache, pty, demand } = setup();
    cache.attach(pty);
    demand.wanted = false;
    cache.reconcile();
    demand.wanted = true;
    pty.answer({ terminals: [], degraded: false });
    await flush();
    expect(pty.pending).toHaveLength(0);
  });

  it("drops a read queued behind one in flight once nothing wants it", async () => {
    const { cache, pty, demand } = setup();
    cache.attach(pty);
    cache.reconcile();
    demand.wanted = false;
    pty.answer({ terminals: [], degraded: false });
    await flush();
    expect(pty.pending).toHaveLength(0);

    demand.wanted = true;
    cache.reconcile();
    expect(pty.pending).toHaveLength(1);
  });
});
