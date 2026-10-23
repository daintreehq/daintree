import { describe, expect, it, vi } from "vitest";
import type { CanopyMode, CanopySnapshot } from "@shared/types/ipc/canopy";
import {
  enableCanopyOnHosts,
  previewCanopyModes,
  type BulkTarget,
  type BulkTransport,
} from "../bulkEnable";

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
    tier: "free",
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
        throw Object.assign(new Error("x"), { code: "PERMISSION" });
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
        throw Object.assign(new Error("hidden"), { code: "PERMISSION" });
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

describe("previewCanopyModes", () => {
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
});
