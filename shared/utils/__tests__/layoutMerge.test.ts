import { describe, it, expect } from "vitest";
import {
  computeIdArrayDelta,
  mergeIdArray,
  deepEqualIgnoringUndefined,
  computeRecordDelta,
  mergeRecord,
} from "../layoutMerge.js";

interface Entry {
  id: string;
  v?: string;
}

const eq = (a: Entry, b: Entry) => a.v === b.v;
const ids = (entries: Entry[]) => entries.map((e) => e.id);

describe("deepEqualIgnoringUndefined", () => {
  it("treats a missing key and an explicit undefined value as equal", () => {
    // The exact JSON-round-trip mismatch behind #11350's false-positive changes.
    expect(deepEqualIgnoringUndefined({ id: "p", worktreeId: undefined }, { id: "p" })).toBe(true);
    expect(deepEqualIgnoringUndefined({ id: "p" }, { id: "p", worktreeId: undefined })).toBe(true);
  });

  it("still reports a genuine value difference", () => {
    expect(deepEqualIgnoringUndefined({ id: "p", loc: "grid" }, { id: "p", loc: "dock" })).toBe(
      false
    );
  });

  it("compares nested objects and arrays with the same rule", () => {
    expect(
      deepEqualIgnoringUndefined(
        { id: "g", panelIds: ["a", "b"], worktreeId: undefined },
        { id: "g", panelIds: ["a", "b"] }
      )
    ).toBe(true);
    expect(
      deepEqualIgnoringUndefined({ id: "g", panelIds: ["a", "b"] }, { id: "g", panelIds: ["a"] })
    ).toBe(false);
  });

  it("does not conflate a real key with an undefined-valued one of a different name", () => {
    expect(deepEqualIgnoringUndefined({ id: "p", a: undefined }, { id: "p", b: 1 })).toBe(false);
  });
});

describe("computeIdArrayDelta with JSON-round-trip equality", () => {
  it("does not flag an entry that differs only by a dropped undefined key", () => {
    const base = [{ id: "1" }]; // as read back from disk (undefined keys dropped)
    const current = [{ id: "1", v: undefined } as Entry]; // freshly serialized
    const delta = computeIdArrayDelta(base, current, deepEqualIgnoringUndefined);
    expect(delta.changedIds).toEqual([]);
    expect(delta.removedIds).toEqual([]);
  });
});

describe("computeIdArrayDelta", () => {
  it("reports added ids as changed", () => {
    const delta = computeIdArrayDelta([{ id: "1" }], [{ id: "1" }, { id: "2" }], eq);
    expect(delta.changedIds).toEqual(["2"]);
    expect(delta.removedIds).toEqual([]);
  });

  it("reports content changes as changed", () => {
    const delta = computeIdArrayDelta([{ id: "1", v: "a" }], [{ id: "1", v: "b" }], eq);
    expect(delta.changedIds).toEqual(["1"]);
    expect(delta.removedIds).toEqual([]);
  });

  it("reports missing baseline entries as removed", () => {
    const delta = computeIdArrayDelta([{ id: "1" }, { id: "2" }], [{ id: "1" }], eq);
    expect(delta.changedIds).toEqual([]);
    expect(delta.removedIds).toEqual(["2"]);
  });

  it("produces an empty delta when content is identical regardless of order", () => {
    const delta = computeIdArrayDelta(
      [
        { id: "1", v: "a" },
        { id: "2", v: "b" },
      ],
      [
        { id: "2", v: "b" },
        { id: "1", v: "a" },
      ],
      eq
    );
    expect(delta.changedIds).toEqual([]);
    expect(delta.removedIds).toEqual([]);
  });

  it("handles simultaneous add, change, and remove", () => {
    const delta = computeIdArrayDelta(
      [
        { id: "1", v: "a" },
        { id: "2", v: "b" },
      ],
      [
        { id: "1", v: "a2" },
        { id: "3", v: "c" },
      ],
      eq
    );
    expect(new Set(delta.changedIds)).toEqual(new Set(["1", "3"]));
    expect(delta.removedIds).toEqual(["2"]);
  });
});

