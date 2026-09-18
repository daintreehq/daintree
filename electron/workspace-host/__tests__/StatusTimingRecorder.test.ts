import { describe, expect, it } from "vitest";
import { StatusTimingRecorder, isStatusReportCurrent } from "../StatusTimingRecorder.js";

describe("StatusTimingRecorder", () => {
  it("records the load stages and each monitor's first status only once", () => {
    const recorder = new StatusTimingRecorder();
    const a = {};
    const b = {};

    recorder.beginLoad(100);
    expect(recorder.isEnumerating()).toBe(true);
    recorder.markEnumerated(250);
    expect(recorder.isEnumerating()).toBe(false);

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

  it("stops enumerating when a load ends without listing worktrees", () => {
    const recorder = new StatusTimingRecorder();
    recorder.beginLoad(0);
    recorder.endLoad();
    expect(recorder.isEnumerating()).toBe(false);
    expect(recorder.getMarks([]).enumeratedAt).toBeNull();
  });

  it("does not stamp a first snapshot before any load began", () => {
    const recorder = new StatusTimingRecorder();
    recorder.noteEmit({}, false, 10);
    expect(recorder.getMarks([]).firstSnapshotAt).toBeNull();
  });
});

describe("isStatusReportCurrent", () => {
  const host = { epoch: "e2", monitorCount: 3, enumerating: false };
  const applied = { epoch: "e2", appliedAt: 1_000, worktreeCount: 3 };

  it("accepts an applied report taken from this host's state", () => {
    expect(isStatusReportCurrent(applied, host)).toBe(true);
  });

  it("refuses a store from another host epoch", () => {
    expect(isStatusReportCurrent({ ...applied, epoch: "e1" }, host)).toBe(false);
  });

  it("refuses a store whose worktree count differs from the host's", () => {
    expect(isStatusReportCurrent({ ...applied, worktreeCount: 0 }, host)).toBe(false);
  });

  it("refuses while the host is still listing worktrees", () => {
    expect(isStatusReportCurrent(applied, { ...host, enumerating: true })).toBe(false);
  });

  it("always accepts a deadline report", () => {
    expect(
      isStatusReportCurrent(
        { epoch: "e1", appliedAt: null, worktreeCount: 0 },
        { ...host, enumerating: true }
      )
    ).toBe(true);
  });
});
