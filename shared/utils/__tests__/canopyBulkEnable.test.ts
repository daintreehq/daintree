import { describe, expect, it, vi } from "vitest";
import type { CanopyMode, CanopySnapshot } from "../../types/ipc/canopy.js";
import {
  enableCanopyOnHosts,
  previewCanopyModes,
  type BulkTarget,
  type BulkTransport,
} from "../canopyBulkEnable.js";

function snap(
  mode: CanopyMode,
  modeRevision: number,
  hostEpoch: string | null = "e1"
): CanopySnapshot {
  return {
    mode,
    modeRevision,
    ...(hostEpoch === null ? {} : { hostEpoch }),
    activated: mode === "on",
    dispositions: [],
    seen: [],
    reads: [],
    scope: null,
    active: false,
    busy: false,
    refreshedAt: null,
    cards: [],
    glances: [],
    lastError: null,
    failedRuns: [],
  };
}

/** A host that answers like the real handler: a stale revision or epoch changes nothing. */
function fakeHost(initial: CanopySnapshot) {
  const state = { snap: initial, calls: [] as Array<[CanopyMode, number, string]>, released: 0 };
  const transport: BulkTransport = {
    getSnapshot: async () => state.snap,
    setMode: async (mode, rev, epoch) => {
      state.calls.push([mode, rev, epoch]);
      if (rev !== state.snap.modeRevision || epoch !== state.snap.hostEpoch) return state.snap;
      if (mode === "on" && state.snap.mode === "hidden")
        throw new Error("[AppError|PERMISSION] Canopy is hidden");
      state.snap = snap(
        mode,
        state.snap.modeRevision! + (mode === state.snap.mode ? 0 : 1),
        state.snap.hostEpoch ?? null
      );
      return state.snap;
    },
    release: () => {
      state.released += 1;
    },
  };
  return { state, transport };
}

const TICK_MS = 1;

const t = (hostId: string): BulkTarget => ({ hostId, name: hostId });

function run(
  hosts: Record<string, BulkTransport>,
  extra: Parameters<typeof enableCanopyOnHosts>[1] extends infer D ? Partial<D> : never = {},
  before = new Map()
) {
  return enableCanopyOnHosts(
    Object.keys(hosts).map(t),
    { transportFor: (target) => hosts[target.hostId]!, ...extra },
    before
  );
}