describe("mergeIdArray", () => {
  it("preserves a sibling's addition unknown to the writer", () => {
    // disk has a sibling's panel 4; writer only knows 1,2,3 and added nothing new.
    const existing = [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }];
    const incoming = [{ id: "1" }, { id: "2" }, { id: "3" }];
    const merged = mergeIdArray(existing, incoming, [], []);
    expect(new Set(ids(merged))).toEqual(new Set(["1", "2", "3", "4"]));
  });

  it("applies the writer's addition", () => {
    const existing = [{ id: "1" }];
    const incoming = [{ id: "1" }, { id: "2" }];
    const merged = mergeIdArray(existing, incoming, ["2"], []);
    expect(ids(merged)).toEqual(["1", "2"]);
  });

  it("removes an explicitly-removed entry (close persists)", () => {
    const existing = [{ id: "1" }, { id: "2" }, { id: "3" }];
    const incoming = [{ id: "1" }, { id: "3" }];
    const merged = mergeIdArray(existing, incoming, [], ["2"]);
    expect(ids(merged)).toEqual(["1", "3"]);
  });

  it("preserves a disjoint move: a sibling's edit to an entry the writer did not change", () => {
    // A moved panel 1 to dock (on disk). B is stale (panel 1 still grid) and adds panel 2.
    const existing = [{ id: "1", v: "dock" }];
    const incoming = [
      { id: "1", v: "grid" },
      { id: "2", v: "new" },
    ];
    const merged = mergeIdArray(existing, incoming, ["2"], []);
    // Panel 1 keeps the sibling's dock value; panel 2 is added.
    expect(merged).toEqual([
      { id: "1", v: "dock" },
      { id: "2", v: "new" },
    ]);
  });

  it("does not resurrect a sibling-deleted entry the writer did not change", () => {
    // A closed panel 2 (disk = [1]). B is stale ([1,2]) and adds panel 3.
    const existing = [{ id: "1" }];
    const incoming = [{ id: "1" }, { id: "2" }, { id: "3" }];
    const merged = mergeIdArray(existing, incoming, ["3"], []);
    expect(ids(merged)).toEqual(["1", "3"]);
  });

  it("lets the writer's own change win for a shared id (last-writer-wins)", () => {
    const existing = [{ id: "1", v: "disk" }];
    const incoming = [{ id: "1", v: "mine" }];
    const merged = mergeIdArray(existing, incoming, ["1"], []);
    expect(merged).toEqual([{ id: "1", v: "mine" }]);
  });

  it("applies the incoming order for known entries (reorder persists)", () => {
    const existing = [{ id: "1" }, { id: "2" }, { id: "3" }];
    const incoming = [{ id: "3" }, { id: "2" }, { id: "1" }];
    const merged = mergeIdArray(existing, incoming, [], []);
    expect(ids(merged)).toEqual(["3", "2", "1"]);
  });

  it("appends sibling-only additions after the writer's known entries", () => {
    const existing = [{ id: "1" }, { id: "sib" }];
    const incoming = [{ id: "1" }, { id: "2" }];
    const merged = mergeIdArray(existing, incoming, ["2"], []);
    expect(ids(merged)).toEqual(["1", "2", "sib"]);
  });

  it("clears all known entries when the writer removes everything it knew", () => {
    // "Close all panels" in the only window: removedIds covers the full baseline.
    const existing = [{ id: "1" }, { id: "2" }];
    const merged = mergeIdArray(existing, [], [], ["1", "2"]);
    expect(merged).toEqual([]);
  });

  it("keeps a sibling's panel when the writer closes all of its own", () => {
    // Writer knew [1,2] and closed both; a sibling added 'sib' the writer never knew.
    const existing = [{ id: "1" }, { id: "2" }, { id: "sib" }];
    const merged = mergeIdArray(existing, [], [], ["1", "2"]);
    expect(ids(merged)).toEqual(["sib"]);
  });

  it("does not throw on malformed existing/incoming entries", () => {
    const existing = [null, { id: "1" }, { notId: true }] as unknown as Entry[];
    const incoming = [{ id: "1" }, undefined, { id: "2" }] as unknown as Entry[];
    const merged = mergeIdArray(existing, incoming, ["2"], []);
    expect(ids(merged)).toEqual(["1", "2"]);
  });

  it("round-trips a delta computed from a shared baseline", () => {
    const base = [
      { id: "1", v: "a" },
      { id: "2", v: "b" },
    ];
    const current = [
      { id: "1", v: "a" },
      { id: "2", v: "b2" },
      { id: "3", v: "c" },
    ];
    const { changedIds, removedIds } = computeIdArrayDelta(base, current, eq);
    // Disk still equals the shared baseline (no sibling activity).
    const merged = mergeIdArray(base, current, changedIds, removedIds);
    expect(merged).toEqual(current);
  });
});

