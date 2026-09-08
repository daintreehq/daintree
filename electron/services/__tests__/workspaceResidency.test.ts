import { describe, it, expect, beforeEach, vi } from "vitest";

const storeData: Record<string, unknown> = {};
const liveViewsByWorkspace = new Map<string, number>();

vi.mock("../../store.js", () => ({
  store: {
    get: (key: string) => storeData[key],
    set: (key: string, value: unknown) => {
      storeData[key] = value;
    },
  },
}));

vi.mock("../../window/webContentsRegistry.js", () => ({
  getWebContentsForProject: (projectId: string) =>
    Array.from({ length: liveViewsByWorkspace.get(projectId) ?? 0 }, (_, i) => ({ id: i })),
}));

const {
  __resetWorkspaceResidencyForTests,
  clearWorkspaceEviction,
  isWorkspaceKeepResident,
  notifyWorkspaceViewsChanged,
  onWorkspaceResidencyChanged,
  readWorkspaceBindingState,
  recordWorkspaceEviction,
  setWorkspaceKeepResident,
} = await import("../workspaceResidency.js");

const WORKSPACE = "a".repeat(64);
const OTHER = "b".repeat(64);

beforeEach(() => {
  for (const key of Object.keys(storeData)) delete storeData[key];
  liveViewsByWorkspace.clear();
  __resetWorkspaceResidencyForTests();
});

describe("keep-resident preference (#12313)", () => {
  it("is off for a workspace the user never granted", () => {
    expect(isWorkspaceKeepResident(WORKSPACE)).toBe(false);
  });

  it("round-trips a grant and removes the key when revoked", () => {
    setWorkspaceKeepResident(WORKSPACE, true);
    expect(isWorkspaceKeepResident(WORKSPACE)).toBe(true);
    expect(storeData.workspaceKeepResident).toEqual({ [WORKSPACE]: true });

    setWorkspaceKeepResident(WORKSPACE, false);
    expect(isWorkspaceKeepResident(WORKSPACE)).toBe(false);
    // Absence is the only "off" this key has — a `false` entry left behind
    // would grow the record for every workspace ever toggled.
    expect(storeData.workspaceKeepResident).toEqual({});
  });

  it("treats anything but an exact true as no grant", () => {
    // The record is keyed by workspace id and nothing prunes it, so a value
    // that arrived from a hand-edited config must not protect a view.
    storeData.workspaceKeepResident = { [WORKSPACE]: "yes", [OTHER]: 1 };
    expect(isWorkspaceKeepResident(WORKSPACE)).toBe(false);
    expect(isWorkspaceKeepResident(OTHER)).toBe(false);
  });

  it("leaves other workspaces' grants alone when one changes", () => {
    setWorkspaceKeepResident(WORKSPACE, true);
    setWorkspaceKeepResident(OTHER, true);
    setWorkspaceKeepResident(WORKSPACE, false);
    expect(isWorkspaceKeepResident(OTHER)).toBe(true);
  });
});

