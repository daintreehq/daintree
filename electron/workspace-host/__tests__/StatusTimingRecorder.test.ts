import { describe, expect, it } from "vitest";
import { StatusTimingRecorder, isStatusReportCurrent } from "../StatusTimingRecorder.js";

describe("StatusTimingRecorder", () => {
  it("records the load stages and each monitor's first status only once", () => {
    const recorder = new StatusTimingRecorder();
    const a = {};
    const b = {};

    recorder.beginLoad(100);
    recorder.markEnumerated(250);

    recorder.noteEmit(a, false, 260);
    recorder.noteEmit(b, false, 261);
    recorder.noteEmit(a, true, 900);
    recorder.noteEmit(a, true, 1_500);
    recorder.noteEmit(b, true, 1_200);

    expect(recorder.getMarks([a, b])).toEqual({
      loadStartedAt: 100,
      enumeratedAt: 250,
      firstSnapshotAt: 260,
      firstStatusAt: [900, 1_200],
      monitorCount: 2,
    });
  });

  it("counts monitors still waiting for a status without timing them", () => {
    const recorder = new StatusTimingRecorder();
    const a = {};
    const b = {};
    recorder.beginLoad(0);
    recorder.markEnumerated(10);
    recorder.noteEmit(a, true, 50);
    recorder.noteEmit(b, false, 51);

    expect(recorder.getMarks([a, b])).toMatchObject({ firstStatusAt: [50], monitorCount: 2 });
  });

  it("drops stamps of monitors no longer live, and a replacement starts over", () => {
    const recorder = new StatusTimingRecorder();
    const gone = {};
    const replacement = {};
    recorder.beginLoad(0);
    recorder.noteEmit(gone, true, 40);

    expect(recorder.getMarks([replacement])).toMatchObject({ firstStatusAt: [], monitorCount: 1 });
  });

  it("keeps first-status stamps across a reload but resets the load stages", () => {
    const recorder = new StatusTimingRecorder();
    const a = {};
    recorder.beginLoad(0);
    recorder.markEnumerated(10);
    recorder.noteEmit(a, true, 20);

    recorder.beginLoad(5_000);
    expect(recorder.getMarks([a])).toEqual({
      loadStartedAt: 5_000,
      enumeratedAt: null,
      firstSnapshotAt: null,
      firstStatusAt: [20],
      monitorCount: 1,
    });
  });

  it("is settled only between a successful load and the next one", () => {
    const recorder = new StatusTimingRecorder();
    expect(recorder.isLoaded()).toBe(false);

    recorder.beginLoad(0);
    recorder.markEnumerated(10);
    expect(recorder.isLoaded()).toBe(false);

    recorder.markLoaded();
    expect(recorder.isLoaded()).toBe(true);

    recorder.beginLoad(500);
    expect(recorder.isLoaded()).toBe(false);
  });

  it("does not stamp a first snapshot before any load began", () => {
    const recorder = new StatusTimingRecorder();
    recorder.noteEmit({}, false, 10);
    expect(recorder.getMarks([]).firstSnapshotAt).toBeNull();
  });
});

describe("isStatusReportCurrent", () => {
  const marks = {
    loadStartedAt: 0,
    enumeratedAt: 10,
    firstSnapshotAt: 20,
    firstStatusAt: [300, 400, 500],
    monitorCount: 3,
  };
  const host = { epoch: "e2", loaded: true, marks };
  const applied = { epoch: "e2", appliedAt: 1_000, worktreeCount: 3 };

  it("accepts an applied report once this host has emitted every status", () => {
    expect(isStatusReportCurrent(applied, host)).toBe(true);
  });

  it("refuses a store from another host epoch", () => {
    expect(isStatusReportCurrent({ ...applied, epoch: "e1" }, host)).toBe(false);
  });

  it("refuses a store whose worktree count differs from the host's", () => {
    expect(isStatusReportCurrent({ ...applied, worktreeCount: 2 }, host)).toBe(false);
  });

  it("refuses a complete-looking store before this host has emitted every status", () => {
    // After a restart the store can carry the new epoch alongside a row the old
    // host last described, so every row has a status that this host never sent.
    expect(
      isStatusReportCurrent(applied, { ...host, marks: { ...marks, firstStatusAt: [300, 400] } })
    ).toBe(false);
  });

  it("refuses an empty store answered before the load settled", () => {
    const empty = { ...marks, firstStatusAt: [], monitorCount: 0 };
    const report = { ...applied, worktreeCount: 0 };
    expect(isStatusReportCurrent(report, { ...host, loaded: false, marks: empty })).toBe(false);
    expect(isStatusReportCurrent(report, { ...host, marks: empty })).toBe(true);
  });

  it("always accepts a deadline report", () => {
    expect(
      isStatusReportCurrent(
        { epoch: "e1", appliedAt: null, worktreeCount: 0 },
        { ...host, loaded: false }
      )
    ).toBe(true);
  });
});