describe("enableCanopyOnHosts", () => {
  it("turns unset on, leaves on alone, and sequences hidden through unset", async () => {
    const unset = fakeHost(snap("unset", 0));
    const on = fakeHost(snap("on", 3));
    const hidden = fakeHost(snap("hidden", 5));
    const results = await run({ a: unset.transport, b: on.transport, c: hidden.transport });
    expect(results.map((r) => r.outcome)).toEqual(["enabled", "already-enabled", "enabled"]);
    expect(unset.state.calls).toEqual([["on", 0, "e1"]]);
    expect(on.state.calls).toEqual([]);
    expect(hidden.state.calls).toEqual([
      ["unset", 5, "e1"],
      ["on", 6, "e1"],
    ]);
    expect(hidden.state.snap.mode).toBe("on");
    for (const h of [unset, on, hidden]) expect(h.state.released).toBe(1);
  });

  it("keeps successful hosts when others are offline or too old", async () => {
    const ok = fakeHost(snap("unset", 0));
    const old = fakeHost(snap("unset", 0, null));
    const down: BulkTransport = {
      getSnapshot: async () => {
        throw new Error("offline");
      },
      setMode: vi.fn(),
      connect: async () => false,
      release: vi.fn(),
    };
    const results = await run({ ok: ok.transport, old: old.transport, down });
    expect(results.map((r) => r.outcome)).toEqual(["enabled", "unsupported", "inaccessible"]);
    expect(old.state.calls).toEqual([]);
    expect(down.setMode).not.toHaveBeenCalled();
    expect(down.release).toHaveBeenCalledTimes(1);
  });

  it("dials a disconnected host once and reads it again", async () => {
    const host = fakeHost(snap("unset", 0));
    let up = false;
    const transport: BulkTransport = {
      ...host.transport,
      getSnapshot: async () => {
        if (!up) throw new Error("HOST_DISCONNECTED");
        return host.state.snap;
      },
      connect: async () => {
        up = true;
        return true;
      },
    };
    const [result] = await run({ s: transport });
    expect(result!.outcome).toBe("enabled");
  });

  it("calls a restarted host conflicted and never writes on a stale epoch", async () => {
    const host = fakeHost(snap("unset", 0));
    const transport: BulkTransport = {
      ...host.transport,
      setMode: async (mode, rev, epoch) => {
        host.state.snap = snap("unset", 0, "e2");
        return host.transport.setMode(mode, rev, epoch);
      },
    };
    const [result] = await run({ s: transport });
    expect(result!.outcome).toBe("conflicted");
    expect(host.state.snap.mode).toBe("unset");
  });

  it("does not overwrite a newer off choice after a lost reply", async () => {
    const host = fakeHost(snap("unset", 0));
    const transport: BulkTransport = {
      ...host.transport,
      setMode: async () => {
        host.state.snap = snap("unset", 2);
        throw new Error("lost");
      },
    };
    const [result] = await run({ s: transport });
    expect(result!.outcome).toBe("conflicted");
    expect(result!.seen).toEqual({ hostEpoch: "e1", modeRevision: 2 });
  });

  it("reads a landed write after a lost reply as enabled", async () => {
    const host = fakeHost(snap("unset", 0));
    const transport: BulkTransport = {
      ...host.transport,
      setMode: async (mode, rev, epoch) => {
        await host.transport.setMode(mode, rev, epoch);
        throw new Error("lost");
      },
    };
    const [result] = await run({ s: transport });
    expect(result!.outcome).toBe("enabled");
  });

  it("calls an unconfirmed write uncertain, and retries it only from the same state", async () => {
    const host = fakeHost(snap("unset", 0));
    const lossy: BulkTransport = {
      ...host.transport,
      setMode: async () => {
        throw new Error("lost");
      },
    };
    const [first] = await run({ s: lossy });
    expect(first!.outcome).toBe("uncertain");
    expect(first!.seen).toEqual({ hostEpoch: "e1", modeRevision: 0 });
    const [again] = await run({ s: host.transport }, {}, new Map([["s", first!.seen]]));
    expect(again!.outcome).toBe("enabled");

    const moved = fakeHost(snap("unset", 4));
    const [stale] = await run({ s: moved.transport }, {}, new Map([["s", first!.seen]]));
    expect(stale!.outcome).toBe("conflicted");
    expect(moved.state.calls).toEqual([]);
  });

  it("reports a refusal and bounds concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = (): BulkTransport => ({
      getSnapshot: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, TICK_MS));
        inFlight -= 1;
        return snap("on", 1);
      },
      setMode: vi.fn(),
      release: () => {},
    });
    const hosts = Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((id) => [id, slow()]));
    await run(hosts);
    expect(peak).toBeLessThanOrEqual(3);

    const refusing: BulkTransport = {
      getSnapshot: async () => snap("unset", 0),
      setMode: async () => {
        throw new Error("[AppError|PERMISSION] Canopy is hidden");
      },
      release: () => {},
    };
    const [refused] = await run({ r: refusing });
    expect(refused!.outcome).toBe("refused");
  });

  it("stops before the next step when aborted and still releases", async () => {
    const host = fakeHost(snap("hidden", 0));
    const controller = new AbortController();
    const transport: BulkTransport = {
      ...host.transport,
      setMode: async (mode, rev, epoch) => {
        const reply = await host.transport.setMode(mode, rev, epoch);
        controller.abort();
        return reply;
      },
    };
    const [result] = await run({ s: transport }, { signal: controller.signal });
    expect(result!.outcome).toBe("uncertain");
    expect(host.state.snap.mode).toBe("unset");
    expect(host.state.released).toBe(1);
  });
});

describe("enableCanopyOnHosts, against another window's changes", () => {
  it("never carries on from a later revision that merely shares the step's mode", async () => {
    // Hidden at r0; before the run's own unset lands, another window shows,
    // enables and switches Canopy off again: unset at r3.
    const host = fakeHost(snap("hidden", 0));
    const transport: BulkTransport = {
      ...host.transport,
      setMode: async (mode, rev, epoch) => {
        host.state.calls.push([mode, rev, epoch]);
        host.state.snap = snap("unset", 3);
        return host.state.snap;
      },
    };
    const [result] = await run({ s: transport });
    expect(result!.outcome).toBe("conflicted");
    expect(host.state.calls).toEqual([["unset", 0, "e1"]]);
    expect(host.state.snap.mode).toBe("unset");
  });

  it("does the same when the reply is lost and a later revision is read back", async () => {
    const host = fakeHost(snap("hidden", 0));
    const transport: BulkTransport = {
      ...host.transport,
      setMode: async (mode, rev, epoch) => {
        host.state.calls.push([mode, rev, epoch]);
        host.state.snap = snap("unset", 3);
        throw new Error("lost");
      },
    };
    const [result] = await run({ s: transport });
    expect(result!.outcome).toBe("conflicted");
    expect(host.state.calls).toHaveLength(1);
  });

  it("stops between the hidden steps when the mode moved on", async () => {
    const host = fakeHost(snap("hidden", 0));
    const transport: BulkTransport = {
      ...host.transport,
      setMode: async (mode, rev, epoch) => {
        const reply = await host.transport.setMode(mode, rev, epoch);
        host.state.snap = snap("hidden", reply.modeRevision! + 1);
        return reply;
      },
    };
    const [result] = await run({ s: transport });
    expect(result!.outcome).toBe("conflicted");
    // The second step goes out on the revision the first left, and the host refuses it.
    expect(host.state.calls).toEqual([
      ["unset", 0, "e1"],
      ["on", 1, "e1"],
    ]);
    expect(host.state.snap.mode).toBe("hidden");
  });

  it("reports a host that answers UNSUPPORTED as unsupported, not unreachable", async () => {
    const transport: BulkTransport = {
      getSnapshot: async () => {
        throw new Error("[AppError|UNSUPPORTED] No such channel");
      },
      setMode: vi.fn(),
      connect: vi.fn(async () => true),
      release: () => {},
    };
    const [result] = await run({ s: transport });
    expect(result!.outcome).toBe("unsupported");
    expect(transport.connect).not.toHaveBeenCalled();
  });
});