describe("out-of-band field preservation (#11461)", () => {
  interface Snap {
    id: string;
    agentSessionId?: string;
    agentState?: string;
    detectedProcessId?: string;
  }

  // Mirrors the real producer: undefined-valued keys are dropped, so an absent
  // field and an explicitly-undefined one are the same wire shape.
  const snapEq = (a: Snap, b: Snap) => deepEqualIgnoringUndefined(a, b);
  const preserveSession = { preserveOnOmission: ["agentSessionId"] } as const;

  it("keeps a session id only Main knows when an ambient change flags the entry", () => {
    // The #11461 scenario: shutdown captured the id straight to disk, the
    // renderer never had it, and a PTY exit flips agentState on the next save.
    const existing: Snap[] = [{ id: "1", agentSessionId: "captured", agentState: "idle" }];
    const incoming: Snap[] = [{ id: "1", agentState: "exited" }];

    const merged = mergeIdArray(existing, incoming, ["1"], [], preserveSession);

    expect(merged[0]!.agentSessionId).toBe("captured");
    // The ambient field the writer *did* change still wins.
    expect(merged[0]!.agentState).toBe("exited");
  });

  it("deletes the field when the writer tombstones it", () => {
    const existing: Snap[] = [{ id: "1", agentSessionId: "stale" }];
    const incoming: Snap[] = [{ id: "1" }];

    const merged = mergeIdArray(existing, incoming, ["1"], [], {
      ...preserveSession,
      clearedFields: [{ id: "1", fields: ["agentSessionId"] }],
    });

    expect(merged[0]!.agentSessionId).toBeUndefined();
  });

  it("lets a defined incoming value win over a contradictory tombstone", () => {
    // Our producer can't emit both, so this only guards malformed IPC input:
    // a persistence merge must never destroy a live value it was handed.
    const existing: Snap[] = [{ id: "1", agentSessionId: "old" }];
    const incoming: Snap[] = [{ id: "1", agentSessionId: "new" }];

    const merged = mergeIdArray(existing, incoming, ["1"], [], {
      ...preserveSession,
      clearedFields: [{ id: "1", fields: ["agentSessionId"] }],
    });

    expect(merged[0]!.agentSessionId).toBe("new");
  });

  it("does not preserve a field outside the allowlist", () => {
    const existing: Snap[] = [{ id: "1", agentSessionId: "keep", agentState: "idle" }];
    const incoming: Snap[] = [{ id: "1" }];

    const merged = mergeIdArray(existing, incoming, ["1"], [], preserveSession);

    expect(merged[0]!.agentSessionId).toBe("keep");
    expect(merged[0]!.agentState).toBeUndefined();
  });

  it("unions duplicate tombstone entries for the same id", () => {
    const existing: Snap[] = [{ id: "1", agentSessionId: "a", detectedProcessId: "b" }];
    const incoming: Snap[] = [{ id: "1" }];

    const merged = mergeIdArray(existing, incoming, ["1"], [], {
      preserveOnOmission: ["agentSessionId", "detectedProcessId"],
      clearedFields: [
        { id: "1", fields: ["agentSessionId"] },
        { id: "1", fields: ["detectedProcessId"] },
      ],
    });

    expect(merged[0]!.agentSessionId).toBeUndefined();
    expect(merged[0]!.detectedProcessId).toBeUndefined();
  });

  it("returns the incoming entry unchanged when nothing needs carrying", () => {
    const existing: Snap[] = [{ id: "1" }];
    const incoming: Snap[] = [{ id: "1", agentSessionId: "x" }];

    const merged = mergeIdArray(existing, incoming, ["1"], [], preserveSession);

    expect(merged[0]).toBe(incoming[0]);
  });

  it("ignores a tombstone for an entry the writer never changed", () => {
    const existing: Snap[] = [{ id: "1", agentSessionId: "sibling" }];
    const incoming: Snap[] = [{ id: "1" }];

    const merged = mergeIdArray(existing, incoming, [], [], {
      ...preserveSession,
      clearedFields: [{ id: "1", fields: ["agentSessionId"] }],
    });

    expect(merged[0]!.agentSessionId).toBe("sibling");
  });

  it("emits no tombstone when the baseline never carried the field", () => {
    // Renderer baseline is primed from disk at hydration, so a value only Main
    // ever wrote is absent from both sides — which must read as "unknown".
    const base: Snap[] = [{ id: "1", agentState: "idle" }];
    const current: Snap[] = [{ id: "1", agentState: "exited" }];

    const delta = computeIdArrayDelta(base, current, snapEq, ["agentSessionId"]);

    expect(delta.changedIds).toEqual(["1"]);
    expect(delta.clearedFields).toBeUndefined();
  });

  it("emits a tombstone when a tracked field goes from a value to absent", () => {
    const base: Snap[] = [{ id: "1", agentSessionId: "consumed" }];
    const current: Snap[] = [{ id: "1" }];

    const delta = computeIdArrayDelta(base, current, snapEq, ["agentSessionId"]);

    expect(delta.clearedFields).toEqual([{ id: "1", fields: ["agentSessionId"] }]);
  });

  it("flags a tombstoned id as changed even when equals ignores the field", () => {
    // A tombstone is only honoured for an entry the writer is allowed to touch,
    // so the two lists have to stay consistent under a partial equality fn.
    const base: Snap[] = [{ id: "1", agentSessionId: "consumed", agentState: "idle" }];
    const current: Snap[] = [{ id: "1", agentState: "idle" }];
    const stateOnlyEq = (a: Snap, b: Snap) => a.agentState === b.agentState;

    const delta = computeIdArrayDelta(base, current, stateOnlyEq, ["agentSessionId"]);

    expect(delta.changedIds).toEqual(["1"]);
    expect(delta.clearedFields).toHaveLength(1);
  });

  it("round-trips: a deliberate clear survives the merge, an unknown value does not clear", () => {
    const disk: Snap[] = [
      { id: "consumed", agentSessionId: "old-a" },
      { id: "captured", agentSessionId: "from-shutdown" },
    ];
    // Baseline = what this renderer last acknowledged. It knew "consumed"'s id
    // and then dropped it; it never knew "captured"'s.
    const base: Snap[] = [{ id: "consumed", agentSessionId: "old-a" }, { id: "captured" }];
    const current: Snap[] = [
      { id: "consumed" },
      { id: "captured", agentState: "exited" },
    ];

    const delta = computeIdArrayDelta(base, current, snapEq, ["agentSessionId"]);
    const merged = mergeIdArray(disk, current, delta.changedIds, delta.removedIds, {
      ...preserveSession,
      clearedFields: delta.clearedFields,
    });

    const byId = new Map(merged.map((entry) => [entry.id, entry]));
    expect(byId.get("consumed")!.agentSessionId).toBeUndefined();
    expect(byId.get("captured")!.agentSessionId).toBe("from-shutdown");
  });
});

