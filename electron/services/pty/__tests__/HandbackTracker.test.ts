import { describe, expect, it } from "vitest";
import { HandbackTracker, MAX_HANDBACK_REQUESTS } from "../HandbackTracker.js";

const noScreen = () => [];

function codes(tracker: HandbackTracker): string[] {
  return tracker.deliveredRequests().map((request) => request.code);
}

describe("HandbackTracker", () => {
  it("costs nothing for an ordinary submit when no request is held", () => {
    const tracker = new HandbackTracker(noScreen);
    expect(tracker.noteSubmission()).toBeUndefined();
    expect(tracker.hasRequests()).toBe(false);
  });

  it("holds a request back until its submission reaches the pty", () => {
    const tracker = new HandbackTracker(noScreen);
    const written = tracker.noteSubmission("aaaaaa", "token-a");

    expect(tracker.hasRequests()).toBe(true);
    expect(tracker.deliveredRequests()).toEqual([]);

    written?.();
    expect(tracker.deliveredRequests()).toEqual([
      { code: "aaaaaa", submissionToken: "token-a", seq: 1, delivered: true },
    ]);
  });

  it("registers a launch prompt as delivered at once", () => {
    const tracker = new HandbackTracker(noScreen);
    tracker.registerDelivered("launch");
    expect(codes(tracker)).toEqual(["launch"]);
  });

  it("retires earlier requests when a later submission reaches the pty", () => {
    const tracker = new HandbackTracker(noScreen);
    tracker.registerDelivered("first0");
    const second = tracker.noteSubmission("second");
    second?.();

    expect(codes(tracker)).toEqual(["second"]);
  });

  it("retires earlier requests on a later submission that did not ask", () => {
    const tracker = new HandbackTracker(noScreen);
    tracker.registerDelivered("first0");
    const plain = tracker.noteSubmission();
    expect(plain).toBeDefined();
    plain?.();

    expect(tracker.hasRequests()).toBe(false);
  });

  it("does not retire a request queued after the submission that was written", () => {
    const tracker = new HandbackTracker(noScreen);
    const first = tracker.noteSubmission("first0");
    const second = tracker.noteSubmission("second");

    first?.();
    expect(codes(tracker)).toEqual(["first0"]);
    expect(tracker.hasRequests()).toBe(true);

    second?.();
    expect(codes(tracker)).toEqual(["second"]);
  });

  it("keeps a delivered request when a later submission never reaches the pty", () => {
    const tracker = new HandbackTracker(noScreen);
    tracker.noteSubmission("first0")?.();
    // Queued, then cancelled or failed: its callback never runs.
    tracker.noteSubmission("second");

    expect(codes(tracker)).toEqual(["first0"]);
  });

  it("treats a repeated pty_written as a no-op", () => {
    const tracker = new HandbackTracker(noScreen);
    const written = tracker.noteSubmission("aaaaaa");
    written?.();
    written?.();
    expect(codes(tracker)).toEqual(["aaaaaa"]);
  });

  it("retires one code on a hit and clears everything on demand", () => {
    const tracker = new HandbackTracker(noScreen);
    tracker.registerDelivered("aaaaaa");
    tracker.retire("aaaaaa");
    expect(tracker.hasRequests()).toBe(false);

    tracker.registerDelivered("bbbbbb");
    tracker.noteSubmission("cccccc");
    tracker.clear();
    expect(tracker.hasRequests()).toBe(false);
  });

  it("bounds the requests it holds, dropping the oldest", () => {
    const tracker = new HandbackTracker(noScreen);
    const written = Array.from({ length: MAX_HANDBACK_REQUESTS + 3 }, (_, i) =>
      tracker.noteSubmission(`code${String(i).padStart(2, "0")}`)
    );

    // The oldest three were dropped, so writing one delivers nothing.
    written[0]?.();
    expect(tracker.deliveredRequests()).toEqual([]);

    written[3]?.();
    expect(codes(tracker)).toEqual(["code03"]);
  });

  it("reads the rendered screen through the reader it was given", () => {
    const tracker = new HandbackTracker((rows) => {
      expect(rows).toBeGreaterThanOrEqual(200);
      return ["row one", "row two"];
    });
    expect(tracker.screenText()).toBe("row one\nrow two");
  });
});
