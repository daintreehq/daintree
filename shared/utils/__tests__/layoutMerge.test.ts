import { describe, it, expect } from "vitest";
import { computeIdArrayDelta, mergeIdArray, deepEqualIgnoringUndefined } from "../layoutMerge";

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