describe("computeRecordDelta (draft inputs, #11352)", () => {
  it("reports an added key as changed", () => {
    const delta = computeRecordDelta({ a: "x" }, { a: "x", b: "y" });
    expect(delta.changedIds).toEqual(["b"]);
    expect(delta.removedIds).toEqual([]);
  });

  it("reports an edited value as changed", () => {
    const delta = computeRecordDelta({ a: "x" }, { a: "x2" });
    expect(delta.changedIds).toEqual(["a"]);
    expect(delta.removedIds).toEqual([]);
  });

  it("derives a removal tombstone from a key absent in current — the core #11352 case", () => {
    // A cleared/sent draft is dropped from the live map, so removal can ONLY be
    // seen by diffing against the remembered baseline.
    const delta = computeRecordDelta({ a: "x", b: "y" }, { b: "y" });
    expect(delta.changedIds).toEqual([]);
    expect(delta.removedIds).toEqual(["a"]);
  });

  it("produces an empty delta when nothing changed", () => {
    const delta = computeRecordDelta({ a: "x", b: "y" }, { a: "x", b: "y" });
    expect(delta.changedIds).toEqual([]);
    expect(delta.removedIds).toEqual([]);
  });

  it("handles simultaneous add, edit, and remove", () => {
    const delta = computeRecordDelta({ a: "x", b: "y" }, { a: "x2", c: "z" });
    expect(new Set(delta.changedIds)).toEqual(new Set(["a", "c"]));
    expect(delta.removedIds).toEqual(["b"]);
  });
});