describe("previewCanopyModes", () => {
  it("never asks a host that is down", async () => {
    const getSnapshot = vi.fn(async () => snap("unset", 0));
    const rows = await previewCanopyModes([{ hostId: "d", name: "d", connected: false }], {
      transportFor: () => ({ getSnapshot, setMode: vi.fn(), release: () => {} }),
    });
    expect(rows).toEqual([{ hostId: "d", mode: null }]);
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it("reads modes without a single write and releases each target", async () => {
    const hidden = fakeHost(snap("hidden", 0));
    const rows = await previewCanopyModes([t("h"), t("x")], {
      transportFor: (target) =>
        target.hostId === "h"
          ? hidden.transport
          : {
              getSnapshot: async () => {
                throw new Error("down");
              },
              setMode: vi.fn(),
              release: () => {},
            },
    });
    expect(rows).toEqual([
      { hostId: "h", mode: "hidden" },
      { hostId: "x", mode: null },
    ]);
    expect(hidden.state.calls).toEqual([]);
    expect(hidden.state.released).toBe(1);
  });

  it("never turns Canopy on where it still reads with the retired hosted service", async () => {
    // A host from before #14448 says its tier in every snapshot.
    const old = fakeHost(Object.assign(snap("unset", 0), { tier: "free" }));
    const [result] = await run({ old: old.transport });
    expect(result).toMatchObject({ outcome: "unsupported" });
    expect(old.state.calls).toEqual([]);
  });

  it("sets the chosen model on each host before turning Canopy on there", async () => {
    const a = fakeHost(snap("unset", 0));
    const b = fakeHost(snap("hidden", 1));
    const order: string[] = [];
    for (const [name, host] of [
      ["a", a],
      ["b", b],
    ] as const) {
      const setMode = host.transport.setMode;
      host.transport.setMode = async (...args) => {
        order.push(`${name}:mode:${args[0]}`);
        return setMode(...args);
      };
      host.transport.setModel = async (id) => {
        order.push(`${name}:model:${id}`);
        // Slow to land: a mode step that doesn't wait for it runs first.
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`${name}:model-done`);
      };
    }
    const results = await run(
      { a: a.transport, b: b.transport },
      { model: "daintreehq/canopy-reader-68m" }
    );
    expect(results.map((r) => r.outcome)).toEqual(["enabled", "enabled"]);
    // The model comes first on every host, including the one that has to be shown first.
    expect(order.filter((o) => o.startsWith("a:"))).toEqual([
      "a:model:daintreehq/canopy-reader-68m",
      "a:model-done",
      "a:mode:on",
    ]);
    expect(order.filter((o) => o.startsWith("b:"))).toEqual([
      "b:model:daintreehq/canopy-reader-68m",
      "b:model-done",
      "b:mode:unset",
      "b:mode:on",
    ]);
  });

  it("leaves a host unchanged when it won't take the chosen model", async () => {
    const host = fakeHost(snap("unset", 0));
    host.transport.setModel = async () => {
      throw new Error("refused");
    };
    const [result] = await run({ x: host.transport }, { model: "daintreehq/canopy-reader-68m" });
    expect(result).toMatchObject({ outcome: "refused" });
    // Never turned on with a model nobody chose.
    expect(host.state.calls).toEqual([]);
  });

  it("asks for no model when none was chosen", async () => {
    const host = fakeHost(snap("unset", 0));
    const setModel = vi.fn(async () => {});
    host.transport.setModel = setModel;
    const [result] = await run({ x: host.transport });
    expect(result).toMatchObject({ outcome: "enabled" });
    expect(host.state.calls).toEqual([["on", 0, "e1"]]);
    expect(setModel).not.toHaveBeenCalled();
  });

  it("won't turn a host on with its own model when it can't take the chosen one", async () => {
    const host = fakeHost(snap("unset", 0));
    const [result] = await run({ x: host.transport }, { model: "daintreehq/canopy-reader-68m" });
    expect(result).toMatchObject({ outcome: "unsupported" });
    expect(host.state.calls).toEqual([]);
  });

  it("changes nothing when cancelled while the host is still being read", async () => {
    const host = fakeHost(snap("unset", 0));
    const controller = new AbortController();
    const setModel = vi.fn(async () => {});
    const transport: BulkTransport = {
      ...host.transport,
      setModel,
      getSnapshot: async () => {
        const reply = await host.transport.getSnapshot();
        controller.abort();
        return reply;
      },
    };
    const [result] = await run(
      { x: transport },
      { model: "daintreehq/canopy-reader-68m", signal: controller.signal }
    );
    expect(result!.outcome).not.toBe("enabled");
    expect(setModel).not.toHaveBeenCalled();
    expect(host.state.calls).toEqual([]);
  });
});