describe("binding state read (#12313)", () => {
  it("answers unbound without inventing a workspace", () => {
    // An unbound session routes to the focused view. Substituting that view's
    // workspace here would be the cross-workspace answer the binding exists to
    // refuse (#7003).
    expect(readWorkspaceBindingState(null)).toMatchObject({
      workspaceId: null,
      routeState: "unbound",
      liveViewCount: 0,
      keepResident: false,
      evictedAt: null,
    });
  });

  it("mirrors the bridge's zero/one/many rule", () => {
    expect(readWorkspaceBindingState(WORKSPACE).routeState).toBe("not-found");

    liveViewsByWorkspace.set(WORKSPACE, 1);
    expect(readWorkspaceBindingState(WORKSPACE)).toMatchObject({
      routeState: "available",
      liveViewCount: 1,
    });

    liveViewsByWorkspace.set(WORKSPACE, 2);
    // Two views is not "reachable" — `getWorkspaceWebContents` refuses it as
    // ambiguous, and this read must not disagree with what routing would do.
    expect(readWorkspaceBindingState(WORKSPACE)).toMatchObject({
      routeState: "ambiguous",
      liveViewCount: 2,
    });
  });

  it("reports the grant alongside the route", () => {
    setWorkspaceKeepResident(WORKSPACE, true);
    expect(readWorkspaceBindingState(WORKSPACE).keepResident).toBe(true);
  });

  it("distinguishes an evicted workspace from one never opened", () => {
    // The whole point of the ledger: before this, a bound client could not tell
    // "temporarily gone" from "this id was always wrong".
    expect(readWorkspaceBindingState(WORKSPACE).evictedAt).toBeNull();

    recordWorkspaceEviction(WORKSPACE, "pressure");
    const state = readWorkspaceBindingState(WORKSPACE);
    expect(state.routeState).toBe("not-found");
    expect(state.evictionReason).toBe("pressure");
    expect(typeof state.evictedAt).toBe("number");
  });

  it("forgets the eviction once the workspace is open again", () => {
    recordWorkspaceEviction(WORKSPACE, "lru");
    clearWorkspaceEviction(WORKSPACE);
    expect(readWorkspaceBindingState(WORKSPACE).evictedAt).toBeNull();
  });

  it("never reports a loss while the route still resolves", () => {
    // The single gate on the record, since writes are unconditional — so this
    // carries the whole guarantee. Covers both orderings: a second window's
    // view already live when the pass runs, and a workspace reopened after one.
    liveViewsByWorkspace.set(WORKSPACE, 1);
    recordWorkspaceEviction(WORKSPACE, "pressure");
    expect(readWorkspaceBindingState(WORKSPACE)).toMatchObject({
      routeState: "available",
      evictedAt: null,
      evictionReason: null,
    });

    liveViewsByWorkspace.set(WORKSPACE, 0);
    recordWorkspaceEviction(WORKSPACE, "lru");
    liveViewsByWorkspace.set(WORKSPACE, 1);
    expect(readWorkspaceBindingState(WORKSPACE).evictedAt).toBeNull();
  });
});

describe("residency subscriptions (#12313)", () => {
  it("fires for eviction, reopen, view changes and grant changes", () => {
    const seen = vi.fn();
    onWorkspaceResidencyChanged(WORKSPACE, seen);

    recordWorkspaceEviction(WORKSPACE, "lru");
    clearWorkspaceEviction(WORKSPACE);
    notifyWorkspaceViewsChanged(WORKSPACE);
    setWorkspaceKeepResident(WORKSPACE, true);

    expect(seen).toHaveBeenCalledTimes(4);
  });

  it("does not wake a subscriber for another workspace", () => {
    const seen = vi.fn();
    onWorkspaceResidencyChanged(WORKSPACE, seen);
    recordWorkspaceEviction(OTHER, "lru");
    expect(seen).not.toHaveBeenCalled();
  });

  it("stops firing after unsubscribe, and unsubscribing twice is harmless", () => {
    const seen = vi.fn();
    const off = onWorkspaceResidencyChanged(WORKSPACE, seen);
    off();
    off();
    recordWorkspaceEviction(WORKSPACE, "lru");
    expect(seen).not.toHaveBeenCalled();
  });

  it("keeps notifying the rest when one listener throws", () => {
    // A subscription belongs to an MCP session whose transport may already be
    // gone; one failing send must not strand every other subscriber.
    const good = vi.fn();
    onWorkspaceResidencyChanged(WORKSPACE, () => {
      throw new Error("transport gone");
    });
    onWorkspaceResidencyChanged(WORKSPACE, good);
    recordWorkspaceEviction(WORKSPACE, "lru");
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("survives a listener that unsubscribes itself while being notified", () => {
    const other = vi.fn();
    const off: Array<() => void> = [];
    off.push(
      onWorkspaceResidencyChanged(WORKSPACE, () => {
        off[0]?.();
      })
    );
    onWorkspaceResidencyChanged(WORKSPACE, other);
    expect(() => recordWorkspaceEviction(WORKSPACE, "lru")).not.toThrow();
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("does not notify a grant write that changed nothing", () => {
    setWorkspaceKeepResident(WORKSPACE, true);
    const seen = vi.fn();
    onWorkspaceResidencyChanged(WORKSPACE, seen);
    setWorkspaceKeepResident(WORKSPACE, true);
    expect(seen).not.toHaveBeenCalled();
  });
});