describe("mergeRecord (draft inputs, #11352)", () => {
  it("preserves a sibling's draft the writer never knew", () => {
    // Disk has a sibling window's draft for terminal 'sib'; the writer only
    // changed 'a'.
    const merged = mergeRecord({ a: "old", sib: "keep" }, { a: "new" }, ["a"], []);
    expect(merged).toEqual({ a: "new", sib: "keep" });
  });

  it("applies the writer's addition and edit (last-writer-wins on a shared key)", () => {
    const merged = mergeRecord({ a: "disk" }, { a: "mine", b: "added" }, ["a", "b"], []);
    expect(merged).toEqual({ a: "mine", b: "added" });
  });

  it("removes an explicitly-removed key while keeping siblings", () => {
    const merged = mergeRecord({ a: "x", sib: "keep" }, {}, [], ["a"]);
    expect(merged).toEqual({ sib: "keep" });
  });

  it("does not resurrect a key present in incoming but absent from changedIds", () => {
    // A sibling deleted 'a' (not on disk); a stale writer still carries it but
    // did not change it, so it must not come back.
    const merged = mergeRecord({ b: "y" }, { a: "stale", b: "y" }, [], []);
    expect(merged).toEqual({ b: "y" });
  });

  it("lets removal win over a malformed changed/removed overlap", () => {
    const merged = mergeRecord({ a: "x" }, { a: "new" }, ["a"], ["a"]);
    expect(merged).toEqual({});
  });

  it("treats a changed id missing from incoming as a defensive deletion", () => {
    // Malformed delta: 'a' is flagged changed but absent/empty in the incoming
    // record; it must be dropped, not left stale, and siblings preserved.
    const merged = mergeRecord({ a: "old", sib: "keep" }, {}, ["a"], []);
    expect(merged).toEqual({ sib: "keep" });
  });

  it("does not mistake a prototype key for present state", () => {
    // `constructor`/`toString` exist on Object.prototype; own-property checks
    // must keep them from being seen as present-on-base or present-in-incoming.
    const delta = computeRecordDelta({}, { constructor: "real" });
    expect(delta.changedIds).toEqual(["constructor"]);
    const merged = mergeRecord({}, { constructor: "real" }, ["constructor"], []);
    expect(merged).toEqual({ constructor: "real" });
  });

  it("drops empty/malformed on-disk values so they don't survive forever", () => {
    const merged = mergeRecord(
      { a: "", b: "keep" } as Record<string, string>,
      { c: "add" },
      ["c"],
      []
    );
    expect(merged).toEqual({ b: "keep", c: "add" });
  });

  it("round-trips a delta computed from a shared baseline (no sibling activity)", () => {
    const base = { a: "x", b: "y" };
    const current = { a: "x2", c: "z" }; // edited a, removed b, added c
    const { changedIds, removedIds } = computeRecordDelta(base, current);
    const merged = mergeRecord(base, current, changedIds, removedIds);
    expect(merged).toEqual(current);
  });
});
