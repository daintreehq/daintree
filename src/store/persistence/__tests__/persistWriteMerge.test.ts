import { describe, expect, it } from "vitest";
import { mergeRecordByWriterDelta, pickFieldByWriterDelta } from "../persistWriteMerge";

interface Session {
  sessionId: string;
  cwd: string;
}

const A: Session = { sessionId: "a", cwd: "/a" };
const A2: Session = { sessionId: "a2", cwd: "/a" };
const B: Session = { sessionId: "b", cwd: "/b" };
const B2: Session = { sessionId: "b2", cwd: "/b" };

describe("mergeRecordByWriterDelta", () => {
  it("keeps a key the writer added (absent from baseline)", () => {
    // baseline: {}, incoming: {a}, disk: {}
    expect(mergeRecordByWriterDelta({}, { a: A }, {})).toEqual({ a: A });
  });

  it("keeps a key the writer changed relative to its baseline", () => {
    // writer owned `a` and updated it; a's new value wins over disk's old one
    expect(mergeRecordByWriterDelta({ a: A }, { a: A2 }, { a: A })).toEqual({ a: A2 });
  });

  it("takes the on-disk value for a key the writer left unchanged (sibling edited it)", () => {
    // writer didn't touch `a`; a sibling changed it on disk → sibling wins
    expect(mergeRecordByWriterDelta({ a: A }, { a: A }, { a: A2 })).toEqual({ a: A2 });
  });

  it("does not resurrect a key a sibling deleted that the writer left unchanged", () => {
    // writer still carries `a` (unchanged), but a sibling deleted it on disk → stays gone
    expect(mergeRecordByWriterDelta({ a: A }, { a: A }, {})).toEqual({});
  });

  it("drops a key the writer intentionally deleted even if it lingers on disk", () => {
    // writer knew `a` (baseline) and removed it (absent from incoming) → dropped
    expect(mergeRecordByWriterDelta({ a: A }, {}, { a: A })).toEqual({});
  });

  it("preserves a sibling addition the writer never knew about", () => {
    // `b` is absent from both baseline and incoming but present on disk → kept
    expect(mergeRecordByWriterDelta({ a: A }, { a: A }, { a: A, b: B })).toEqual({ a: A, b: B });
  });

  it("resolves the canonical clobber: stale writer keeps its own key and a sibling's key", () => {
    // writer owned `a`, updates it; a sibling concurrently added `b` on disk.
    const result = mergeRecordByWriterDelta({ a: A }, { a: A2 }, { a: A, b: B });
    expect(result).toEqual({ a: A2, b: B });
  });

  it("honors a writer deletion while preserving an unrelated sibling addition", () => {
    // writer deletes `a`; sibling added `b` → a gone, b kept
    expect(mergeRecordByWriterDelta({ a: A }, {}, { a: A, b: B })).toEqual({ b: B });
  });

  it("uses JSON-round-trip equality so an undefined-key no-op is not treated as a change", () => {
    // `a` carries an explicit undefined field in incoming but is otherwise identical;
    // it must count as unchanged, so a sibling's concurrent disk edit is preserved.
    const baseline = { a: { sessionId: "a", cwd: "/a" } };
    const incoming = { a: { sessionId: "a", cwd: "/a", extra: undefined } as unknown as Session };
    const disk = { a: A2 };
    expect(mergeRecordByWriterDelta(baseline, incoming, disk)).toEqual({ a: A2 });
  });

  it("accepts a custom equality predicate", () => {
    // treat all sessions as equal → writer's `a` counts as unchanged → disk wins
    const alwaysEqual = () => true;
    expect(mergeRecordByWriterDelta({ a: A }, { a: A2 }, { a: B }, alwaysEqual)).toEqual({ a: B });
  });

  it("returns an empty record when every input is empty", () => {
    expect(mergeRecordByWriterDelta({}, {}, {})).toEqual({});
  });

  it("preserves multiple sibling keys alongside the writer's own change", () => {
    expect(mergeRecordByWriterDelta({ a: A }, { a: A2 }, { a: A, b: B, c: B2 })).toEqual({
      a: A2,
      b: B,
      c: B2,
    });
  });
});

describe("pickFieldByWriterDelta", () => {
  it("keeps the incoming value when the writer changed the field", () => {
    expect(pickFieldByWriterDelta(380, 500, 420)).toBe(500);
  });

  it("keeps the on-disk value when the writer left the field unchanged", () => {
    // writer's field equals its baseline → defer to whatever a sibling last wrote
    expect(pickFieldByWriterDelta(380, 380, 420)).toBe(420);
  });

  it("treats a nulled field as a writer change over a sibling's value", () => {
    expect(pickFieldByWriterDelta("claude", null, "codex")).toBeNull();
  });

  it("keeps a sibling's field value when the writer's value matches its baseline null", () => {
    expect(pickFieldByWriterDelta(null, null, "claude")).toBe("claude");
  });

  it("uses JSON-round-trip equality for object fields", () => {
    const baseline = { scope: "current", stateFilter: "all" };
    const incoming = { scope: "current", stateFilter: "all", extra: undefined } as Record<
      string,
      unknown
    >;
    const disk = { scope: "all", stateFilter: "none" };
    // incoming equals baseline under JSON semantics → the sibling's disk value wins
    expect(pickFieldByWriterDelta(baseline, incoming, disk)).toEqual(disk);
  });
});
